//! Pure launch-flow rules shared by `request_launch`, `refund_ticket` and
//! `create`. No account I/O, so every rule is unit-tested directly.

use anchor_lang::prelude::*;

use crate::error::ParabullError;
use crate::state::{metadata_commitment, normalize_name_hash, normalize_ticker, registry_locked, validate_uri, Ticker};

/// Derived, validated launch identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaunchMetadata {
    pub ticker: Ticker,
    pub name_hash: [u8; 32],
    pub metadata_hash: [u8; 32],
}

/// Validate user-supplied metadata. The symbol must already be canonical, so
/// the on-chain token symbol always equals the locked registry ticker.
pub fn validate_launch_metadata(name: &str, symbol: &str, uri: &str) -> Result<LaunchMetadata> {
    require!(name.trim() == name, ParabullError::NonCanonicalName);
    let name_hash = normalize_name_hash(name)?;
    let ticker = normalize_ticker(symbol)?;
    require!(ticker.as_seed() == symbol.as_bytes(), ParabullError::NonCanonicalSymbol);
    validate_uri(uri)?;
    Ok(LaunchMetadata { ticker, name_hash, metadata_hash: metadata_commitment(name, symbol, uri) })
}

pub fn ticket_expiry(now: i64, ttl_seconds: i64) -> Result<i64> {
    require!(ttl_seconds > 0, ParabullError::InvalidDuration);
    now.checked_add(ttl_seconds).ok_or_else(|| error!(ParabullError::Overflow))
}

/// Who may close a ticket back to its payer:
/// - the launch authority, any time (backend rejects a launch, e.g. the ticker is locked);
/// - the payer, once the ticket has expired unused.
/// Funds always return to the payer, never to the signer.
pub fn check_refund(signer: &Pubkey, payer: &Pubkey, launch_authority: &Pubkey, expires_at: i64, now: i64) -> Result<()> {
    if signer == launch_authority {
        return Ok(());
    }
    require_keys_eq!(*signer, *payer, ParabullError::Unauthorized);
    require!(now >= expires_at, ParabullError::TicketNotExpired);
    Ok(())
}

/// A ticket can be consumed only before it expires, so `create` never races a payer refund.
pub fn check_ticket_live(expires_at: i64, now: i64) -> Result<()> {
    require!(now < expires_at, ParabullError::TicketExpired);
    Ok(())
}

pub fn check_metadata_matches(name: &str, symbol: &str, uri: &str, committed: &[u8; 32]) -> Result<()> {
    require!(metadata_commitment(name, symbol, uri) == *committed, ParabullError::MetadataMismatch);
    Ok(())
}

/// How a consumed ticket's deposit is paid out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TicketSettlement {
    /// Protocol launch fee.
    pub to_treasury: u64,
    /// Reimburses the launch authority for rent + fees it paid in `create`.
    pub to_launch_authority: u64,
}

pub fn settle_ticket(deposit: u64, launch_fee: u64) -> Result<TicketSettlement> {
    let to_launch_authority = deposit.checked_sub(launch_fee).ok_or(ParabullError::LaunchFeeExceedsDeposit)?;
    Ok(TicketSettlement { to_treasury: launch_fee, to_launch_authority })
}

/// A registry PDA can be (re)claimed if it was just created (zeroed `mint`)
/// or its previous launch is outside the lock window.
pub fn registry_claimable(existing_mint: &Pubkey, launch_timestamp: i64, now: i64, lock_seconds: i64) -> bool {
    *existing_mint == Pubkey::default() || !registry_locked(launch_timestamp, now, lock_seconds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::*;

    const DAY: i64 = 24 * 60 * 60;
    const T0: i64 = 1_700_000_000;

    #[test]
    fn metadata_validation_accepts_canonical_input() {
        let m = validate_launch_metadata("Pepe The Frog", "PEPE", "https://x.y/meta.json").unwrap();
        assert_eq!(m.ticker.as_seed(), b"PEPE");
        assert_eq!(m.name_hash, normalize_name_hash("pepe the frog").unwrap());
        assert_eq!(m.metadata_hash, metadata_commitment("Pepe The Frog", "PEPE", "https://x.y/meta.json"));
    }

    #[test]
    fn metadata_validation_rejects_non_canonical_input() {
        let uri = "https://x.y/m.json";
        for symbol in ["pepe", "$PEPE", " PEPE", "PEPE ", "PE PE", "РЕРЕ", "", "ABCDEFGHIJK"] {
            assert!(validate_launch_metadata("Pepe", symbol, uri).is_err(), "symbol {symbol:?}");
        }
        for name in [" Pepe", "Pepe ", "", "   ", &"x".repeat(MAX_NAME_LEN + 1)] {
            assert!(validate_launch_metadata(name, "PEPE", uri).is_err(), "name {name:?}");
        }
        assert!(validate_launch_metadata("Pepe", "PEPE", &"u".repeat(MAX_URI_LEN + 1)).is_err());
        assert!(validate_launch_metadata("Pepe", "PEPE", "").is_ok(), "empty URI is allowed");
    }

    #[test]
    fn ticket_expiry_window() {
        let exp = ticket_expiry(T0, DEFAULT_TICKET_TTL_SECONDS).unwrap();
        assert_eq!(exp, T0 + 600);
        assert!(ticket_expiry(T0, 0).is_err());
        assert!(ticket_expiry(i64::MAX, 1).is_err());

        // Live strictly before expiry, expired at and after it.
        assert!(check_ticket_live(exp, T0).is_ok());
        assert!(check_ticket_live(exp, exp - 1).is_ok());
        assert!(check_ticket_live(exp, exp).is_err());
        assert!(check_ticket_live(exp, exp + 1).is_err());
    }

    #[test]
    fn refund_rules() {
        let payer = Pubkey::new_unique();
        let launch = Pubkey::new_unique();
        let stranger = Pubkey::new_unique();
        let exp = T0 + 600;

        // Payer: only after expiry.
        assert!(check_refund(&payer, &payer, &launch, exp, exp - 1).is_err());
        assert!(check_refund(&payer, &payer, &launch, exp, exp).is_ok());
        // Launch authority: any time.
        assert!(check_refund(&launch, &payer, &launch, exp, T0).is_ok());
        // Anyone else: never.
        assert!(check_refund(&stranger, &payer, &launch, exp, exp + DAY).is_err());
        // Live and refundable windows never overlap for the payer.
        for now in [exp - 1, exp, exp + 1] {
            assert_ne!(check_ticket_live(exp, now).is_ok(), check_refund(&payer, &payer, &launch, exp, now).is_ok());
        }
    }

    #[test]
    fn metadata_commitment_must_match() {
        let h = metadata_commitment("Pepe", "PEPE", "u");
        assert!(check_metadata_matches("Pepe", "PEPE", "u", &h).is_ok());
        assert!(check_metadata_matches("Pepe", "PEPE", "u2", &h).is_err());
        assert!(check_metadata_matches("Pepe2", "PEPE", "u", &h).is_err());
        assert!(check_metadata_matches("Pepe", "PEPE2", "u", &h).is_err());
    }

    #[test]
    fn ticket_settlement() {
        let s = settle_ticket(DEFAULT_TICKET_DEPOSIT_LAMPORTS, DEFAULT_LAUNCH_FEE_LAMPORTS).unwrap();
        assert_eq!(s, TicketSettlement { to_treasury: 200_000_000, to_launch_authority: 30_000_000 });
        assert_eq!(settle_ticket(5, 5).unwrap().to_launch_authority, 0);
        assert!(settle_ticket(5, 6).is_err());
    }

    #[test]
    fn registry_claim_rules() {
        let lock = DEFAULT_REGISTRY_LOCK_SECONDS;
        let mint = Pubkey::new_unique();
        // Fresh PDA.
        assert!(registry_claimable(&Pubkey::default(), 0, T0, lock));
        // Existing launch inside the 3-day window.
        assert!(!registry_claimable(&mint, T0, T0, lock));
        assert!(!registry_claimable(&mint, T0, T0 + 3 * DAY - 1, lock));
        // Lock elapsed: re-claimable.
        assert!(registry_claimable(&mint, T0, T0 + 3 * DAY, lock));
        // Lock disabled.
        assert!(registry_claimable(&mint, T0, T0, 0));
    }

    #[test]
    fn lookalike_tickers_and_names_hit_the_same_registry_entry() {
        let a = validate_launch_metadata("Pepe  Coin", "PEPE", "").unwrap();
        let b = validate_launch_metadata("PEPE COIN", "PEPE", "ipfs://other").unwrap();
        assert_eq!(a.ticker, b.ticker);
        assert_eq!(a.name_hash, b.name_hash);
        assert_ne!(a.metadata_hash, b.metadata_hash);
    }
}

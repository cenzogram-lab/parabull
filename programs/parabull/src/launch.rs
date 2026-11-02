//! Pure launch-flow rules shared by `request_launch`, `refund_ticket` and
//! `create`. No account I/O, so every rule is unit-tested directly.

use anchor_lang::prelude::*;

use anchor_lang::solana_program::hash::hashv;

use crate::constants::TWEET_HASH_DOMAIN;
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

/// Canonical lock key for an announcement tweet:
/// `sha256("parabull:tweet" || status_id as u64 LE)`. The numeric status ID is
/// the same for every URL form (x.com / twitter.com / mobile / query params),
/// so a copycat can't get a fresh lock by re-spelling the link.
pub fn tweet_id_hash(tweet_id: u64) -> Result<[u8; 32]> {
    require!(tweet_id != 0, ParabullError::InvalidTweetId);
    Ok(hashv(&[TWEET_HASH_DOMAIN, &tweet_id.to_le_bytes()]).to_bytes())
}

/// The tweet registry account must be supplied exactly when the ticket has a tweet.
pub fn check_tweet_registry_presence(ticket_has_tweet: bool, registry_passed: bool) -> Result<()> {
    require!(ticket_has_tweet == registry_passed, ParabullError::TweetRegistryMismatch);
    Ok(())
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

/// How a consumed ticket's lamports are paid out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TicketSettlement {
    /// Exactly the rent the launch authority fronted in `create`, capped at
    /// what the ticket holds beyond the launch fee.
    pub to_launch_authority: u64,
    /// Everything else: the launch fee plus any unspent operational allocation.
    pub to_treasury: u64,
}

/// `ticket_lamports` is everything the ticket holds (the flat deposit,
/// including the ticket's own rent).
pub fn settle_ticket(ticket_lamports: u64, launch_fee: u64, rent_fronted: u64) -> Result<TicketSettlement> {
    let allocation = ticket_lamports.checked_sub(launch_fee).ok_or(ParabullError::LaunchFeeExceedsDeposit)?;
    let to_launch_authority = rent_fronted.min(allocation);
    Ok(TicketSettlement { to_launch_authority, to_treasury: ticket_lamports - to_launch_authority })
}

/// Lamports the user moves on top of the ticket's own rent so the ticket
/// holds exactly `deposit` in total.
pub fn deposit_top_up(deposit: u64, ticket_rent: u64) -> Result<u64> {
    deposit.checked_sub(ticket_rent).ok_or_else(|| error!(ParabullError::TicketDepositTooLow))
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
    fn ticket_settlement_reimburses_rent_and_sends_the_rest_to_treasury() {
        // 0.230 SOL ticket, 0.2 fee, ~0.0125 SOL of rent fronted.
        let s = settle_ticket(DEFAULT_TICKET_DEPOSIT_LAMPORTS, DEFAULT_LAUNCH_FEE_LAMPORTS, 12_500_000).unwrap();
        assert_eq!(s, TicketSettlement { to_launch_authority: 12_500_000, to_treasury: 217_500_000 });
        assert_eq!(s.to_launch_authority + s.to_treasury, DEFAULT_TICKET_DEPOSIT_LAMPORTS, "nothing left over");
        // Reimbursement never eats into the launch fee.
        let s = settle_ticket(DEFAULT_TICKET_DEPOSIT_LAMPORTS, DEFAULT_LAUNCH_FEE_LAMPORTS, 99_000_000).unwrap();
        assert_eq!(s, TicketSettlement { to_launch_authority: 30_000_000, to_treasury: 200_000_000 });
        assert_eq!(settle_ticket(5, 5, 1).unwrap(), TicketSettlement { to_launch_authority: 0, to_treasury: 5 });
        assert!(settle_ticket(5, 6, 0).is_err());
    }

    #[test]
    fn flat_deposit_includes_ticket_rent() {
        assert_eq!(deposit_top_up(230_000_000, 2_429_040).unwrap(), 227_570_960);
        assert!(deposit_top_up(1_000, 2_429_040).is_err());
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

    const TWEET_VECTOR_HEX: &str = "f756d823a024b7f7f6c87021678d1835720f0fba261f26d8bfdf5a0f31925206";

    /// Pinned in scripts/src/launch.test.ts too (computed independently in Python).
    #[test]
    fn tweet_hash_is_canonical_and_pinned() {
        let h = tweet_id_hash(1_850_000_000_000_000_000).unwrap();
        let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, TWEET_VECTOR_HEX);
        assert_ne!(h, tweet_id_hash(1_850_000_000_000_000_001).unwrap());
        assert!(tweet_id_hash(0).is_err());
    }

    #[test]
    fn tweet_registry_presence_must_match_ticket() {
        assert!(check_tweet_registry_presence(true, true).is_ok());
        assert!(check_tweet_registry_presence(false, false).is_ok());
        assert!(check_tweet_registry_presence(true, false).is_err(), "tweet on ticket but no registry");
        assert!(check_tweet_registry_presence(false, true).is_err(), "registry without a tweet");
    }

    #[test]
    fn tweet_lock_window_matches_ticker_lock() {
        let lock = DEFAULT_REGISTRY_LOCK_SECONDS;
        assert_eq!(lock, 259_200);
        let mint = Pubkey::new_unique();
        assert!(!registry_claimable(&mint, T0, T0 + lock - 1, lock));
        assert!(registry_claimable(&mint, T0, T0 + lock, lock));
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

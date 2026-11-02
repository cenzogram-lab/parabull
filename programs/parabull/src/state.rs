//! On-chain account layouts.
//!
//! Every account carries a trailing `_reserved` block so fields can be added
//! in later upgrades without a realloc/migration of existing accounts.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

use crate::constants::*;
use crate::error::ParabullError;
use crate::math::{self, FeeSplit, Reserves};

// ---------------------------------------------------------------------------
// Global
// ---------------------------------------------------------------------------

/// Singleton config. PDA: `["global"]`.
#[account]
#[derive(InitSpace, Debug)]
pub struct Global {
    pub bump: u8,
    pub paused: bool,
    /// Config + emergency authority.
    pub admin: Pubkey,
    /// Backend signer that must co-sign every `create` (blind launch).
    pub launch_authority: Pubkey,
    /// Backend signer for migrate / escrow release / buyback / holder epochs.
    pub crank_authority: Pubkey,
    /// Receives launch fees, released DexScreener escrow and treasury fees.
    pub treasury: Pubkey,
    /// Native $PARABULL mint (buyback target, holder-reward eligibility).
    pub parabull_mint: Pubkey,

    /// Protocol launch fee carved out of each ticket (0.2 SOL).
    pub launch_fee_lamports: u64,
    /// Total a user deposits into a `LaunchTicket` (~0.23 SOL).
    pub ticket_deposit_lamports: u64,
    /// After this many seconds an unconsumed ticket is refundable.
    pub ticket_ttl_seconds: i64,

    /// Platform trading fee, hard-capped at `MAX_PLATFORM_FEE_BPS` (1%).
    pub platform_fee_bps: u16,
    /// Post-escrow split of the platform fee; remainder goes to treasury.
    pub buyback_bps: u16,
    pub holder_bps: u16,
    /// DexScreener listing target in lamports (admin-updated from SOL/USD).
    pub dex_target_lamports: u64,
    pub dex_target_updated_at: i64,

    /// Slots between creation and the first allowed trade (anti block-zero).
    pub trading_open_delay_slots: u64,
    /// Ticker/name lock window (3 days).
    pub registry_lock_seconds: i64,

    pub initial_virtual_token_reserves: u64,
    pub initial_virtual_sol_reserves: u64,
    pub initial_real_token_reserves: u64,
    pub token_total_supply: u64,

    pub launch_count: u64,
    pub _reserved: [u8; 128],
}

/// Admin-settable parameters, validated as a unit.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct GlobalParams {
    pub launch_authority: Pubkey,
    pub crank_authority: Pubkey,
    pub treasury: Pubkey,
    pub parabull_mint: Pubkey,
    pub launch_fee_lamports: u64,
    pub ticket_deposit_lamports: u64,
    pub ticket_ttl_seconds: i64,
    pub platform_fee_bps: u16,
    pub buyback_bps: u16,
    pub holder_bps: u16,
    pub dex_target_lamports: u64,
    pub trading_open_delay_slots: u64,
    pub registry_lock_seconds: i64,
    pub initial_virtual_token_reserves: u64,
    pub initial_virtual_sol_reserves: u64,
    pub initial_real_token_reserves: u64,
    pub token_total_supply: u64,
}

impl GlobalParams {
    pub fn validate(&self) -> Result<()> {
        for key in [&self.launch_authority, &self.crank_authority, &self.treasury, &self.parabull_mint] {
            require_keys_neq!(*key, Pubkey::default(), ParabullError::InvalidAuthority);
        }
        require!(self.platform_fee_bps <= MAX_PLATFORM_FEE_BPS, ParabullError::PlatformFeeTooHigh);
        require!(
            u64::from(self.buyback_bps) + u64::from(self.holder_bps) <= BPS_DENOMINATOR,
            ParabullError::FeeSplitOutOfRange
        );
        let min_deposit = self
            .launch_fee_lamports
            .checked_add(MIN_LAUNCH_RENT_BUFFER_LAMPORTS)
            .ok_or(ParabullError::Overflow)?;
        require!(self.ticket_deposit_lamports >= min_deposit, ParabullError::TicketDepositTooLow);
        require!(self.ticket_ttl_seconds > 0, ParabullError::InvalidDuration);
        require!(self.registry_lock_seconds >= 0, ParabullError::InvalidDuration);
        require!(
            self.initial_virtual_sol_reserves > 0
                && self.initial_real_token_reserves > 0
                && self.initial_real_token_reserves < self.initial_virtual_token_reserves
                && self.initial_real_token_reserves <= self.token_total_supply,
            ParabullError::InvalidCurveParams
        );
        Ok(())
    }
}

impl Global {
    pub fn apply_params(&mut self, p: &GlobalParams, now: i64) -> Result<()> {
        p.validate()?;
        self.launch_authority = p.launch_authority;
        self.crank_authority = p.crank_authority;
        self.treasury = p.treasury;
        self.parabull_mint = p.parabull_mint;
        self.launch_fee_lamports = p.launch_fee_lamports;
        self.ticket_deposit_lamports = p.ticket_deposit_lamports;
        self.ticket_ttl_seconds = p.ticket_ttl_seconds;
        self.platform_fee_bps = p.platform_fee_bps;
        self.buyback_bps = p.buyback_bps;
        self.holder_bps = p.holder_bps;
        self.dex_target_lamports = p.dex_target_lamports;
        self.dex_target_updated_at = now;
        self.trading_open_delay_slots = p.trading_open_delay_slots;
        self.registry_lock_seconds = p.registry_lock_seconds;
        self.initial_virtual_token_reserves = p.initial_virtual_token_reserves;
        self.initial_virtual_sol_reserves = p.initial_virtual_sol_reserves;
        self.initial_real_token_reserves = p.initial_real_token_reserves;
        self.token_total_supply = p.token_total_supply;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Bonding curve
// ---------------------------------------------------------------------------

/// Per-token curve. PDA: `["bonding-curve", mint]`.
///
/// Lamport invariant: `lamports >= rent_exempt_min + real_sol_reserves + accrued_fees()`.
/// Fees are tallied here (not pushed to shared vaults) so trades on different
/// tokens never write-lock a common account.
#[account]
#[derive(InitSpace, Debug)]
pub struct BondingCurve {
    pub bump: u8,
    /// Real token reserves hit zero; trading stops, awaiting migration.
    pub complete: bool,
    /// Liquidity seeded into Raydium CPMM and LP locked.
    pub migrated: bool,
    /// DexScreener escrow paid out; later fees skip Stage 1.
    pub escrow_released: bool,
    pub mint: Pubkey,
    /// Wallet that paid the launch ticket. Earns 0% of trading fees.
    pub creator: Pubkey,

    pub virtual_token_reserves: u64,
    pub virtual_sol_reserves: u64,
    pub real_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub token_total_supply: u64,

    pub created_slot: u64,
    /// No buy/sell before this slot.
    pub trading_open_slot: u64,
    pub launch_timestamp: i64,

    /// Fee buckets (lamports held in this account until swept).
    pub escrow_accrued: u64,
    pub buyback_accrued: u64,
    pub holder_accrued: u64,
    pub treasury_accrued: u64,

    pub _reserved: [u8; 64],
}

impl BondingCurve {
    pub fn reserves(&self) -> Reserves {
        Reserves {
            virtual_token: self.virtual_token_reserves,
            virtual_sol: self.virtual_sol_reserves,
            real_token: self.real_token_reserves,
            real_sol: self.real_sol_reserves,
        }
    }

    fn store_reserves(&mut self, r: Reserves) {
        self.virtual_token_reserves = r.virtual_token;
        self.virtual_sol_reserves = r.virtual_sol;
        self.real_token_reserves = r.real_token;
        self.real_sol_reserves = r.real_sol;
    }

    /// Initialise a fresh curve from global params at creation time.
    pub fn init(&mut self, bump: u8, mint: Pubkey, creator: Pubkey, global: &Global, slot: u64, now: i64) -> Result<()> {
        self.bump = bump;
        self.complete = false;
        self.migrated = false;
        self.escrow_released = false;
        self.mint = mint;
        self.creator = creator;
        self.virtual_token_reserves = global.initial_virtual_token_reserves;
        self.virtual_sol_reserves = global.initial_virtual_sol_reserves;
        self.real_token_reserves = global.initial_real_token_reserves;
        self.real_sol_reserves = 0;
        self.token_total_supply = global.token_total_supply;
        self.created_slot = slot;
        self.trading_open_slot = slot.checked_add(global.trading_open_delay_slots).ok_or(ParabullError::Overflow)?;
        self.launch_timestamp = now;
        self.escrow_accrued = 0;
        self.buyback_accrued = 0;
        self.holder_accrued = 0;
        self.treasury_accrued = 0;
        Ok(())
    }

    pub fn is_trading_open(&self, slot: u64) -> bool {
        !self.complete && slot >= self.trading_open_slot
    }

    pub fn apply_buy(&mut self, tokens_out: u64, sol_in: u64) -> Result<()> {
        let mut r = self.reserves();
        r.apply_buy(tokens_out, sol_in)?;
        self.store_reserves(r);
        if self.real_token_reserves == 0 {
            self.complete = true;
        }
        Ok(())
    }

    pub fn apply_sell(&mut self, tokens_in: u64, sol_out: u64) -> Result<()> {
        let mut r = self.reserves();
        r.apply_sell(tokens_in, sol_out)?;
        self.store_reserves(r);
        Ok(())
    }

    /// Route one trade's platform fee into the flywheel buckets.
    pub fn accrue_platform_fee(&mut self, global: &Global, fee: u64) -> Result<FeeSplit> {
        let split = math::split_platform_fee(
            fee,
            self.escrow_accrued,
            global.dex_target_lamports,
            !self.escrow_released,
            global.buyback_bps,
            global.holder_bps,
        )?;
        self.escrow_accrued = self.escrow_accrued.checked_add(split.escrow).ok_or(ParabullError::Overflow)?;
        self.buyback_accrued = self.buyback_accrued.checked_add(split.buyback).ok_or(ParabullError::Overflow)?;
        self.holder_accrued = self.holder_accrued.checked_add(split.holder).ok_or(ParabullError::Overflow)?;
        self.treasury_accrued = self.treasury_accrued.checked_add(split.treasury).ok_or(ParabullError::Overflow)?;
        Ok(split)
    }

    pub fn is_escrow_funded(&self, global: &Global) -> bool {
        self.escrow_accrued >= global.dex_target_lamports
    }

    /// Lamports owed to fee buckets (excluded from tradeable reserves).
    pub fn accrued_fees(&self) -> Result<u64> {
        self.escrow_accrued
            .checked_add(self.buyback_accrued)
            .and_then(|v| v.checked_add(self.holder_accrued))
            .and_then(|v| v.checked_add(self.treasury_accrued))
            .ok_or_else(|| error!(ParabullError::Overflow))
    }
}

// ---------------------------------------------------------------------------
// Launch ticket (blind launch payment)
// ---------------------------------------------------------------------------

/// User-funded launch request. PDA: `["ticket", payer, nonce_le]`.
///
/// The payer commits to the exact metadata; the backend can only consume the
/// ticket with matching metadata, or the payer refunds after `expires_at`.
#[account]
#[derive(InitSpace, Debug)]
pub struct LaunchTicket {
    pub bump: u8,
    pub payer: Pubkey,
    pub nonce: u64,
    /// Total lamports deposited on top of the ticket's own rent.
    pub deposit_lamports: u64,
    /// Protocol fee quoted at request time; the rest of the deposit covers
    /// rent + fees paid by the launch authority during `create`.
    pub launch_fee_lamports: u64,
    pub created_at: i64,
    pub expires_at: i64,
    pub ticker: [u8; MAX_TICKER_LEN],
    pub ticker_len: u8,
    pub name_hash: [u8; 32],
    /// `metadata_commitment(name, symbol, uri)`.
    pub metadata_hash: [u8; 32],
    pub _reserved: [u8; 24],
}

impl LaunchTicket {
    pub fn ticker(&self) -> &[u8] {
        &self.ticker[..usize::from(self.ticker_len)]
    }

    pub fn is_expired(&self, now: i64) -> bool {
        now >= self.expires_at
    }
}

/// Length-prefixed sha256 over (name, symbol, uri) so field boundaries are unambiguous.
pub fn metadata_commitment(name: &str, symbol: &str, uri: &str) -> [u8; 32] {
    let (n, s, u) = (name.as_bytes(), symbol.as_bytes(), uri.as_bytes());
    hashv(&[
        &(n.len() as u32).to_le_bytes(),
        n,
        &(s.len() as u32).to_le_bytes(),
        s,
        &(u.len() as u32).to_le_bytes(),
        u,
    ])
    .to_bytes()
}

// ---------------------------------------------------------------------------
// Anti-vamp registries
// ---------------------------------------------------------------------------

/// Ticker lock. PDA: `["registry", normalized_ticker]`.
#[account]
#[derive(InitSpace, Debug)]
pub struct TickerRegistry {
    pub bump: u8,
    pub ticker: [u8; MAX_TICKER_LEN],
    pub ticker_len: u8,
    pub mint: Pubkey,
    pub launch_timestamp: i64,
}

/// Name lock. PDA: `["name", sha256(normalized_name)]`.
#[account]
#[derive(InitSpace, Debug)]
pub struct NameRegistry {
    pub bump: u8,
    pub name_hash: [u8; 32],
    pub mint: Pubkey,
    pub launch_timestamp: i64,
}

/// A registry entry blocks re-use while `now < launch_timestamp + lock_seconds`.
pub fn registry_locked(launch_timestamp: i64, now: i64, lock_seconds: i64) -> bool {
    now < launch_timestamp.saturating_add(lock_seconds)
}

impl TickerRegistry {
    pub fn is_locked(&self, now: i64, lock_seconds: i64) -> bool {
        registry_locked(self.launch_timestamp, now, lock_seconds)
    }
}

impl NameRegistry {
    pub fn is_locked(&self, now: i64, lock_seconds: i64) -> bool {
        registry_locked(self.launch_timestamp, now, lock_seconds)
    }
}

/// Normalised ticker: fixed buffer + length, usable directly as a PDA seed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ticker {
    pub bytes: [u8; MAX_TICKER_LEN],
    pub len: u8,
}

impl Ticker {
    pub fn as_seed(&self) -> &[u8] {
        &self.bytes[..usize::from(self.len)]
    }
}

/// Trim, drop one leading `$`, uppercase. ASCII letters/digits only, which also
/// rules out Unicode homoglyph clones (e.g. Cyrillic "РЕРЕ").
pub fn normalize_ticker(input: &str) -> Result<Ticker> {
    let s = input.trim();
    let s = s.strip_prefix('$').unwrap_or(s);
    require!(
        !s.is_empty() && s.len() <= MAX_TICKER_LEN && s.bytes().all(|b| b.is_ascii_alphanumeric()),
        ParabullError::InvalidTicker
    );
    let mut bytes = [0u8; MAX_TICKER_LEN];
    for (dst, src) in bytes.iter_mut().zip(s.bytes()) {
        *dst = src.to_ascii_uppercase();
    }
    Ok(Ticker { bytes, len: s.len() as u8 })
}

/// sha256 of the name after trimming, collapsing whitespace runs to one space
/// and lowercasing ASCII. Fuzzy/lookalike matching is the indexer's job.
pub fn normalize_name_hash(input: &str) -> Result<[u8; 32]> {
    let raw = input.trim();
    require!(!raw.is_empty() && raw.len() <= MAX_NAME_LEN, ParabullError::InvalidName);
    let mut norm = Vec::with_capacity(raw.len());
    let mut prev_space = false;
    for b in raw.bytes() {
        if b.is_ascii_whitespace() {
            if !prev_space {
                norm.push(b' ');
            }
            prev_space = true;
        } else {
            norm.push(b.to_ascii_lowercase());
            prev_space = false;
        }
    }
    Ok(hashv(&[&norm]).to_bytes())
}

pub fn validate_uri(uri: &str) -> Result<()> {
    require!(uri.len() <= MAX_URI_LEN, ParabullError::InvalidUri);
    Ok(())
}

// ---------------------------------------------------------------------------
// Flywheel vaults
// ---------------------------------------------------------------------------

/// Program-owned SOL for $PARABULL buyback & burn. PDA: `["buyback-vault"]`.
/// SOL is held as this account's lamports above rent.
#[account]
#[derive(InitSpace, Debug)]
pub struct BuybackVault {
    pub bump: u8,
    pub total_deposited_lamports: u64,
    pub total_spent_lamports: u64,
    pub total_tokens_burned: u64,
    pub buyback_count: u64,
    pub last_buyback_at: i64,
    pub _reserved: [u8; 64],
}

/// Program-owned SOL for $PARABULL holder rewards. PDA: `["holder-vault"]`.
#[account]
#[derive(InitSpace, Debug)]
pub struct HolderRewardVault {
    pub bump: u8,
    pub total_deposited_lamports: u64,
    /// Lamports committed to published epochs (claimable or claimed).
    pub total_committed_lamports: u64,
    pub total_claimed_lamports: u64,
    /// Next epoch index to publish.
    pub next_epoch: u64,
    pub _reserved: [u8; 64],
}

impl HolderRewardVault {
    /// Lamports deposited but not yet assigned to an epoch.
    pub fn uncommitted(&self) -> Result<u64> {
        self.total_deposited_lamports
            .checked_sub(self.total_committed_lamports)
            .ok_or_else(|| error!(ParabullError::Overflow))
    }
}

/// One holder-reward distribution (off-chain snapshot of $PARABULL holders,
/// claimed against a Merkle root). PDA: `["reward-epoch", epoch_le]`.
#[account]
#[derive(InitSpace, Debug)]
pub struct RewardEpoch {
    pub bump: u8,
    pub epoch: u64,
    pub merkle_root: [u8; 32],
    pub snapshot_slot: u64,
    pub total_lamports: u64,
    pub claimed_lamports: u64,
    pub published_at: i64,
    pub _reserved: [u8; 32],
}

#[cfg(test)]
mod tests {
    use super::*;

    fn global() -> Global {
        Global {
            bump: 255,
            paused: false,
            admin: Pubkey::new_unique(),
            launch_authority: Pubkey::new_unique(),
            crank_authority: Pubkey::new_unique(),
            treasury: Pubkey::new_unique(),
            parabull_mint: Pubkey::new_unique(),
            launch_fee_lamports: DEFAULT_LAUNCH_FEE_LAMPORTS,
            ticket_deposit_lamports: DEFAULT_TICKET_DEPOSIT_LAMPORTS,
            ticket_ttl_seconds: DEFAULT_TICKET_TTL_SECONDS,
            platform_fee_bps: DEFAULT_PLATFORM_FEE_BPS,
            buyback_bps: 5_000,
            holder_bps: 4_000,
            dex_target_lamports: 2_000_000_000,
            dex_target_updated_at: 0,
            trading_open_delay_slots: DEFAULT_TRADING_OPEN_DELAY_SLOTS,
            registry_lock_seconds: DEFAULT_REGISTRY_LOCK_SECONDS,
            initial_virtual_token_reserves: DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
            initial_virtual_sol_reserves: DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES,
            initial_real_token_reserves: DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
            token_total_supply: DEFAULT_TOKEN_TOTAL_SUPPLY,
            launch_count: 0,
            _reserved: [0; 128],
        }
    }

    fn params(g: &Global) -> GlobalParams {
        GlobalParams {
            launch_authority: g.launch_authority,
            crank_authority: g.crank_authority,
            treasury: g.treasury,
            parabull_mint: g.parabull_mint,
            launch_fee_lamports: g.launch_fee_lamports,
            ticket_deposit_lamports: g.ticket_deposit_lamports,
            ticket_ttl_seconds: g.ticket_ttl_seconds,
            platform_fee_bps: g.platform_fee_bps,
            buyback_bps: g.buyback_bps,
            holder_bps: g.holder_bps,
            dex_target_lamports: g.dex_target_lamports,
            trading_open_delay_slots: g.trading_open_delay_slots,
            registry_lock_seconds: g.registry_lock_seconds,
            initial_virtual_token_reserves: g.initial_virtual_token_reserves,
            initial_virtual_sol_reserves: g.initial_virtual_sol_reserves,
            initial_real_token_reserves: g.initial_real_token_reserves,
            token_total_supply: g.token_total_supply,
        }
    }

    fn curve(g: &Global) -> BondingCurve {
        let mut c = BondingCurve {
            bump: 0,
            complete: false,
            migrated: false,
            escrow_released: false,
            mint: Pubkey::default(),
            creator: Pubkey::default(),
            virtual_token_reserves: 0,
            virtual_sol_reserves: 0,
            real_token_reserves: 0,
            real_sol_reserves: 0,
            token_total_supply: 0,
            created_slot: 0,
            trading_open_slot: 0,
            launch_timestamp: 0,
            escrow_accrued: 0,
            buyback_accrued: 0,
            holder_accrued: 0,
            treasury_accrued: 0,
            _reserved: [0; 64],
        };
        c.init(254, Pubkey::new_unique(), Pubkey::new_unique(), g, 1_000, 1_700_000_000).unwrap();
        c
    }

    #[test]
    fn default_params_validate() {
        params(&global()).validate().unwrap();
    }

    #[test]
    fn params_reject_bad_values() {
        let g = global();
        let mut p = params(&g);
        p.platform_fee_bps = MAX_PLATFORM_FEE_BPS + 1;
        assert!(p.validate().is_err());

        let mut p = params(&g);
        p.buyback_bps = 6_000;
        p.holder_bps = 4_001;
        assert!(p.validate().is_err());

        let mut p = params(&g);
        p.ticket_deposit_lamports = p.launch_fee_lamports + MIN_LAUNCH_RENT_BUFFER_LAMPORTS - 1;
        assert!(p.validate().is_err());

        let mut p = params(&g);
        p.treasury = Pubkey::default();
        assert!(p.validate().is_err());

        let mut p = params(&g);
        p.initial_real_token_reserves = p.initial_virtual_token_reserves;
        assert!(p.validate().is_err());
    }

    #[test]
    fn curve_init_sets_trading_delay() {
        let g = global();
        let c = curve(&g);
        assert_eq!(c.trading_open_slot, 1_000 + DEFAULT_TRADING_OPEN_DELAY_SLOTS);
        assert!(!c.is_trading_open(1_000), "no trades in the creation slot");
        assert!(!c.is_trading_open(1_001));
        assert!(c.is_trading_open(1_002));
    }

    #[test]
    fn draining_curve_marks_complete_and_stops_trading() {
        let g = global();
        let mut c = curve(&g);
        let tokens = c.real_token_reserves;
        let cost = math::buy_cost(&c.reserves(), tokens).unwrap();
        c.apply_buy(tokens, cost).unwrap();
        assert!(c.complete);
        assert!(!c.is_trading_open(u64::MAX));
    }

    #[test]
    fn fee_accrual_fills_escrow_then_flywheel() {
        let g = global();
        let mut c = curve(&g);
        // 1.5 SOL of fees: all escrow (target 2 SOL).
        c.accrue_platform_fee(&g, 1_500_000_000).unwrap();
        assert_eq!(c.escrow_accrued, 1_500_000_000);
        assert!(!c.is_escrow_funded(&g));
        // 1 SOL more: 0.5 tops up escrow, 0.5 splits 50/40/10.
        let s = c.accrue_platform_fee(&g, 1_000_000_000).unwrap();
        assert_eq!(s, FeeSplit { escrow: 500_000_000, buyback: 250_000_000, holder: 200_000_000, treasury: 50_000_000 });
        assert!(c.is_escrow_funded(&g));
        assert_eq!(c.accrued_fees().unwrap(), 2_500_000_000);
        // After release, nothing goes to escrow even if the target is raised.
        c.escrow_released = true;
        let mut g2 = global();
        g2.dex_target_lamports = u64::MAX;
        let s = c.accrue_platform_fee(&g2, 100).unwrap();
        assert_eq!(s.escrow, 0);
    }

    #[test]
    fn ticker_normalisation() {
        let t = normalize_ticker("  $pepe ").unwrap();
        assert_eq!(t.as_seed(), b"PEPE");
        assert_eq!(normalize_ticker("Pepe2").unwrap().as_seed(), b"PEPE2");
        assert_eq!(normalize_ticker("ABCDEFGHIJ").unwrap().len, 10);
        for bad in ["", "$", "ABCDEFGHIJK", "PE PE", "PE-PE", "РЕРЕ", "$$PEPE", "PEPÉ"] {
            assert!(normalize_ticker(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn name_normalisation_collapses_case_and_whitespace() {
        let a = normalize_name_hash("Pepe  The\tFrog").unwrap();
        let b = normalize_name_hash(" pepe the frog ").unwrap();
        assert_eq!(a, b);
        assert_ne!(a, normalize_name_hash("pepe the frogs").unwrap());
        assert!(normalize_name_hash("   ").is_err());
        assert!(normalize_name_hash(&"x".repeat(MAX_NAME_LEN + 1)).is_err());
    }

    #[test]
    fn registry_lock_window() {
        let day = 24 * 60 * 60;
        let t0 = 1_700_000_000;
        assert!(registry_locked(t0, t0, 3 * day));
        assert!(registry_locked(t0, t0 + 3 * day - 1, 3 * day));
        assert!(!registry_locked(t0, t0 + 3 * day, 3 * day));
        assert!(registry_locked(i64::MAX - 1, i64::MAX - 1, 3 * day), "saturates, never wraps");
    }

    #[test]
    fn metadata_commitment_is_boundary_safe() {
        assert_ne!(metadata_commitment("ab", "c", "u"), metadata_commitment("a", "bc", "u"));
        assert_eq!(metadata_commitment("a", "b", "c"), metadata_commitment("a", "b", "c"));
    }

    #[test]
    fn account_sizes_fit_and_are_stable() {
        // 8-byte discriminator + INIT_SPACE. Pinned so layout changes are deliberate.
        assert_eq!(8 + Global::INIT_SPACE, 400);
        assert_eq!(8 + BondingCurve::INIT_SPACE, 236);
        assert_eq!(8 + LaunchTicket::INIT_SPACE, 180);
        assert_eq!(8 + TickerRegistry::INIT_SPACE, 60);
        assert_eq!(8 + NameRegistry::INIT_SPACE, 81);
        assert_eq!(8 + BuybackVault::INIT_SPACE, 113);
        assert_eq!(8 + HolderRewardVault::INIT_SPACE, 105);
        assert_eq!(8 + RewardEpoch::INIT_SPACE, 113);
    }
}

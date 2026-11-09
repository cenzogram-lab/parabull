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

    /// Raydium CPMM program (mainnet `CPMMoo8L…`), configurable per cluster.
    pub cpmm_program: Pubkey,
    /// CPMM `AmmConfig` (fee tier) new pools are created under.
    pub cpmm_amm_config: Pubkey,
    /// Raydium Burn & Earn LP-lock program and its authority.
    pub lp_lock_program: Pubkey,
    pub lp_lock_authority: Pubkey,
    /// SOL held back from the pool to pay Raydium fees and rent.
    pub migration_reserve_lamports: u64,
    /// Two-step admin transfer: set by `propose_admin`, cleared by `accept_admin`.
    pub pending_admin: Pubkey,
    /// Raydium CPMM WSOL/$PARABULL pool used by `buyback_and_burn`
    /// (`Pubkey::default()` until the pool exists).
    pub parabull_pool: Pubkey,
    /// Claim window copied into each reward epoch at publish time.
    pub reward_claim_window_seconds: i64,
    pub _reserved: [u8; 24],
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
    pub cpmm_program: Pubkey,
    pub cpmm_amm_config: Pubkey,
    pub lp_lock_program: Pubkey,
    pub lp_lock_authority: Pubkey,
    pub migration_reserve_lamports: u64,
    /// May be default at initialize; required only by `buyback_and_burn`.
    pub parabull_pool: Pubkey,
    pub reward_claim_window_seconds: i64,
}

impl GlobalParams {
    pub fn validate(&self) -> Result<()> {
        for key in [
            &self.launch_authority,
            &self.crank_authority,
            &self.treasury,
            &self.parabull_mint,
            &self.cpmm_program,
            &self.cpmm_amm_config,
            &self.lp_lock_program,
            &self.lp_lock_authority,
        ] {
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
        require!(self.migration_reserve_lamports > 0, ParabullError::InvalidMigrationParams);
        require!(self.reward_claim_window_seconds >= MIN_REWARD_CLAIM_WINDOW_SECONDS, ParabullError::InvalidDuration);
        require!(
            (MIN_TRADING_OPEN_DELAY_SLOTS..=MAX_TRADING_OPEN_DELAY_SLOTS).contains(&self.trading_open_delay_slots),
            ParabullError::TradingDelayOutOfRange
        );
        require!(self.dex_target_lamports <= MAX_DEX_TARGET_LAMPORTS, ParabullError::DexTargetTooHigh);
        require!(
            self.initial_virtual_sol_reserves > 0
                && self.initial_real_token_reserves > 0
                && self.initial_real_token_reserves < self.initial_virtual_token_reserves
                && self.initial_real_token_reserves <= self.token_total_supply,
            ParabullError::InvalidCurveParams
        );
        self.validate_migration_reserve()
    }

    /// The migration reserve must fit the curve these parameters launch: a
    /// curve sold out raises `buy_cost(initial reserves, initial real tokens)`,
    /// and `prepare_migration` seeds the pool with that minus the reserve. The
    /// reserve must leave SOL for the pool and keep its opening price within
    /// `MAX_MIGRATION_PRICE_DISCOUNT_BPS` of the curve's final price (the check
    /// `prepare_migration` makes), so no parameter update can strand a coin.
    pub fn validate_migration_reserve(&self) -> Result<()> {
        let start = crate::math::Reserves {
            virtual_token: self.initial_virtual_token_reserves,
            virtual_sol: self.initial_virtual_sol_reserves,
            real_token: self.initial_real_token_reserves,
            real_sol: 0,
        };
        let raise = crate::math::buy_cost(&start, self.initial_real_token_reserves)?;
        let sol_to_pool = raise.checked_sub(self.migration_reserve_lamports).filter(|s| *s > 0).ok_or(ParabullError::MigrationReserveOutOfRange)?;
        let tokens_to_pool = self.token_total_supply.checked_sub(self.initial_real_token_reserves).ok_or(ParabullError::Overflow)?;
        let final_sol = self.initial_virtual_sol_reserves.checked_add(raise).ok_or(ParabullError::Overflow)?;
        let final_token = self.initial_virtual_token_reserves.checked_sub(self.initial_real_token_reserves).ok_or(ParabullError::Overflow)?;
        require!(
            tokens_to_pool > 0
                && crate::raydium::pool_price_within(sol_to_pool, tokens_to_pool, final_sol, final_token, MAX_MIGRATION_PRICE_DISCOUNT_BPS),
            ParabullError::MigrationReserveOutOfRange
        );
        Ok(())
    }
}

/// Partial update for `update_global_params`: `None` leaves a field unchanged.
/// The merged result is validated with the same rules as `initialize`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct GlobalUpdate {
    pub dex_target_lamports: Option<u64>,
    pub buyback_bps: Option<u16>,
    pub holder_bps: Option<u16>,
    pub migration_reserve_lamports: Option<u64>,
    pub trading_open_delay_slots: Option<u64>,
    pub cpmm_program: Option<Pubkey>,
    pub cpmm_amm_config: Option<Pubkey>,
    pub lp_lock_program: Option<Pubkey>,
    pub lp_lock_authority: Option<Pubkey>,
    pub parabull_mint: Option<Pubkey>,
    pub parabull_pool: Option<Pubkey>,
    pub reward_claim_window_seconds: Option<i64>,
}

impl Global {
    pub fn to_params(&self) -> GlobalParams {
        GlobalParams {
            launch_authority: self.launch_authority,
            crank_authority: self.crank_authority,
            treasury: self.treasury,
            parabull_mint: self.parabull_mint,
            launch_fee_lamports: self.launch_fee_lamports,
            ticket_deposit_lamports: self.ticket_deposit_lamports,
            ticket_ttl_seconds: self.ticket_ttl_seconds,
            platform_fee_bps: self.platform_fee_bps,
            buyback_bps: self.buyback_bps,
            holder_bps: self.holder_bps,
            dex_target_lamports: self.dex_target_lamports,
            trading_open_delay_slots: self.trading_open_delay_slots,
            registry_lock_seconds: self.registry_lock_seconds,
            initial_virtual_token_reserves: self.initial_virtual_token_reserves,
            initial_virtual_sol_reserves: self.initial_virtual_sol_reserves,
            initial_real_token_reserves: self.initial_real_token_reserves,
            token_total_supply: self.token_total_supply,
            cpmm_program: self.cpmm_program,
            cpmm_amm_config: self.cpmm_amm_config,
            lp_lock_program: self.lp_lock_program,
            lp_lock_authority: self.lp_lock_authority,
            migration_reserve_lamports: self.migration_reserve_lamports,
            parabull_pool: self.parabull_pool,
            reward_claim_window_seconds: self.reward_claim_window_seconds,
        }
    }

    /// Merge, validate as a whole, then apply. All-or-nothing.
    pub fn apply_update(&mut self, u: &GlobalUpdate, now: i64) -> Result<()> {
        let mut p = self.to_params();
        if let Some(v) = u.dex_target_lamports { p.dex_target_lamports = v; }
        if let Some(v) = u.buyback_bps { p.buyback_bps = v; }
        if let Some(v) = u.holder_bps { p.holder_bps = v; }
        if let Some(v) = u.migration_reserve_lamports { p.migration_reserve_lamports = v; }
        if let Some(v) = u.trading_open_delay_slots { p.trading_open_delay_slots = v; }
        if let Some(v) = u.cpmm_program { p.cpmm_program = v; }
        if let Some(v) = u.cpmm_amm_config { p.cpmm_amm_config = v; }
        if let Some(v) = u.lp_lock_program { p.lp_lock_program = v; }
        if let Some(v) = u.lp_lock_authority { p.lp_lock_authority = v; }
        if let Some(v) = u.parabull_mint { p.parabull_mint = v; }
        if let Some(v) = u.parabull_pool { p.parabull_pool = v; }
        if let Some(v) = u.reward_claim_window_seconds { p.reward_claim_window_seconds = v; }
        let target_updated_at = if u.dex_target_lamports.is_some() { now } else { self.dex_target_updated_at };
        self.apply_params(&p, now)?;
        self.dex_target_updated_at = target_updated_at;
        Ok(())
    }

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
        self.cpmm_program = p.cpmm_program;
        self.cpmm_amm_config = p.cpmm_amm_config;
        self.lp_lock_program = p.lp_lock_program;
        self.lp_lock_authority = p.lp_lock_authority;
        self.migration_reserve_lamports = p.migration_reserve_lamports;
        self.parabull_pool = p.parabull_pool;
        self.reward_claim_window_seconds = p.reward_claim_window_seconds;
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

    /// `MigrationStage` as u8.
    pub migration_stage: u8,
    /// Amounts moved to the migration authority by `prepare_migration`.
    pub migration_sol: u64,
    pub migration_tokens: u64,
    /// Raydium CPMM pool created by `migrate_raydium`.
    pub raydium_pool: Pubkey,
    /// Burn & Earn fee-key NFT mint created by `lock_migrated_lp`.
    pub fee_nft_mint: Pubkey,
    /// Lifetime post-graduation LP fees: SOL collected and launched tokens
    /// collected-and-burned (measured amounts).
    pub lp_fees_sol_collected: u64,
    pub lp_fees_tokens_burned: u64,

    pub _reserved: [u8; 16],
}

/// Graduation progress. Each step is a separate instruction (CPMM init and the
/// LP lock do not fit in one transaction).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum MigrationStage {
    /// Trading on the curve (or complete, awaiting migration).
    None = 0,
    /// Tokens + SOL moved to the migration authority PDA.
    Prepared = 1,
    /// Raydium CPMM pool created; LP tokens held by the migration authority.
    PoolCreated = 2,
    /// LP locked in Burn & Earn; fee-key NFT held by the fee-key vault.
    LpLocked = 3,
}

impl BondingCurve {
    pub fn stage(&self) -> MigrationStage {
        match self.migration_stage {
            1 => MigrationStage::Prepared,
            2 => MigrationStage::PoolCreated,
            3 => MigrationStage::LpLocked,
            _ => MigrationStage::None,
        }
    }

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
        self.migration_stage = MigrationStage::None as u8;
        self.migration_sol = 0;
        self.migration_tokens = 0;
        self.raydium_pool = Pubkey::default();
        self.fee_nft_mint = Pubkey::default();
        self.lp_fees_sol_collected = 0;
        self.lp_fees_tokens_burned = 0;
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
    /// Everything the user paid: the flat deposit, *including* this ticket's
    /// own rent (the ticket holds exactly this many lamports).
    pub deposit_lamports: u64,
    /// Protocol fee quoted at request time. The rest of the deposit repays
    /// the rent the launch authority fronts in `create`; anything unspent
    /// goes to the treasury.
    pub launch_fee_lamports: u64,
    pub created_at: i64,
    pub expires_at: i64,
    pub ticker: [u8; MAX_TICKER_LEN],
    pub ticker_len: u8,
    pub name_hash: [u8; 32],
    /// `metadata_commitment(name, symbol, uri)`.
    pub metadata_hash: [u8; 32],
    /// `launch::tweet_id_hash(tweet_id)` of the announcement tweet, if any.
    /// Computed on-chain from the numeric status ID so URL variants of one
    /// tweet can't dodge the lock.
    pub tweet_id_hash: Option<[u8; 32]>,
    pub _reserved: [u8; 24],
}

impl LaunchTicket {
    pub fn ticker(&self) -> &[u8] {
        &self.ticker[..usize::from(self.ticker_len)]
    }

    /// Seed for the tweet registry PDA (empty when the ticket has no tweet;
    /// `create` rejects a registry account in that case).
    pub fn tweet_seed(&self) -> &[u8] {
        self.tweet_id_hash.as_ref().map_or(&[], |h| &h[..])
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

/// Announcement-tweet lock. PDA: `["tweet", tweet_id_hash]`.
#[account]
#[derive(InitSpace, Debug)]
pub struct TweetRegistry {
    pub bump: u8,
    pub tweet_id_hash: [u8; 32],
    pub mint: Pubkey,
    pub launch_timestamp: i64,
}

impl TweetRegistry {
    pub fn is_locked(&self, now: i64, lock_seconds: i64) -> bool {
        registry_locked(self.launch_timestamp, now, lock_seconds)
    }
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

/// sha256 of the name reduced to its lowercase ASCII letters and digits, so
/// case, spaces and symbols don't matter: "Pepe Coin", "PepeCoin" and
/// "P.E.P.E-coin" all lock the same entry. A name with no ASCII letters or
/// digits at all (e.g. only emoji) falls back to its trimmed raw bytes; that
/// can't collide with a stripped name, which always has at least one ASCII
/// alphanumeric byte. Unicode lookalikes are the off-chain indexer's job.
pub fn normalize_name_hash(input: &str) -> Result<[u8; 32]> {
    let raw = input.trim();
    require!(!raw.is_empty() && raw.len() <= MAX_NAME_LEN, ParabullError::InvalidName);
    let stripped: Vec<u8> = raw.bytes().filter(u8::is_ascii_alphanumeric).map(|b| b.to_ascii_lowercase()).collect();
    let key: &[u8] = if stripped.is_empty() { raw.as_bytes() } else { &stripped };
    Ok(hashv(&[key]).to_bytes())
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
    /// Unclaimed lamports released by `expire_reward_epoch`.
    pub total_expired_lamports: u64,
    pub _reserved: [u8; 56],
}

impl HolderRewardVault {
    /// Lamports deposited but not yet assigned to an epoch.
    pub fn uncommitted(&self) -> Result<u64> {
        self.total_deposited_lamports
            .checked_sub(self.total_committed_lamports)
            .ok_or_else(|| error!(ParabullError::Overflow))
    }
}

/// One holder-reward distribution: an off-chain snapshot of $PARABULL holders
/// committed as a Merkle root over `(index, claimant, amount)` leaves.
/// PDA: `["reward-epoch", epoch_le]`. Sized per epoch for its claimed-bitmap.
#[account]
#[derive(Debug)]
pub struct RewardEpoch {
    pub bump: u8,
    pub epoch: u64,
    pub merkle_root: [u8; 32],
    pub snapshot_slot: u64,
    pub total_lamports: u64,
    pub claimed_lamports: u64,
    pub num_leaves: u32,
    pub claimed_count: u32,
    pub published_at: i64,
    /// `published_at + Global.reward_claim_window_seconds` at publish time.
    pub expires_at: i64,
    /// Set by `expire_reward_epoch`; no claims afterwards.
    pub expired: bool,
    /// Bit `i` set once leaf `i` has been paid.
    pub claimed_bitmap: Vec<u8>,
}

impl RewardEpoch {
    const FIXED: usize = 1 + 8 + 32 + 8 + 8 + 8 + 4 + 4 + 8 + 8 + 1;

    pub fn bitmap_len(num_leaves: u32) -> usize {
        (num_leaves as usize).div_ceil(8)
    }

    /// Account space including the 8-byte discriminator.
    pub fn space(num_leaves: u32) -> usize {
        8 + Self::FIXED + 4 + Self::bitmap_len(num_leaves)
    }

    pub fn is_claimed(&self, index: u32) -> bool {
        self.claimed_bitmap[(index / 8) as usize] & (1 << (index % 8)) != 0
    }

    /// Mark leaf `index` paid. Fails if out of range or already claimed.
    pub fn mark_claimed(&mut self, index: u32, amount: u64) -> Result<()> {
        require!(!self.expired, ParabullError::RewardEpochExpired);
        require!(index < self.num_leaves, ParabullError::InvalidMerkleProof);
        require!(!self.is_claimed(index), ParabullError::RewardAlreadyClaimed);
        let claimed = self.claimed_lamports.checked_add(amount).ok_or(ParabullError::Overflow)?;
        require!(claimed <= self.total_lamports, ParabullError::RewardEpochExhausted);
        self.claimed_bitmap[(index / 8) as usize] |= 1 << (index % 8);
        self.claimed_lamports = claimed;
        self.claimed_count = self.claimed_count.checked_add(1).ok_or(ParabullError::Overflow)?;
        Ok(())
    }
}

impl RewardEpoch {
    /// Close the epoch once its claim window has passed (strictly after
    /// `expires_at`). Returns the unclaimed lamports to release. Claims stay
    /// possible until this runs, even past the deadline.
    pub fn expire(&mut self, now: i64) -> Result<u64> {
        require!(!self.expired, ParabullError::RewardEpochExpired);
        require!(now > self.expires_at, ParabullError::RewardEpochNotExpired);
        let unclaimed = self.total_lamports.checked_sub(self.claimed_lamports).ok_or(ParabullError::Overflow)?;
        self.expired = true;
        Ok(unclaimed)
    }
}

impl HolderRewardVault {
    /// Committed to published epochs, not yet claimed, not expired.
    pub fn outstanding(&self) -> Result<u64> {
        self.total_committed_lamports
            .checked_sub(self.total_claimed_lamports)
            .and_then(|v| v.checked_sub(self.total_expired_lamports))
            .ok_or_else(|| error!(ParabullError::Overflow))
    }
}

/// A vault may commit a new epoch of `total` only if its lamports cover rent,
/// every outstanding (published, unclaimed) reward, and `total`.
pub fn reward_epoch_fundable(vault_lamports: u64, rent_minimum: u64, outstanding: u64, total: u64) -> bool {
    rent_minimum
        .checked_add(outstanding)
        .and_then(|v| v.checked_add(total))
        .is_some_and(|need| vault_lamports >= need)
}

/// Lamports a program-owned vault can pay out while staying rent-exempt.
pub fn vault_spendable(vault_lamports: u64, rent_minimum: u64) -> u64 {
    vault_lamports.saturating_sub(rent_minimum)
}

#[cfg(test)]
pub(crate) mod fixtures {
    //! In-memory accounts shared by unit tests across modules.
    use super::*;

    pub(crate) fn global() -> Global {
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
            cpmm_program: crate::raydium::CPMM_PROGRAM_MAINNET,
            cpmm_amm_config: Pubkey::new_unique(),
            lp_lock_program: crate::raydium::LP_LOCK_PROGRAM_MAINNET,
            lp_lock_authority: crate::raydium::LP_LOCK_AUTHORITY_MAINNET,
            migration_reserve_lamports: DEFAULT_MIGRATION_RESERVE_LAMPORTS,
            pending_admin: Pubkey::default(),
            parabull_pool: Pubkey::default(),
            reward_claim_window_seconds: DEFAULT_REWARD_CLAIM_WINDOW_SECONDS,
            _reserved: [0; 24],
        }
    }

    pub(crate) fn curve(g: &Global) -> BondingCurve {
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
            migration_stage: 0,
            migration_sol: 0,
            migration_tokens: 0,
            raydium_pool: Pubkey::default(),
            fee_nft_mint: Pubkey::default(),
            lp_fees_sol_collected: 0,
            lp_fees_tokens_burned: 0,
            _reserved: [0; 16],
        };
        c.init(254, Pubkey::new_unique(), Pubkey::new_unique(), g, 1_000, 1_700_000_000).unwrap();
        c
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{curve, global};
    use super::*;

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
            cpmm_program: g.cpmm_program,
            cpmm_amm_config: g.cpmm_amm_config,
            lp_lock_program: g.lp_lock_program,
            lp_lock_authority: g.lp_lock_authority,
            migration_reserve_lamports: g.migration_reserve_lamports,
            parabull_pool: g.parabull_pool,
            reward_claim_window_seconds: g.reward_claim_window_seconds,
        }
    }

    #[test]
    fn trading_delay_dex_target_and_reserve_bounds() {
        let g = global();
        let code = |p: &GlobalParams| match p.validate() {
            Err(anchor_lang::error::Error::AnchorError(e)) => Some(e.error_code_number),
            Ok(()) => None,
            Err(e) => panic!("{e:?}"),
        };
        let ok = params(&g);
        assert_eq!(code(&ok), None);
        for (slots, valid) in [(0, false), (1, true), (2, true), (150, true), (151, false), (u64::MAX, false)] {
            let p = GlobalParams { trading_open_delay_slots: slots, ..ok.clone() };
            assert_eq!(code(&p), if valid { None } else { Some(u32::from(ParabullError::TradingDelayOutOfRange)) }, "delay {slots}");
        }
        for (target, valid) in [(0, true), (MAX_DEX_TARGET_LAMPORTS, true), (MAX_DEX_TARGET_LAMPORTS + 1, false), (u64::MAX, false)] {
            let p = GlobalParams { dex_target_lamports: target, ..ok.clone() };
            assert_eq!(code(&p), if valid { None } else { Some(u32::from(ParabullError::DexTargetTooHigh)) }, "target {target}");
        }
        // The default curve raises ~85 SOL. A reserve is fine while the pool opens within 5% of the final price;
        // one that eats the raise (or more) is refused, as prepare_migration would refuse to migrate.
        let raise = crate::math::buy_cost(
            &Reserves { virtual_token: ok.initial_virtual_token_reserves, virtual_sol: ok.initial_virtual_sol_reserves, real_token: ok.initial_real_token_reserves, real_sol: 0 },
            ok.initial_real_token_reserves,
        )
        .unwrap();
        assert!((84_000_000_000..86_000_000_000).contains(&raise), "{raise}");
        for (reserve, valid) in [(1, true), (DEFAULT_MIGRATION_RESERVE_LAMPORTS, true), (raise / 10, false), (raise - 1, false), (raise, false), (u64::MAX, false)] {
            let p = GlobalParams { migration_reserve_lamports: reserve, ..ok.clone() };
            assert_eq!(code(&p), if valid { None } else { Some(u32::from(ParabullError::MigrationReserveOutOfRange)) }, "reserve {reserve}");
        }
        // The exact boundary matches prepare_migration's own pool-price check at completion.
        let tokens = ok.token_total_supply - ok.initial_real_token_reserves;
        let (vs, vt) = (ok.initial_virtual_sol_reserves + raise, ok.initial_virtual_token_reserves - ok.initial_real_token_reserves);
        let max_ok = (1..raise).rev().step_by(1_000_000).find(|r| crate::raydium::pool_price_within(raise - r, tokens, vs, vt, MAX_MIGRATION_PRICE_DISCOUNT_BPS)).unwrap();
        assert_eq!(code(&GlobalParams { migration_reserve_lamports: max_ok, ..ok.clone() }), None);
        assert!(!crate::raydium::pool_price_within(raise - (max_ok + 1_000_000), tokens, vs, vt, MAX_MIGRATION_PRICE_DISCOUNT_BPS));
        assert_eq!(code(&GlobalParams { migration_reserve_lamports: max_ok + 1_000_000, ..ok.clone() }), Some(u32::from(ParabullError::MigrationReserveOutOfRange)));
    }

    #[test]
    fn default_params_validate() {
        params(&global()).validate().unwrap();
        assert_eq!(global().to_params().cpmm_program, params(&global()).cpmm_program);
    }

    #[test]
    fn partial_update_changes_only_given_fields() {
        let mut g = global();
        let before = g.to_params();
        let u = GlobalUpdate { dex_target_lamports: Some(1_800_000_000), trading_open_delay_slots: Some(5), ..Default::default() };
        g.apply_update(&u, 42).unwrap();
        assert_eq!((g.dex_target_lamports, g.dex_target_updated_at, g.trading_open_delay_slots), (1_800_000_000, 42, 5));
        let after = g.to_params();
        assert_eq!(after.buyback_bps, before.buyback_bps);
        assert_eq!(after.cpmm_program, before.cpmm_program);
        assert_eq!(after.launch_authority, before.launch_authority);

        // Not touching the target keeps its timestamp.
        g.apply_update(&GlobalUpdate { buyback_bps: Some(6_000), ..Default::default() }, 99).unwrap();
        assert_eq!((g.buyback_bps, g.dex_target_updated_at), (6_000, 42));
    }

    #[test]
    fn invalid_update_is_rejected_atomically() {
        let mut g = global(); // buyback 5000, holder 4000
        let snapshot = g.to_params();
        // Raising holder alone would push the split over 100%.
        let bad = GlobalUpdate { holder_bps: Some(5_001), dex_target_lamports: Some(1), ..Default::default() };
        assert!(g.apply_update(&bad, 7).is_err());
        assert_eq!(g.to_params().holder_bps, snapshot.holder_bps);
        assert_eq!(g.dex_target_lamports, snapshot.dex_target_lamports, "nothing applied");
        // Both together is fine.
        g.apply_update(&GlobalUpdate { buyback_bps: Some(4_000), holder_bps: Some(5_000), ..Default::default() }, 7).unwrap();
        for bad in [
            GlobalUpdate { migration_reserve_lamports: Some(0), ..Default::default() },
            GlobalUpdate { cpmm_program: Some(Pubkey::default()), ..Default::default() },
            GlobalUpdate { lp_lock_authority: Some(Pubkey::default()), ..Default::default() },
        ] {
            assert!(g.apply_update(&bad, 8).is_err(), "{bad:?}");
        }
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

    fn hex(h: [u8; 32]) -> String {
        h.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Vectors computed independently in Python; also pinned in
    /// scripts/src/launch.test.ts.
    #[test]
    fn name_normalisation_strips_case_spaces_and_symbols() {
        const PEPECOIN: &str = "cfab0255bde5c58424108384d65d8f8c26d669d50e9a025681c64f5530be395f";
        for name in ["Pepe Coin", "PepeCoin", "P.E.P.E-coin", "  pepe_COIN!! ", "PEPE   coin"] {
            assert_eq!(hex(normalize_name_hash(name).unwrap()), PEPECOIN, "{name:?}");
        }
        assert_ne!(normalize_name_hash("pepe coins").unwrap(), normalize_name_hash("pepe coin").unwrap());
        assert_ne!(normalize_name_hash("pepe coin 2").unwrap(), normalize_name_hash("pepe coin").unwrap());
        // No ASCII letters/digits: raw-bytes fallback.
        assert_eq!(hex(normalize_name_hash("🐸🐸").unwrap()), "8e96e8715e0348cfd35b9fefecef9476eebae0863fd595acfbcd89241c6b4a68");
        assert_eq!(hex(normalize_name_hash("$$$").unwrap()), "4935926371d1a35cec5c938bd7bd1ccb50bfe845c89e8f6ebfb0709c1b8bd22c");
        assert_ne!(normalize_name_hash("$$$").unwrap(), normalize_name_hash("%%%").unwrap(), "fallbacks stay distinct");
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

    fn epoch(num_leaves: u32, total: u64) -> RewardEpoch {
        RewardEpoch {
            bump: 0,
            epoch: 0,
            merkle_root: [0; 32],
            snapshot_slot: 0,
            total_lamports: total,
            claimed_lamports: 0,
            num_leaves,
            claimed_count: 0,
            published_at: 0,
            expires_at: 1_000,
            expired: false,
            claimed_bitmap: vec![0; RewardEpoch::bitmap_len(num_leaves)],
        }
    }

    #[test]
    fn reward_bitmap_marks_each_leaf_once() {
        let mut e = epoch(10, 1_000);
        e.mark_claimed(0, 100).unwrap();
        e.mark_claimed(9, 200).unwrap();
        assert!(e.is_claimed(0) && e.is_claimed(9) && !e.is_claimed(8));
        assert!(e.mark_claimed(9, 1).is_err(), "double claim");
        assert!(e.mark_claimed(10, 1).is_err(), "out of range");
        assert!(e.mark_claimed(5, 701).is_err(), "over the epoch total");
        e.mark_claimed(5, 700).unwrap();
        assert_eq!((e.claimed_lamports, e.claimed_count), (1_000, 3));
    }

    #[test]
    fn epoch_expiry_rules() {
        let mut e = epoch(4, 1_000); // expires_at = 1_000
        e.mark_claimed(0, 300).unwrap();
        assert_eq!(e.expire(1_000).unwrap_err().to_string().contains("RewardEpochNotExpired"), true, "not at the deadline itself");
        // Late claims are still honoured until someone actually expires it.
        e.mark_claimed(1, 200).unwrap();
        assert_eq!(e.expire(1_001).unwrap(), 500, "unclaimed = total - claimed");
        assert!(e.expired);
        assert!(e.expire(2_000).is_err(), "only once");
        assert!(e.mark_claimed(2, 1).is_err(), "no claims after expiry");
    }

    #[test]
    fn expired_lamports_leave_outstanding() {
        let v = HolderRewardVault {
            bump: 0,
            total_deposited_lamports: 0,
            total_committed_lamports: 1_000,
            total_claimed_lamports: 300,
            next_epoch: 1,
            total_expired_lamports: 500,
            _reserved: [0; 56],
        };
        assert_eq!(v.outstanding().unwrap(), 200);
    }

    #[test]
    fn claim_window_has_a_floor() {
        let mut p = params(&global());
        p.reward_claim_window_seconds = MIN_REWARD_CLAIM_WINDOW_SECONDS - 1;
        assert!(p.validate().is_err());
        p.reward_claim_window_seconds = MIN_REWARD_CLAIM_WINDOW_SECONDS;
        p.validate().unwrap();
    }

    #[test]
    fn reward_funding_and_vault_spend_rules() {
        assert!(reward_epoch_fundable(1_000, 100, 300, 600));
        assert!(!reward_epoch_fundable(1_000, 100, 300, 601));
        assert!(!reward_epoch_fundable(u64::MAX, u64::MAX, 1, 0), "overflow is not fundable");
        assert_eq!(vault_spendable(1_000, 100), 900);
        assert_eq!(vault_spendable(50, 100), 0);
    }

    /// Pinned in scripts/src/launch.test.ts (computed independently in Python).
    #[test]
    fn metadata_commitment_pinned_vector() {
        assert_eq!(
            hex(metadata_commitment("Pepe Coin", "PEPE", "https://arweave.net/pepe.json")),
            "598b8e6319c891e3fc368180564bbd19d787832fac8dc27d3ddcc72590050708"
        );
    }

    #[test]
    fn metadata_commitment_is_boundary_safe() {
        assert_ne!(metadata_commitment("ab", "c", "u"), metadata_commitment("a", "bc", "u"));
        assert_eq!(metadata_commitment("a", "b", "c"), metadata_commitment("a", "b", "c"));
    }

    #[test]
    fn account_sizes_fit_and_are_stable() {
        // 8-byte discriminator + INIT_SPACE. Pinned so layout changes are deliberate.
        assert_eq!(8 + Global::INIT_SPACE, 504);
        assert_eq!(8 + BondingCurve::INIT_SPACE, 285);
        assert_eq!(8 + LaunchTicket::INIT_SPACE, 213);
        assert_eq!(8 + TweetRegistry::INIT_SPACE, 81);
        assert_eq!(8 + TickerRegistry::INIT_SPACE, 60);
        assert_eq!(8 + NameRegistry::INIT_SPACE, 81);
        assert_eq!(8 + BuybackVault::INIT_SPACE, 113);
        assert_eq!(8 + HolderRewardVault::INIT_SPACE, 105);
        // Variable size: fixed header + Vec length prefix + 1 bit per leaf.
        assert_eq!(RewardEpoch::space(1), 8 + 90 + 4 + 1);
        assert_eq!(RewardEpoch::space(8), 8 + 90 + 4 + 1);
        assert_eq!(RewardEpoch::space(9), 8 + 90 + 4 + 2);
        assert!(RewardEpoch::space(MAX_REWARD_LEAVES) <= 10_240, "must be creatable by CPI");
    }
}

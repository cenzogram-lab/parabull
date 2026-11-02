//! PDA seeds, protocol bounds and default launch parameters.

// ---- PDA seeds -------------------------------------------------------------
pub const SEED_GLOBAL: &[u8] = b"global";
pub const SEED_BONDING_CURVE: &[u8] = b"bonding-curve";
pub const SEED_MINT_AUTHORITY: &[u8] = b"mint-authority";
pub const SEED_LAUNCH_TICKET: &[u8] = b"ticket";
pub const SEED_TICKER_REGISTRY: &[u8] = b"registry";
pub const SEED_NAME_REGISTRY: &[u8] = b"name";
pub const SEED_TWEET_REGISTRY: &[u8] = b"tweet";
/// Domain separator for `tweet_id_hash` (see `launch::tweet_id_hash`).
pub const TWEET_HASH_DOMAIN: &[u8] = b"parabull:tweet";
pub const SEED_BUYBACK_VAULT: &[u8] = b"buyback-vault";
pub const SEED_HOLDER_VAULT: &[u8] = b"holder-vault";
pub const SEED_REWARD_EPOCH: &[u8] = b"reward-epoch";
/// System-owned, data-less PDA per mint that acts as the Raydium CPMM pool
/// creator and LP owner during migration (CPMM requires a system-owned payer).
pub const SEED_MIGRATION_AUTHORITY: &[u8] = b"migration-authority";
/// Holds every Burn & Earn fee-key NFT so post-graduation LP fees stay claimable.
pub const SEED_FEE_KEY_VAULT: &[u8] = b"fee-key-vault";
/// System-owned PDA that holds staged buyback SOL and signs the $PARABULL
/// swap + burn (a data account like BuybackVault can't pay via the system program).
pub const SEED_BUYBACK_AUTHORITY: &[u8] = b"buyback-authority";

// ---- Protocol bounds -------------------------------------------------------
pub const BPS_DENOMINATOR: u64 = 10_000;
/// Hard ceiling on the platform trading fee. Admin can lower it, never exceed 1%.
pub const MAX_PLATFORM_FEE_BPS: u16 = 100;
/// Ticker: 1..=10 ASCII alphanumerics after normalisation (fits a PDA seed).
pub const MAX_TICKER_LEN: usize = 10;
/// Raw name/URI limits (bytes), matching Metaplex-style metadata bounds.
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_URI_LEN: usize = 200;
pub const TOKEN_DECIMALS: u8 = 6;
/// Minimum lamports a launch ticket must hold above the protocol launch fee to
/// cover rent for mint + curve + curve ATA + registry PDAs.
pub const MIN_LAUNCH_RENT_BUFFER_LAMPORTS: u64 = 15_000_000;
/// The Raydium pool may open at most this far below the curve's final price
/// (guards against a migration reserve that eats into pool liquidity).
pub const MAX_MIGRATION_PRICE_DISCOUNT_BPS: u64 = 500;
/// Max leaves per holder-reward epoch: the claimed-bitmap must fit in a
/// 10 KiB account created by CPI. Larger snapshots span several epochs.
pub const MAX_REWARD_LEAVES: u32 = 80_000;
/// Holders always get at least this long to claim before an epoch can expire.
pub const MIN_REWARD_CLAIM_WINDOW_SECONDS: i64 = 7 * 24 * 60 * 60;

// ---- Defaults (used by deploy scripts and tests) ---------------------------
pub const DEFAULT_PLATFORM_FEE_BPS: u16 = 100;
pub const DEFAULT_LAUNCH_FEE_LAMPORTS: u64 = 200_000_000;
pub const DEFAULT_TICKET_DEPOSIT_LAMPORTS: u64 = 230_000_000;
pub const DEFAULT_TICKET_TTL_SECONDS: i64 = 10 * 60;
pub const DEFAULT_REGISTRY_LOCK_SECONDS: i64 = 3 * 24 * 60 * 60;
pub const DEFAULT_TRADING_OPEN_DELAY_SLOTS: u64 = 2;
/// Curve shape inherited from the reference program's mainnet `set_params`.
pub const DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES: u64 = 1_073_000_000_000_000;
pub const DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES: u64 = 30_000_000_000;
pub const DEFAULT_INITIAL_REAL_TOKEN_RESERVES: u64 = 793_100_000_000_000;
pub const DEFAULT_TOKEN_TOTAL_SUPPLY: u64 = 1_000_000_000_000_000;
/// SOL held back from the pool at migration to pay Raydium's pool-creation
/// fee (0.15 SOL on mainnet AmmConfig 0) plus rent for the pool and lock
/// accounts. Unspent lamports go to the treasury after the LP is locked.
pub const DEFAULT_MIGRATION_RESERVE_LAMPORTS: u64 = 250_000_000;
pub const DEFAULT_REWARD_CLAIM_WINDOW_SECONDS: i64 = 30 * 24 * 60 * 60;

use anchor_lang::prelude::*;

#[error_code]
pub enum ParabullError {
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Division by zero")]
    DivisionByZero,
    #[msg("Value does not fit in u64")]
    Truncation,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Requested amount exceeds curve reserves")]
    InsufficientReserves,
    #[msg("Signer is not authorised for this action")]
    Unauthorized,
    #[msg("Program is paused")]
    Paused,
    #[msg("Platform fee exceeds the 1% ceiling")]
    PlatformFeeTooHigh,
    #[msg("Buyback + holder basis points exceed 10000")]
    FeeSplitOutOfRange,
    #[msg("Launch ticket deposit does not cover the launch fee plus rent buffer")]
    TicketDepositTooLow,
    #[msg("Invalid duration parameter")]
    InvalidDuration,
    #[msg("Invalid bonding curve parameters")]
    InvalidCurveParams,
    #[msg("A required authority or mint is the default pubkey")]
    InvalidAuthority,
    #[msg("Ticker must be 1-10 ASCII letters or digits")]
    InvalidTicker,
    #[msg("Name must be 1-32 bytes")]
    InvalidName,
    #[msg("URI exceeds 200 bytes")]
    InvalidUri,
    #[msg("Symbol must already be the canonical ticker (uppercase A-Z/0-9, no $ or spaces)")]
    NonCanonicalSymbol,
    #[msg("Name must not have leading or trailing whitespace")]
    NonCanonicalName,
    #[msg("Launch ticket has expired")]
    TicketExpired,
    #[msg("Launch ticket has not expired yet")]
    TicketNotExpired,
    #[msg("Launch fee exceeds the ticket deposit")]
    LaunchFeeExceedsDeposit,
    #[msg("Name/symbol/URI do not match the launch ticket commitment")]
    MetadataMismatch,
    #[msg("Ticker is locked by a launch in the last 3 days")]
    TickerLocked,
    #[msg("Name is locked by a launch in the last 3 days")]
    NameLocked,
    #[msg("Trading has not opened yet for this curve")]
    TradingNotOpenYet,
    #[msg("Bonding curve is complete; trading is locked until migration")]
    CurveComplete,
    #[msg("Slippage limit exceeded")]
    SlippageExceeded,
    #[msg("Bonding curve lamports do not cover rent + reserves + accrued fees")]
    LamportInvariantViolated,
    #[msg("Bonding curve is not complete")]
    CurveNotComplete,
    #[msg("Migration is not at the required stage")]
    InvalidMigrationStage,
    #[msg("Account does not match the derived Raydium/migration address")]
    InvalidMigrationAccount,
    #[msg("Curve SOL does not exceed the migration reserve")]
    InsufficientMigrationSol,
    #[msg("Opening pool price deviates too far from the curve's final price")]
    MigrationPriceOutOfRange,
    #[msg("Invalid migration parameters")]
    InvalidMigrationParams,
    #[msg("DexScreener escrow has not reached the target")]
    EscrowNotFunded,
    #[msg("DexScreener escrow is already funded")]
    EscrowAlreadyFunded,
    #[msg("DexScreener escrow was already released")]
    EscrowAlreadyReleased,
    #[msg("No admin transfer is pending for this signer")]
    NoPendingAdmin,
    #[msg("Nothing was collected")]
    NothingCollected,
    #[msg("$PARABULL buyback pool is not configured")]
    BuybackNotConfigured,
    #[msg("Vault cannot pay this amount and stay rent-exempt")]
    InsufficientVaultBalance,
    #[msg("Holder vault cannot fund this epoch on top of outstanding rewards")]
    InsufficientRewardFunds,
    #[msg("Invalid holder-reward epoch parameters")]
    InvalidRewardEpoch,
    #[msg("Merkle proof does not match the epoch root")]
    InvalidMerkleProof,
    #[msg("Reward already claimed")]
    RewardAlreadyClaimed,
    #[msg("Claim exceeds the epoch's remaining total")]
    RewardEpochExhausted,
    #[msg("Reward epoch has expired")]
    RewardEpochExpired,
    #[msg("Reward epoch claim window has not ended")]
    RewardEpochNotExpired,
    #[msg("Tweet ID must be a non-zero X/Twitter status ID")]
    InvalidTweetId,
    #[msg("Announcement tweet is locked by a launch in the last 3 days")]
    TweetLocked,
    #[msg("Tweet registry account must be passed exactly when the ticket has a tweet")]
    TweetRegistryMismatch,
    #[msg("Trading open delay must be between 1 and 150 slots")]
    TradingDelayOutOfRange,
    #[msg("DexScreener escrow target exceeds the maximum")]
    DexTargetTooHigh,
    #[msg("Migration reserve must leave the pool priced within the allowed discount of the curve's final price")]
    MigrationReserveOutOfRange,
    #[msg("The canonical CPMM pool already exists: migrate into a fresh-address pool")]
    CanonicalPoolTaken,
    #[msg("A fresh-address pool is only allowed when the canonical CPMM pool already exists")]
    FreshPoolNotAllowed,
    #[msg("Ticker registry account does not match the ticker")]
    TickerRegistryMismatch,
}

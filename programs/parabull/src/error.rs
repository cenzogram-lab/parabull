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
}

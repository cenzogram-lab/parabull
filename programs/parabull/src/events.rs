use anchor_lang::prelude::*;

#[event]
pub struct LaunchRequested {
    pub ticket: Pubkey,
    pub payer: Pubkey,
    pub nonce: u64,
    pub ticker: String,
    pub name_hash: [u8; 32],
    pub metadata_hash: [u8; 32],
    pub deposit_lamports: u64,
    pub expires_at: i64,
}

#[event]
pub struct TicketRefunded {
    pub ticket: Pubkey,
    pub payer: Pubkey,
    pub refunded_by: Pubkey,
    pub lamports: u64,
}

#[event]
pub struct TokenCreated {
    pub mint: Pubkey,
    pub bonding_curve: Pubkey,
    pub creator: Pubkey,
    pub ticket: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub created_slot: u64,
    pub trading_open_slot: u64,
    pub launch_timestamp: i64,
    pub virtual_token_reserves: u64,
    pub virtual_sol_reserves: u64,
    pub real_token_reserves: u64,
    pub token_total_supply: u64,
    pub launch_fee_lamports: u64,
}

#[event]
pub struct TradeEvent {
    pub mint: Pubkey,
    pub user: Pubkey,
    pub is_buy: bool,
    pub token_amount: u64,
    /// Buy: lamports added to reserves. Sell: lamports removed from reserves.
    pub sol_amount: u64,
    pub fee: u64,
    pub fee_to_escrow: u64,
    pub fee_to_buyback: u64,
    pub fee_to_holders: u64,
    pub fee_to_treasury: u64,
    pub virtual_token_reserves: u64,
    pub virtual_sol_reserves: u64,
    pub real_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub slot: u64,
    pub timestamp: i64,
}

/// The last real token was bought; the curve is locked until Raydium migration.
#[event]
pub struct GraduationReady {
    pub mint: Pubkey,
    pub bonding_curve: Pubkey,
    pub real_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub virtual_sol_reserves: u64,
    pub escrow_accrued: u64,
    pub escrow_funded: bool,
    pub slot: u64,
    pub timestamp: i64,
}

#[event]
pub struct MigrationPrepared {
    pub mint: Pubkey,
    pub migration_authority: Pubkey,
    pub sol_to_pool: u64,
    pub sol_reserve: u64,
    pub tokens_to_pool: u64,
    pub slot: u64,
}

#[event]
pub struct MigratedToRaydium {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub lp_mint: Pubkey,
    pub token_0: Pubkey,
    pub token_1: Pubkey,
    pub tokens_to_pool: u64,
    pub sol_to_pool: u64,
    pub slot: u64,
}

#[event]
pub struct LiquidityLocked {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub lp_amount: u64,
    pub fee_nft_mint: Pubkey,
    pub fee_nft_owner: Pubkey,
    pub reserve_refunded_to_treasury: u64,
}

#[event]
pub struct DexEscrowToppedUp {
    pub mint: Pubkey,
    pub payer: Pubkey,
    pub accepted: u64,
    pub escrow_accrued: u64,
    pub target: u64,
}

#[event]
pub struct DexEscrowReleased {
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub amount: u64,
    pub excess_to_buyback: u64,
}

#[event]
pub struct FeesSwept {
    pub mint: Pubkey,
    pub to_buyback_vault: u64,
    pub to_holder_vault: u64,
    pub to_treasury: u64,
}

#[event]
pub struct GlobalParamsUpdated {
    pub admin: Pubkey,
    pub update: crate::state::GlobalUpdate,
    pub timestamp: i64,
}

#[event]
pub struct AdminTransferProposed {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminTransferred {
    pub previous_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct LpFeesCollected {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub fee_lp_amount: u64,
    /// Measured SOL actually received (unwrapped from WSOL).
    pub sol_collected: u64,
    /// Measured launched-token amount received; held by the fee-key vault.
    pub tokens_collected: u64,
    pub to_escrow: u64,
    pub to_buyback_vault: u64,
    pub to_holder_vault: u64,
    pub to_treasury: u64,
}

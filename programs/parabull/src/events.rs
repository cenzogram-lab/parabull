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

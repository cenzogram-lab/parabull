use anchor_lang::prelude::*;

use crate::constants::{SEED_BUYBACK_VAULT, SEED_GLOBAL, SEED_HOLDER_VAULT};
use crate::error::ParabullError;
use crate::program::Parabull;
use crate::state::{BuybackVault, Global, GlobalParams, HolderRewardVault};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Global::INIT_SPACE,
        seeds = [SEED_GLOBAL],
        bump,
    )]
    pub global: Box<Account<'info, Global>>,

    /// Destination of swept buyback fees (SOL held as lamports above rent).
    #[account(
        init,
        payer = admin,
        space = 8 + BuybackVault::INIT_SPACE,
        seeds = [SEED_BUYBACK_VAULT],
        bump,
    )]
    pub buyback_vault: Box<Account<'info, BuybackVault>>,

    /// Destination of swept holder-reward fees.
    #[account(
        init,
        payer = admin,
        space = 8 + HolderRewardVault::INIT_SPACE,
        seeds = [SEED_HOLDER_VAULT],
        bump,
    )]
    pub holder_vault: Box<Account<'info, HolderRewardVault>>,

    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ParabullError::Unauthorized)]
    pub program: Program<'info, Parabull>,

    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ ParabullError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, params: GlobalParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let global = &mut ctx.accounts.global;
    global.bump = ctx.bumps.global;
    global.paused = false;
    global.admin = ctx.accounts.admin.key();
    global.launch_count = 0;
    global.pending_admin = Pubkey::default();
    global._reserved = [0; 24];
    global.apply_params(&params, now)?;

    ctx.accounts.buyback_vault.bump = ctx.bumps.buyback_vault;
    ctx.accounts.holder_vault.bump = ctx.bumps.holder_vault;
    Ok(())
}

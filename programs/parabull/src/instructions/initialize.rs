use anchor_lang::prelude::*;

use crate::constants::SEED_GLOBAL;
use crate::error::ParabullError;
use crate::program::Parabull;
use crate::state::{Global, GlobalParams};

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
    pub global: Account<'info, Global>,

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
    global._reserved = [0; 128];
    global.apply_params(&params, now)
}

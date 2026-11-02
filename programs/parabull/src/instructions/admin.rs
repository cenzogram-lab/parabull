//! Admin-only configuration: partial `Global` updates and two-step admin transfer.

use anchor_lang::prelude::*;

use crate::constants::SEED_GLOBAL;
use crate::error::ParabullError;
use crate::events::{AdminTransferProposed, AdminTransferred, GlobalParamsUpdated};
use crate::state::{Global, GlobalUpdate};

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(address = global.admin @ ParabullError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
}

/// Note: changing the CPMM / lock programs or AmmConfig only affects
/// migrations that have not reached that step yet. Post-graduation
/// instructions derive pool accounts from each curve's recorded pool.
pub fn update_handler(ctx: Context<AdminOnly>, update: GlobalUpdate) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.global.apply_update(&update, now)?;
    emit!(GlobalParamsUpdated { admin: ctx.accounts.admin.key(), update, timestamp: now });
    Ok(())
}

/// Step 1: nominate `new_admin`. `Pubkey::default()` cancels a pending transfer.
pub fn propose_handler(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.global.pending_admin = new_admin;
    emit!(AdminTransferProposed { admin: ctx.accounts.admin.key(), pending_admin: new_admin });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub pending_admin: Signer<'info>,

    #[account(mut, seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
}

/// Step 2: the nominee signs to take over. Proves the new key is controlled.
pub fn accept_handler(ctx: Context<AcceptAdmin>) -> Result<()> {
    let g = &mut ctx.accounts.global;
    let signer = ctx.accounts.pending_admin.key();
    require!(g.pending_admin != Pubkey::default() && g.pending_admin == signer, ParabullError::NoPendingAdmin);
    let previous_admin = g.admin;
    g.admin = signer;
    g.pending_admin = Pubkey::default();
    emit!(AdminTransferred { previous_admin, new_admin: signer });
    Ok(())
}

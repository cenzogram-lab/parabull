use anchor_lang::prelude::*;

use crate::constants::{SEED_GLOBAL, SEED_LAUNCH_TICKET};
use crate::error::ParabullError;
use crate::events::TicketRefunded;
use crate::launch::check_refund;
use crate::state::{Global, LaunchTicket};

/// Close an unused ticket and return deposit + rent to its payer. Works while
/// paused so user funds are never trapped.
#[derive(Accounts)]
pub struct RefundTicket<'info> {
    /// The payer (after expiry) or the launch authority (any time).
    pub authority: Signer<'info>,

    #[account(mut)]
    pub payer: SystemAccount<'info>,

    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    #[account(
        mut,
        close = payer,
        has_one = payer @ ParabullError::Unauthorized,
        seeds = [SEED_LAUNCH_TICKET, payer.key().as_ref(), &ticket.nonce.to_le_bytes()],
        bump = ticket.bump,
    )]
    pub ticket: Box<Account<'info, LaunchTicket>>,
}

pub fn handler(ctx: Context<RefundTicket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let ticket = &ctx.accounts.ticket;
    check_refund(
        &ctx.accounts.authority.key(),
        &ticket.payer,
        &ctx.accounts.global.launch_authority,
        ticket.expires_at,
        now,
    )?;
    emit!(TicketRefunded {
        ticket: ticket.key(),
        payer: ticket.payer,
        refunded_by: ctx.accounts.authority.key(),
        lamports: ticket.to_account_info().lamports(),
    });
    Ok(())
}

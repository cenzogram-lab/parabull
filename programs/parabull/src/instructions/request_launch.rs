use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::{SEED_GLOBAL, SEED_LAUNCH_TICKET};
use crate::error::ParabullError;
use crate::events::LaunchRequested;
use crate::launch::{deposit_top_up, ticket_expiry, tweet_id_hash, validate_launch_metadata};
use crate::state::{Global, LaunchTicket};

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct RequestLaunch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    #[account(
        init,
        payer = payer,
        space = 8 + LaunchTicket::INIT_SPACE,
        seeds = [SEED_LAUNCH_TICKET, payer.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub ticket: Box<Account<'info, LaunchTicket>>,

    pub system_program: Program<'info, System>,
}

/// `tweet_id`: numeric X/Twitter status ID of the announcement tweet
/// (optional). It is hashed on-chain and locked for 3 days by `create`.
pub fn handler(ctx: Context<RequestLaunch>, nonce: u64, name: String, symbol: String, uri: String, tweet_id: Option<u64>) -> Result<()> {
    let global = &ctx.accounts.global;
    require!(!global.paused, ParabullError::Paused);
    let meta = validate_launch_metadata(&name, &symbol, &uri)?;
    let tweet_hash = tweet_id.map(tweet_id_hash).transpose()?;
    let now = Clock::get()?.unix_timestamp;
    let expires_at = ticket_expiry(now, global.ticket_ttl_seconds)?;
    let deposit = global.ticket_deposit_lamports;
    let launch_fee = global.launch_fee_lamports;

    // Flat price: the payer already funded the ticket's rent via `init`, so
    // top it up to exactly `deposit` in total.
    let ticket_rent = ctx.accounts.ticket.to_account_info().lamports();
    let top_up = deposit_top_up(deposit, ticket_rent)?;
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.ticket.to_account_info(),
            },
        ),
        top_up,
    )?;

    let ticket = &mut ctx.accounts.ticket;
    ticket.bump = ctx.bumps.ticket;
    ticket.payer = ctx.accounts.payer.key();
    ticket.nonce = nonce;
    ticket.deposit_lamports = deposit;
    ticket.launch_fee_lamports = launch_fee;
    ticket.created_at = now;
    ticket.expires_at = expires_at;
    ticket.ticker = meta.ticker.bytes;
    ticket.ticker_len = meta.ticker.len;
    ticket.name_hash = meta.name_hash;
    ticket.metadata_hash = meta.metadata_hash;
    ticket.tweet_id_hash = tweet_hash;

    emit!(LaunchRequested {
        ticket: ticket.key(),
        payer: ticket.payer,
        nonce,
        ticker: symbol,
        name_hash: meta.name_hash,
        metadata_hash: meta.metadata_hash,
        deposit_lamports: deposit,
        expires_at,
        tweet_id_hash: tweet_hash,
    });
    Ok(())
}

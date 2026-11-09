use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::{SEED_GLOBAL, SEED_LAUNCH_TICKET, SEED_TICKER_REGISTRY};
use crate::error::ParabullError;
use crate::events::LaunchRequested;
use crate::launch::{deposit_top_up, registry_claimable, ticket_expiry, tweet_id_hash, validate_launch_metadata};
use crate::state::{Global, LaunchTicket, TickerRegistry};

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

    /// CHECK: the ticker's registry PDA, `["registry", canonical ticker]`. It
    /// may not exist yet (never launched), so it's derived and read in the
    /// handler: a ticket can't be bought for a ticker still in its lock.
    pub ticker_registry: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Whether a ticker registry account (as passed) still holds the ticker at
/// `now`. A registry that doesn't exist, or that only holds lamports someone
/// sent to the address, has no claim.
pub fn ticker_held(registry: &AccountInfo, program_id: &Pubkey, now: i64, lock_seconds: i64) -> Result<bool> {
    if registry.owner != program_id || registry.data_is_empty() {
        return Ok(false);
    }
    let r = TickerRegistry::try_deserialize(&mut &registry.try_borrow_data()?[..])?;
    Ok(!registry_claimable(&r.mint, r.launch_timestamp, now, lock_seconds))
}

/// `tweet_id`: numeric X/Twitter status ID of the announcement tweet
/// (optional). It is hashed on-chain and locked for 3 days by `create`.
pub fn handler(ctx: Context<RequestLaunch>, nonce: u64, name: String, symbol: String, uri: String, tweet_id: Option<u64>) -> Result<()> {
    let global = &ctx.accounts.global;
    require!(!global.paused, ParabullError::Paused);
    let meta = validate_launch_metadata(&name, &symbol, &uri)?;
    let tweet_hash = tweet_id.map(tweet_id_hash).transpose()?;
    let now = Clock::get()?.unix_timestamp;

    // The ticker lock, checked at purchase as well as at `create`: no ticket
    // for a ticker another coin holds (the payer would only be refunded).
    let (expected, _) = Pubkey::find_program_address(&[SEED_TICKER_REGISTRY, meta.ticker.as_seed()], ctx.program_id);
    require_keys_eq!(ctx.accounts.ticker_registry.key(), expected, ParabullError::TickerRegistryMismatch);
    require!(
        !ticker_held(&ctx.accounts.ticker_registry.to_account_info(), ctx.program_id, now, global.registry_lock_seconds)?,
        ParabullError::TickerLocked
    );
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

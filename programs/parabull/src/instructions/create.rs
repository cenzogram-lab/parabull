//! Blind launch: the backend (launch authority) consumes a user's ticket and
//! creates the Token-2022 mint, curve and registry locks in one transaction.
//! Trading opens `Global.trading_open_delay_slots` after this slot, so no one,
//! including the creator, can buy in the creation block.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_2022_extensions::spl_pod::optional_keys::OptionalNonZeroPubkey;
use anchor_spl::token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata;
use anchor_spl::token_2022_extensions::{
    token_metadata_initialize, token_metadata_update_authority, TokenMetadataInitialize, TokenMetadataUpdateAuthority,
};
use anchor_spl::token_interface::spl_token_2022::instruction::AuthorityType;
use anchor_spl::token_interface::{mint_to, set_authority, Mint, MintTo, SetAuthority, TokenAccount};

use crate::constants::*;
use crate::error::ParabullError;
use crate::events::TokenCreated;
use crate::launch::{check_metadata_matches, check_ticket_live, registry_claimable, settle_ticket};
use crate::state::{BondingCurve, Global, LaunchTicket, NameRegistry, TickerRegistry};

#[derive(Accounts)]
pub struct Create<'info> {
    /// Backend signer; pays rent up front and is reimbursed from the ticket.
    #[account(mut, address = global.launch_authority @ ParabullError::Unauthorized)]
    pub launch_authority: Signer<'info>,

    #[account(mut, seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    /// Closed to `payer` at the end of the instruction (returns ticket rent).
    #[account(
        mut,
        close = payer,
        has_one = payer @ ParabullError::Unauthorized,
        seeds = [SEED_LAUNCH_TICKET, payer.key().as_ref(), &ticket.nonce.to_le_bytes()],
        bump = ticket.bump,
    )]
    pub ticket: Box<Account<'info, LaunchTicket>>,

    /// Ticket owner; recorded as the curve's creator.
    #[account(mut)]
    pub payer: SystemAccount<'info>,

    #[account(mut, address = global.treasury @ ParabullError::InvalidAuthority)]
    pub treasury: SystemAccount<'info>,

    /// Fresh server-generated keypair; must sign. Holds no authority after this ix.
    #[account(
        init,
        payer = launch_authority,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = mint_authority,
        mint::token_program = token_program,
        extensions::metadata_pointer::metadata_address = mint,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: PDA used only as a CPI signer for mint/metadata authority.
    #[account(seeds = [SEED_MINT_AUTHORITY], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = launch_authority,
        space = 8 + BondingCurve::INIT_SPACE,
        seeds = [SEED_BONDING_CURVE, mint.key().as_ref()],
        bump,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(
        init,
        payer = launch_authority,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
        associated_token::token_program = token_program,
    )]
    pub curve_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Created on first use; re-claimed only after its 3-day lock lapses.
    #[account(
        init_if_needed,
        payer = launch_authority,
        space = 8 + TickerRegistry::INIT_SPACE,
        seeds = [SEED_TICKER_REGISTRY, ticket.ticker()],
        bump,
    )]
    pub ticker_registry: Box<Account<'info, TickerRegistry>>,

    #[account(
        init_if_needed,
        payer = launch_authority,
        space = 8 + NameRegistry::INIT_SPACE,
        seeds = [SEED_NAME_REGISTRY, ticket.name_hash.as_ref()],
        bump,
    )]
    pub name_registry: Box<Account<'info, NameRegistry>>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Create>, name: String, symbol: String, uri: String) -> Result<()> {
    let clock = Clock::get()?;
    let (now, slot) = (clock.unix_timestamp, clock.slot);

    // ---- Validate --------------------------------------------------------
    {
        let a = &ctx.accounts;
        require!(!a.global.paused, ParabullError::Paused);
        check_ticket_live(a.ticket.expires_at, now)?;
        check_metadata_matches(&name, &symbol, &uri, &a.ticket.metadata_hash)?;
        let lock = a.global.registry_lock_seconds;
        let t = &a.ticker_registry;
        require!(registry_claimable(&t.mint, t.launch_timestamp, now, lock), ParabullError::TickerLocked);
        let n = &a.name_registry;
        require!(registry_claimable(&n.mint, n.launch_timestamp, now, lock), ParabullError::NameLocked);
    }

    let mint_key = ctx.accounts.mint.key();
    let creator = ctx.accounts.payer.key();

    // ---- Claim registries -------------------------------------------------
    {
        let ticket = &ctx.accounts.ticket;
        let t = &mut ctx.accounts.ticker_registry;
        t.bump = ctx.bumps.ticker_registry;
        t.ticker = ticket.ticker;
        t.ticker_len = ticket.ticker_len;
        t.mint = mint_key;
        t.launch_timestamp = now;

        let n = &mut ctx.accounts.name_registry;
        n.bump = ctx.bumps.name_registry;
        n.name_hash = ticket.name_hash;
        n.mint = mint_key;
        n.launch_timestamp = now;
    }

    // ---- Curve --------------------------------------------------------------
    let curve_bump = ctx.bumps.bonding_curve;
    ctx.accounts.bonding_curve.init(curve_bump, mint_key, creator, &ctx.accounts.global, slot, now)?;

    // ---- Token-2022 metadata, supply, authority revocation -----------------
    let auth_bump = [ctx.bumps.mint_authority];
    let signer: &[&[&[u8]]] = &[&[SEED_MINT_AUTHORITY, &auth_bump]];
    initialize_metadata(&ctx, &name, &symbol, &uri, signer)?;
    mint_supply_and_revoke(&ctx, signer)?;

    // ---- Settle the ticket deposit ----------------------------------------
    // Direct lamport moves come after every CPI so the runtime never sees an
    // unbalanced caller state when invoking another program.
    let settlement = settle_ticket(ctx.accounts.ticket.deposit_lamports, ctx.accounts.ticket.launch_fee_lamports)?;
    {
        let a = &ctx.accounts;
        a.ticket.sub_lamports(settlement.to_treasury)?;
        a.treasury.add_lamports(settlement.to_treasury)?;
        a.ticket.sub_lamports(settlement.to_launch_authority)?;
        a.launch_authority.add_lamports(settlement.to_launch_authority)?;
    }

    // ---- Bookkeeping ------------------------------------------------------
    let global = &mut ctx.accounts.global;
    global.launch_count = global.launch_count.checked_add(1).ok_or(ParabullError::Overflow)?;

    let c = &ctx.accounts.bonding_curve;
    emit!(TokenCreated {
        mint: mint_key,
        bonding_curve: c.key(),
        creator,
        ticket: ctx.accounts.ticket.key(),
        name,
        symbol,
        uri,
        created_slot: c.created_slot,
        trading_open_slot: c.trading_open_slot,
        launch_timestamp: c.launch_timestamp,
        virtual_token_reserves: c.virtual_token_reserves,
        virtual_sol_reserves: c.virtual_sol_reserves,
        real_token_reserves: c.real_token_reserves,
        token_total_supply: c.token_total_supply,
        launch_fee_lamports: settlement.to_treasury,
    });
    Ok(())
}

fn initialize_metadata(ctx: &Context<Create>, name: &str, symbol: &str, uri: &str, signer: &[&[&[u8]]]) -> Result<()> {
    let a = &ctx.accounts;
    let metadata = TokenMetadata {
        update_authority: OptionalNonZeroPubkey(a.mint_authority.key()),
        mint: a.mint.key(),
        name: name.to_string(),
        symbol: symbol.to_string(),
        uri: uri.to_string(),
        additional_metadata: vec![],
    };
    // Token-2022 reallocs the mint for the metadata TLV but does not fund it.
    let mint_info = a.mint.to_account_info();
    let needed_len = mint_info.data_len().checked_add(metadata.tlv_size_of()?).ok_or(ParabullError::Overflow)?;
    let top_up = Rent::get()?.minimum_balance(needed_len).saturating_sub(mint_info.lamports());
    if top_up > 0 {
        system_program::transfer(
            CpiContext::new(
                a.system_program.to_account_info(),
                system_program::Transfer { from: a.launch_authority.to_account_info(), to: mint_info.clone() },
            ),
            top_up,
        )?;
    }

    let token_program = a.token_program.to_account_info();
    token_metadata_initialize(
        CpiContext::new_with_signer(
            token_program.clone(),
            TokenMetadataInitialize {
                program_id: token_program.clone(),
                mint: mint_info.clone(),
                metadata: mint_info.clone(),
                mint_authority: a.mint_authority.to_account_info(),
                update_authority: a.mint_authority.to_account_info(),
            },
            signer,
        ),
        name.to_string(),
        symbol.to_string(),
        uri.to_string(),
    )?;

    // Metadata is immutable from here on.
    token_metadata_update_authority(
        CpiContext::new_with_signer(
            token_program.clone(),
            TokenMetadataUpdateAuthority {
                program_id: token_program,
                metadata: mint_info.clone(),
                current_authority: a.mint_authority.to_account_info(),
                new_authority: mint_info,
            },
            signer,
        ),
        OptionalNonZeroPubkey::try_from(None)?,
    )
}

fn mint_supply_and_revoke(ctx: &Context<Create>, signer: &[&[&[u8]]]) -> Result<()> {
    let a = &ctx.accounts;
    mint_to(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            MintTo {
                mint: a.mint.to_account_info(),
                to: a.curve_token_account.to_account_info(),
                authority: a.mint_authority.to_account_info(),
            },
            signer,
        ),
        a.global.token_total_supply,
    )?;
    // Fixed supply: no further minting is possible. (No freeze authority was set.)
    set_authority(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            SetAuthority { account_or_mint: a.mint.to_account_info(), current_authority: a.mint_authority.to_account_info() },
            signer,
        ),
        AuthorityType::MintTokens,
        None,
    )
}

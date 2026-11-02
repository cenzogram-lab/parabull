//! $PARABULL buyback & burn, two instructions sent together in one transaction:
//!
//! 1. `prepare_buyback(amount)` moves SOL out of the BuybackVault data account
//!    (a direct lamport move: the vault holds data, so it can't pay via the
//!    system program) into the system-owned `["buyback-authority"]` PDA. No CPI
//!    follows it in that instruction.
//! 2. `buyback_and_burn(min_amount_out)`, CPIs only, signed by that PDA: wrap
//!    SOL, swap on the configured Raydium CPMM WSOL/$PARABULL pool with the
//!    crank's `min_amount_out`, burn every $PARABULL received, close the
//!    temporary accounts. Received amount is re-checked against
//!    `min_amount_out` after the swap (fail closed).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{sync_native, SyncNative, Token};
use anchor_spl::token_interface::{burn, close_account, Burn, CloseAccount, Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::ParabullError;
use crate::events::{BuybackBurned, BuybackStaged};
use crate::raydium::{cpmm_pool_accounts, sort_pool_mints, CpmmSwapBaseInput, WSOL_MINT};
use crate::state::{vault_spendable, BuybackVault, Global};

#[derive(Accounts)]
pub struct PrepareBuyback<'info> {
    #[account(address = global.crank_authority @ ParabullError::Unauthorized)]
    pub crank: Signer<'info>,

    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    #[account(mut, seeds = [SEED_BUYBACK_VAULT], bump = buyback_vault.bump)]
    pub buyback_vault: Box<Account<'info, BuybackVault>>,

    #[account(mut, seeds = [SEED_BUYBACK_AUTHORITY], bump)]
    pub buyback_authority: SystemAccount<'info>,
}

pub fn prepare_handler(mut ctx: Context<PrepareBuyback>, amount: u64) -> Result<()> {
    let a = &mut ctx.accounts;
    require!(!a.global.paused, ParabullError::Paused);
    require!(a.global.parabull_pool != Pubkey::default(), ParabullError::BuybackNotConfigured);
    require!(amount > 0, ParabullError::ZeroAmount);
    let info = a.buyback_vault.to_account_info();
    let rent = Rent::get()?.minimum_balance(info.data_len());
    require!(amount <= vault_spendable(info.lamports(), rent), ParabullError::InsufficientVaultBalance);

    // No CPI in this instruction: the direct lamport move is the only transfer.
    a.buyback_vault.sub_lamports(amount)?;
    a.buyback_authority.add_lamports(amount)?;
    let v = &mut a.buyback_vault;
    v.total_spent_lamports = v.total_spent_lamports.checked_add(amount).ok_or(ParabullError::Overflow)?;
    emit!(BuybackStaged { amount, vault_remaining: a.buyback_vault.to_account_info().lamports() });
    Ok(())
}

#[derive(Accounts)]
pub struct BuybackAndBurn<'info> {
    /// Funds the temporary token accounts; refunded when they close.
    #[account(mut, address = global.crank_authority @ ParabullError::Unauthorized)]
    pub crank: Signer<'info>,

    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    #[account(mut, seeds = [SEED_BUYBACK_VAULT], bump = buyback_vault.bump)]
    pub buyback_vault: Box<Account<'info, BuybackVault>>,

    #[account(mut, seeds = [SEED_BUYBACK_AUTHORITY], bump)]
    pub buyback_authority: SystemAccount<'info>,

    #[account(mut, address = global.parabull_mint @ ParabullError::InvalidMigrationAccount, mint::token_program = parabull_token_program)]
    pub parabull_mint: Box<InterfaceAccount<'info, Mint>>,
    pub parabull_token_program: Interface<'info, TokenInterface>,

    #[account(
        init_if_needed,
        payer = crank,
        associated_token::mint = parabull_mint,
        associated_token::authority = buyback_authority,
        associated_token::token_program = parabull_token_program,
    )]
    pub authority_parabull_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = crank,
        associated_token::mint = wsol_mint,
        associated_token::authority = buyback_authority,
        associated_token::token_program = token_program,
    )]
    pub authority_wsol_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: configured CPMM program.
    #[account(address = global.cpmm_program @ ParabullError::InvalidMigrationAccount, executable)]
    pub cpmm_program: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    pub cpmm_authority: UncheckedAccount<'info>,
    /// CHECK: owned by CPMM; CPMM itself enforces it is the pool's config.
    #[account(owner = cpmm_program.key() @ ParabullError::InvalidMigrationAccount)]
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: the configured $PARABULL pool.
    #[account(mut, address = global.parabull_pool @ ParabullError::BuybackNotConfigured)]
    pub pool_state: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub wsol_vault: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub parabull_vault: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn buyback_handler(mut ctx: Context<BuybackAndBurn>, min_amount_out: u64) -> Result<()> {
    let bump = [ctx.bumps.buyback_authority];
    let a = &mut ctx.accounts;
    require!(!a.global.paused, ParabullError::Paused);
    require!(min_amount_out > 0, ParabullError::SlippageExceeded);

    let parabull = a.parabull_mint.key();
    let order = sort_pool_mints(&parabull, &WSOL_MINT)?;
    let pool = cpmm_pool_accounts(&a.cpmm_program.key(), &a.pool_state.key(), &order, &a.buyback_authority.key());
    let (wsol_vault, parabull_vault) = if order.mint_is_token_0 {
        (pool.token_1_vault, pool.token_0_vault)
    } else {
        (pool.token_0_vault, pool.token_1_vault)
    };
    for (passed, expected) in [
        (a.cpmm_authority.key(), pool.authority),
        (a.wsol_vault.key(), wsol_vault),
        (a.parabull_vault.key(), parabull_vault),
        (a.observation_state.key(), pool.observation_state),
    ] {
        require_keys_eq!(passed, expected, ParabullError::InvalidMigrationAccount);
    }

    let amount_in = a.buyback_authority.lamports();
    require!(amount_in > 0, ParabullError::ZeroAmount);
    let signer: &[&[&[u8]]] = &[&[SEED_BUYBACK_AUTHORITY, &bump]];

    // Wrap all staged SOL.
    system_program::transfer(
        CpiContext::new_with_signer(
            a.system_program.to_account_info(),
            system_program::Transfer { from: a.buyback_authority.to_account_info(), to: a.authority_wsol_account.to_account_info() },
            signer,
        ),
        amount_in,
    )?;
    sync_native(CpiContext::new(a.token_program.to_account_info(), SyncNative { account: a.authority_wsol_account.to_account_info() }))?;

    // Swap WSOL -> $PARABULL with the crank's slippage floor.
    let before = a.authority_parabull_account.amount;
    let ix = CpmmSwapBaseInput {
        program: a.cpmm_program.key(),
        payer: a.buyback_authority.key(),
        authority: pool.authority,
        amm_config: a.amm_config.key(),
        pool_state: a.pool_state.key(),
        input_token_account: a.authority_wsol_account.key(),
        output_token_account: a.authority_parabull_account.key(),
        input_vault: wsol_vault,
        output_vault: parabull_vault,
        input_token_program: a.token_program.key(),
        output_token_program: a.parabull_token_program.key(),
        input_token_mint: WSOL_MINT,
        output_token_mint: parabull,
        observation_state: pool.observation_state,
        amount_in,
        minimum_amount_out: min_amount_out,
    }
    .instruction();
    invoke_signed(
        &ix,
        &[
            a.buyback_authority.to_account_info(),
            a.cpmm_authority.to_account_info(),
            a.amm_config.to_account_info(),
            a.pool_state.to_account_info(),
            a.authority_wsol_account.to_account_info(),
            a.authority_parabull_account.to_account_info(),
            a.wsol_vault.to_account_info(),
            a.parabull_vault.to_account_info(),
            a.token_program.to_account_info(),
            a.parabull_token_program.to_account_info(),
            a.wsol_mint.to_account_info(),
            a.parabull_mint.to_account_info(),
            a.observation_state.to_account_info(),
            a.cpmm_program.to_account_info(),
        ],
        signer,
    )?;
    a.authority_parabull_account.reload()?;
    let received = a.authority_parabull_account.amount.checked_sub(before).ok_or(ParabullError::Overflow)?;
    require!(received >= min_amount_out, ParabullError::SlippageExceeded);

    // Burn everything in the account (received + anything donated), then close both temp accounts.
    let burned = a.authority_parabull_account.amount;
    burn(
        CpiContext::new_with_signer(
            a.parabull_token_program.to_account_info(),
            Burn { mint: a.parabull_mint.to_account_info(), from: a.authority_parabull_account.to_account_info(), authority: a.buyback_authority.to_account_info() },
            signer,
        ),
        burned,
    )?;
    close_account(CpiContext::new_with_signer(
        a.parabull_token_program.to_account_info(),
        CloseAccount { account: a.authority_parabull_account.to_account_info(), destination: a.crank.to_account_info(), authority: a.buyback_authority.to_account_info() },
        signer,
    ))?;
    close_account(CpiContext::new_with_signer(
        a.token_program.to_account_info(),
        CloseAccount { account: a.authority_wsol_account.to_account_info(), destination: a.crank.to_account_info(), authority: a.buyback_authority.to_account_info() },
        signer,
    ))?;

    let v = &mut a.buyback_vault;
    v.total_tokens_burned = v.total_tokens_burned.checked_add(burned).ok_or(ParabullError::Overflow)?;
    v.buyback_count = v.buyback_count.checked_add(1).ok_or(ParabullError::Overflow)?;
    v.last_buyback_at = Clock::get()?.unix_timestamp;
    emit!(BuybackBurned { parabull_mint: parabull, pool: a.pool_state.key(), sol_in: amount_in, tokens_burned: burned, min_amount_out });
    Ok(())
}

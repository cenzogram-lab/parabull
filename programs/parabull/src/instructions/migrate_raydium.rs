//! Graduation step 2/3: create the Raydium CPMM pool. CPIs only.
//!
//! The migration-authority PDA is the CPMM `creator`: it pays the pool fee and
//! rent out of the reserve, provides both sides of liquidity and receives the
//! LP tokens (locked in step 3). Every Raydium account is re-derived here, so
//! the crank cannot point the migration at a different pool or config.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{sync_native, SyncNative, Token};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{close_account, CloseAccount, Mint, TokenAccount};

use crate::constants::*;
use crate::error::ParabullError;
use crate::events::MigratedToRaydium;
use crate::raydium::{cpmm_accounts, sort_pool_mints, CpmmInitialize, WSOL_MINT};
use crate::state::{BondingCurve, Global, MigrationStage};

#[derive(Accounts)]
pub struct MigrateRaydium<'info> {
    #[account(mut, address = global.crank_authority @ ParabullError::Unauthorized)]
    pub crank: Signer<'info>,

    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    #[account(mint::token_program = token_2022_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [SEED_BONDING_CURVE, mint.key().as_ref()], bump = bonding_curve.bump)]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(mut, seeds = [SEED_MIGRATION_AUTHORITY, mint.key().as_ref()], bump)]
    pub migration_authority: SystemAccount<'info>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = migration_authority,
        associated_token::token_program = token_2022_program,
    )]
    pub authority_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = crank,
        associated_token::mint = wsol_mint,
        associated_token::authority = migration_authority,
        associated_token::token_program = token_program,
    )]
    pub authority_wsol_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: must be the configured CPMM program.
    #[account(address = global.cpmm_program @ ParabullError::InvalidMigrationAccount, executable)]
    pub cpmm_program: UncheckedAccount<'info>,
    /// CHECK: configured AmmConfig, owned by the CPMM program.
    #[account(address = global.cpmm_amm_config @ ParabullError::InvalidMigrationAccount, owner = cpmm_program.key() @ ParabullError::InvalidMigrationAccount)]
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    pub cpmm_authority: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler (canonical PDA, never a keypair).
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub creator_lp_token: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub token_0_vault: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub token_1_vault: UncheckedAccount<'info>,
    /// CHECK: CPMM enforces its own fee-receiver address.
    #[account(mut)]
    pub create_pool_fee: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(mut ctx: Context<MigrateRaydium>) -> Result<()> {
    let bump = [ctx.bumps.migration_authority];
    let a = &mut ctx.accounts;
    let c = &a.bonding_curve;
    require!(c.stage() == MigrationStage::Prepared, ParabullError::InvalidMigrationStage);

    let mint_key = a.mint.key();
    let order = sort_pool_mints(&mint_key, &WSOL_MINT)?;
    let creator = a.migration_authority.key();
    let derived = cpmm_accounts(&a.cpmm_program.key(), &a.amm_config.key(), &order, &creator);
    for (passed, expected) in [
        (a.cpmm_authority.key(), derived.authority),
        (a.pool_state.key(), derived.pool_state),
        (a.lp_mint.key(), derived.lp_mint),
        (a.creator_lp_token.key(), derived.creator_lp_token),
        (a.token_0_vault.key(), derived.token_0_vault),
        (a.token_1_vault.key(), derived.token_1_vault),
        (a.observation_state.key(), derived.observation_state),
    ] {
        require_keys_eq!(passed, expected, ParabullError::InvalidMigrationAccount);
    }

    let (min_sol, min_tokens) = (c.migration_sol, c.migration_tokens);
    let signer: &[&[&[u8]]] = &[&[SEED_MIGRATION_AUTHORITY, mint_key.as_ref(), &bump]];

    // Wrap the pool SOL.
    system_program::transfer(
        CpiContext::new_with_signer(
            a.system_program.to_account_info(),
            system_program::Transfer {
                from: a.migration_authority.to_account_info(),
                to: a.authority_wsol_account.to_account_info(),
            },
            signer,
        ),
        min_sol,
    )?;
    sync_native(CpiContext::new(a.token_program.to_account_info(), SyncNative { account: a.authority_wsol_account.to_account_info() }))?;

    // Seed the pool with the full balances, never less than what step 1 moved.
    // Anyone can send tokens/WSOL to these ATAs; using balances (instead of
    // requiring exact amounts) means a donation can't block migration.
    a.authority_token_account.reload()?;
    a.authority_wsol_account.reload()?;
    let tokens = a.authority_token_account.amount;
    let sol = a.authority_wsol_account.amount;
    require!(tokens >= min_tokens && sol >= min_sol, ParabullError::InsufficientReserves);

    // CPMM initialize, migration authority signing as creator.
    let (creator_token_0, creator_token_1) = if order.mint_is_token_0 {
        (a.authority_token_account.key(), a.authority_wsol_account.key())
    } else {
        (a.authority_wsol_account.key(), a.authority_token_account.key())
    };
    let (init_amount_0, init_amount_1) = order.amounts(tokens, sol);
    let ix = CpmmInitialize {
        program: a.cpmm_program.key(),
        creator,
        amm_config: a.amm_config.key(),
        order,
        accounts: derived,
        creator_token_0,
        creator_token_1,
        create_pool_fee: a.create_pool_fee.key(),
        init_amount_0,
        init_amount_1,
        open_time: 0, // CPMM opens at now + 1
    }
    .instruction();
    let (mint_0, mint_1) = if order.mint_is_token_0 {
        (a.mint.to_account_info(), a.wsol_mint.to_account_info())
    } else {
        (a.wsol_mint.to_account_info(), a.mint.to_account_info())
    };
    let (prog_0, prog_1) = if order.mint_is_token_0 {
        (a.token_2022_program.to_account_info(), a.token_program.to_account_info())
    } else {
        (a.token_program.to_account_info(), a.token_2022_program.to_account_info())
    };
    invoke_signed(
        &ix,
        &[
            a.migration_authority.to_account_info(),
            a.amm_config.to_account_info(),
            a.cpmm_authority.to_account_info(),
            a.pool_state.to_account_info(),
            mint_0,
            mint_1,
            a.lp_mint.to_account_info(),
            a.authority_token_account.to_account_info(),
            a.authority_wsol_account.to_account_info(),
            a.creator_lp_token.to_account_info(),
            a.token_0_vault.to_account_info(),
            a.token_1_vault.to_account_info(),
            a.create_pool_fee.to_account_info(),
            a.observation_state.to_account_info(),
            a.token_program.to_account_info(),
            prog_0,
            prog_1,
            a.associated_token_program.to_account_info(),
            a.system_program.to_account_info(),
            a.rent.to_account_info(),
            a.cpmm_program.to_account_info(),
        ],
        signer,
    )?;

    // Both source accounts must now be empty; closing them proves CPMM took
    // exactly the amounts we passed, and returns the ATA rent to the crank.
    close_account(CpiContext::new_with_signer(
        a.token_2022_program.to_account_info(),
        CloseAccount {
            account: a.authority_token_account.to_account_info(),
            destination: a.crank.to_account_info(),
            authority: a.migration_authority.to_account_info(),
        },
        signer,
    ))?;
    close_account(CpiContext::new_with_signer(
        a.token_program.to_account_info(),
        CloseAccount {
            account: a.authority_wsol_account.to_account_info(),
            destination: a.crank.to_account_info(),
            authority: a.migration_authority.to_account_info(),
        },
        signer,
    ))?;

    let pool = a.pool_state.key();
    let lp_mint = a.lp_mint.key();
    let c = &mut a.bonding_curve;
    c.migration_sol = sol;
    c.migration_tokens = tokens;
    c.migration_stage = MigrationStage::PoolCreated as u8;
    c.migrated = true;
    c.raydium_pool = pool;

    emit!(MigratedToRaydium {
        mint: mint_key,
        pool,
        lp_mint,
        token_0: order.token_0,
        token_1: order.token_1,
        tokens_to_pool: tokens,
        sol_to_pool: sol,
        slot: Clock::get()?.slot,
    });
    Ok(())
}

//! Graduation step 1/3: move the curve's migration tokens and SOL to the
//! migration-authority PDA (system-owned, so it can act as the Raydium CPMM
//! pool creator and payer). The lamport move is the last action, after the
//! token CPIs, so step 2 can be pure CPIs.
//!
//! Only the curve's *tracked* tokens are priced and moved. Anyone can send
//! tokens to the curve's public ATA; such a surplus is burned here, so it can
//! neither fail the price check (blocking graduation) nor misprice the pool.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{burn, transfer_checked, Burn, Mint, TokenAccount, TransferChecked};

use crate::constants::*;
use crate::error::ParabullError;
use crate::events::MigrationPrepared;
use crate::raydium::{migration_split, pool_price_within, split_surplus, tracked_curve_tokens};
use crate::state::{BondingCurve, Global, MigrationStage};
use crate::trade::assert_curve_backed;

#[derive(Accounts)]
pub struct PrepareMigration<'info> {
    #[account(mut, address = global.crank_authority @ ParabullError::Unauthorized)]
    pub crank: Signer<'info>,

    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    /// Writable: unsolicited surplus tokens are burned.
    #[account(mut, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [SEED_BONDING_CURVE, mint.key().as_ref()], bump = bonding_curve.bump)]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
        associated_token::token_program = token_program,
    )]
    pub curve_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, seeds = [SEED_MIGRATION_AUTHORITY, mint.key().as_ref()], bump)]
    pub migration_authority: SystemAccount<'info>,

    /// Becomes CPMM's `creator_token_*` for the launched mint.
    #[account(
        init_if_needed,
        payer = crank,
        associated_token::mint = mint,
        associated_token::authority = migration_authority,
        associated_token::token_program = token_program,
    )]
    pub authority_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(mut ctx: Context<PrepareMigration>) -> Result<()> {
    let a = &mut ctx.accounts;
    let c = &a.bonding_curve;
    require!(c.complete, ParabullError::CurveNotComplete);
    require!(c.stage() == MigrationStage::None, ParabullError::InvalidMigrationStage);

    let real_sol = c.real_sol_reserves;
    let split = migration_split(real_sol, a.global.migration_reserve_lamports)?;
    let tracked = tracked_curve_tokens(c.token_total_supply, a.global.initial_real_token_reserves, c.real_token_reserves)?;
    let (tokens, surplus) = split_surplus(a.curve_token_account.amount, tracked)?;
    require!(tokens > 0, ParabullError::InsufficientReserves);
    require!(
        pool_price_within(split.sol_to_pool, tokens, c.virtual_sol_reserves, c.virtual_token_reserves, MAX_MIGRATION_PRICE_DISCOUNT_BPS),
        ParabullError::MigrationPriceOutOfRange
    );

    // Tokens: curve ATA -> migration authority ATA (curve PDA signs).
    let mint_key = a.mint.key();
    let bump = [c.bump];
    let signer: &[&[&[u8]]] = &[&[SEED_BONDING_CURVE, mint_key.as_ref(), &bump]];
    if surplus > 0 {
        burn(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                Burn { mint: a.mint.to_account_info(), from: a.curve_token_account.to_account_info(), authority: a.bonding_curve.to_account_info() },
                signer,
            ),
            surplus,
        )?;
    }
    transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            TransferChecked {
                from: a.curve_token_account.to_account_info(),
                mint: a.mint.to_account_info(),
                to: a.authority_token_account.to_account_info(),
                authority: a.bonding_curve.to_account_info(),
            },
            signer,
        ),
        tokens,
        a.mint.decimals,
    )?;

    // SOL: all real reserves (pool SOL + reserve) -> migration authority. Last action.
    a.bonding_curve.sub_lamports(real_sol)?;
    a.migration_authority.add_lamports(real_sol)?;

    let c = &mut a.bonding_curve;
    c.real_sol_reserves = 0;
    c.migration_sol = split.sol_to_pool;
    c.migration_tokens = tokens;
    c.migration_stage = MigrationStage::Prepared as u8;
    assert_curve_backed(c)?;

    emit!(MigrationPrepared {
        mint: mint_key,
        migration_authority: a.migration_authority.key(),
        sol_to_pool: split.sol_to_pool,
        sol_reserve: split.reserve,
        tokens_to_pool: tokens,
        surplus_tokens_burned: surplus,
        slot: Clock::get()?.slot,
    });
    Ok(())
}

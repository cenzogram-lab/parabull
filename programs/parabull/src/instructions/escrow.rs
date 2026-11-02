//! DexScreener escrow: permissionless top-up (any source of protocol fees,
//! e.g. collected Raydium LP fees, before or after graduation) and release to
//! the treasury once funded. Release is permissionless: funds can only go to
//! `Global.treasury`.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::error::ParabullError;
use crate::events::{DexEscrowReleased, DexEscrowToppedUp};
use crate::flywheel::{apply_escrow_top_up, escrow_top_up_amount, release_escrow};
use crate::state::{BondingCurve, Global};
use crate::trade::assert_curve_backed;

#[derive(Accounts)]
pub struct TopUpDexEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    /// CHECK: only used to derive the curve PDA.
    pub mint: UncheckedAccount<'info>,

    #[account(mut, seeds = [SEED_BONDING_CURVE, mint.key().as_ref()], bump = bonding_curve.bump)]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    pub system_program: Program<'info, System>,
}

pub fn top_up_handler(mut ctx: Context<TopUpDexEscrow>, amount: u64) -> Result<()> {
    let a = &mut ctx.accounts;
    let target = a.global.dex_target_lamports;
    let accepted = escrow_top_up_amount(&a.bonding_curve, target, amount)?;
    system_program::transfer(
        CpiContext::new(
            a.system_program.to_account_info(),
            system_program::Transfer { from: a.payer.to_account_info(), to: a.bonding_curve.to_account_info() },
        ),
        accepted,
    )?;
    apply_escrow_top_up(&mut a.bonding_curve, accepted)?;
    assert_curve_backed(&a.bonding_curve)?;
    emit!(DexEscrowToppedUp {
        mint: a.mint.key(),
        payer: a.payer.key(),
        accepted,
        escrow_accrued: a.bonding_curve.escrow_accrued,
        target,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ReleaseDexEscrow<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    /// CHECK: only used to derive the curve PDA.
    pub mint: UncheckedAccount<'info>,

    #[account(mut, seeds = [SEED_BONDING_CURVE, mint.key().as_ref()], bump = bonding_curve.bump)]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(mut, address = global.treasury @ ParabullError::InvalidAuthority)]
    pub treasury: SystemAccount<'info>,
}

pub fn release_handler(mut ctx: Context<ReleaseDexEscrow>) -> Result<()> {
    let a = &mut ctx.accounts;
    let r = release_escrow(&mut a.bonding_curve, a.global.dex_target_lamports)?;
    // No CPIs in this instruction: direct lamport moves are safe here.
    a.bonding_curve.sub_lamports(r.to_treasury)?;
    a.treasury.add_lamports(r.to_treasury)?;
    assert_curve_backed(&a.bonding_curve)?;
    emit!(DexEscrowReleased {
        mint: a.mint.key(),
        treasury: a.treasury.key(),
        amount: r.to_treasury,
        excess_to_buyback: r.excess_to_buyback,
    });
    Ok(())
}

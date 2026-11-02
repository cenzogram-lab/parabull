//! Permissionless sweep of a curve's buyback / holder / treasury buckets into
//! the protocol vaults. The DexScreener escrow is never swept.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ParabullError;
use crate::events::FeesSwept;
use crate::flywheel::take_sweepable_fees;
use crate::state::{BondingCurve, BuybackVault, Global, HolderRewardVault};
use crate::trade::assert_curve_backed;

#[derive(Accounts)]
pub struct SweepFees<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    /// CHECK: only used to derive the curve PDA.
    pub mint: UncheckedAccount<'info>,

    #[account(mut, seeds = [SEED_BONDING_CURVE, mint.key().as_ref()], bump = bonding_curve.bump)]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(mut, seeds = [SEED_BUYBACK_VAULT], bump = buyback_vault.bump)]
    pub buyback_vault: Box<Account<'info, BuybackVault>>,

    #[account(mut, seeds = [SEED_HOLDER_VAULT], bump = holder_vault.bump)]
    pub holder_vault: Box<Account<'info, HolderRewardVault>>,

    #[account(mut, address = global.treasury @ ParabullError::InvalidAuthority)]
    pub treasury: SystemAccount<'info>,
}

pub fn handler(mut ctx: Context<SweepFees>) -> Result<()> {
    let a = &mut ctx.accounts;
    let s = take_sweepable_fees(&mut a.bonding_curve);
    // No CPIs in this instruction: direct lamport moves are safe here.
    a.bonding_curve.sub_lamports(s.total()?)?;
    a.buyback_vault.add_lamports(s.to_buyback_vault)?;
    a.holder_vault.add_lamports(s.to_holder_vault)?;
    a.treasury.add_lamports(s.to_treasury)?;

    let bv = &mut a.buyback_vault;
    bv.total_deposited_lamports = bv.total_deposited_lamports.checked_add(s.to_buyback_vault).ok_or(ParabullError::Overflow)?;
    let hv = &mut a.holder_vault;
    hv.total_deposited_lamports = hv.total_deposited_lamports.checked_add(s.to_holder_vault).ok_or(ParabullError::Overflow)?;

    assert_curve_backed(&a.bonding_curve)?;
    emit!(FeesSwept {
        mint: a.mint.key(),
        to_buyback_vault: s.to_buyback_vault,
        to_holder_vault: s.to_holder_vault,
        to_treasury: s.to_treasury,
    });
    Ok(())
}

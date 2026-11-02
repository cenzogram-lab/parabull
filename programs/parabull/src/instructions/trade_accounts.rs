use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};

use crate::constants::*;
use crate::error::ParabullError;
use crate::events::{GraduationReady, TradeEvent};
use crate::math::FeeSplit;
use crate::state::{BondingCurve, Global};
use crate::trade::required_curve_lamports;

/// Shared by `buy` and `sell`. The curve PDA is derived from `mint`, so a
/// mismatched mint/curve pair cannot be passed.
#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [SEED_BONDING_CURVE, mint.key().as_ref()],
        bump = bonding_curve.bump,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
        associated_token::token_program = token_program,
    )]
    pub curve_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> Trade<'info> {
    /// Curve -> user token transfer, signed by the curve PDA.
    pub fn send_tokens_to_user(&self, amount: u64) -> Result<()> {
        let mint_key = self.mint.key();
        let bump = [self.bonding_curve.bump];
        let signer: &[&[&[u8]]] = &[&[SEED_BONDING_CURVE, mint_key.as_ref(), &bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                self.token_program.to_account_info(),
                TransferChecked {
                    from: self.curve_token_account.to_account_info(),
                    mint: self.mint.to_account_info(),
                    to: self.user_token_account.to_account_info(),
                    authority: self.bonding_curve.to_account_info(),
                },
                signer,
            ),
            amount,
            self.mint.decimals,
        )
    }

    /// User -> curve token transfer, signed by the user.
    pub fn take_tokens_from_user(&self, amount: u64) -> Result<()> {
        transfer_checked(
            CpiContext::new(
                self.token_program.to_account_info(),
                TransferChecked {
                    from: self.user_token_account.to_account_info(),
                    mint: self.mint.to_account_info(),
                    to: self.curve_token_account.to_account_info(),
                    authority: self.user.to_account_info(),
                },
            ),
            amount,
            self.mint.decimals,
        )
    }

    /// Fail closed if the curve's lamports no longer back its reserves + buckets.
    pub fn assert_lamport_invariant(&self) -> Result<()> {
        let info = self.bonding_curve.to_account_info();
        let rent = Rent::get()?.minimum_balance(info.data_len());
        require!(
            info.lamports() >= required_curve_lamports(&self.bonding_curve, rent)?,
            ParabullError::LamportInvariantViolated
        );
        Ok(())
    }

    pub fn emit_trade(&self, is_buy: bool, token_amount: u64, sol_amount: u64, fee: u64, split: FeeSplit, clock: &Clock) {
        let c = &self.bonding_curve;
        emit!(TradeEvent {
            mint: c.mint,
            user: self.user.key(),
            is_buy,
            token_amount,
            sol_amount,
            fee,
            fee_to_escrow: split.escrow,
            fee_to_buyback: split.buyback,
            fee_to_holders: split.holder,
            fee_to_treasury: split.treasury,
            virtual_token_reserves: c.virtual_token_reserves,
            virtual_sol_reserves: c.virtual_sol_reserves,
            real_token_reserves: c.real_token_reserves,
            real_sol_reserves: c.real_sol_reserves,
            slot: clock.slot,
            timestamp: clock.unix_timestamp,
        });
    }

    pub fn emit_graduation(&self, clock: &Clock) {
        let c = &self.bonding_curve;
        emit!(GraduationReady {
            mint: c.mint,
            bonding_curve: c.key(),
            real_sol_reserves: c.real_sol_reserves,
            virtual_token_reserves: c.virtual_token_reserves,
            virtual_sol_reserves: c.virtual_sol_reserves,
            escrow_accrued: c.escrow_accrued,
            escrow_funded: c.is_escrow_funded(&self.global),
            slot: clock.slot,
            timestamp: clock.unix_timestamp,
        });
    }
}

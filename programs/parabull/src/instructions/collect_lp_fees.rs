//! Harvest post-graduation trading fees from the Burn & Earn locked LP.
//!
//! The fee-key vault PDA (owner of the fee-key NFT) signs `collect_cp_fees`;
//! Raydium pays both pool tokens to vault-owned token accounts. The program
//! never trusts the crank-supplied `fee_lp_amount` for accounting: it routes
//! only the measured balance increases.
//! - SOL side: unwrapped, then the token's DexScreener escrow is filled first
//!   (if still open), the rest goes directly to BuybackVault / HolderRewardVault
//!   by the global split, remainder to the treasury.
//! - Launched-token side: burned immediately (Token-2022 burn signed by the
//!   vault), then the temporary token account is closed: the protocol never
//!   holds launched tokens.
//! Every lamport move is a CPI (token close / system transfer).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{burn, close_account, Burn, CloseAccount, Mint, TokenAccount};

use crate::constants::*;
use crate::error::ParabullError;
use crate::events::LpFeesCollected;
use crate::flywheel::route_harvested_sol;
use crate::raydium::{cpmm_pool_accounts, lock_accounts, sort_pool_mints, CollectCpFees, MEMO_PROGRAM_ID, WSOL_MINT};
use crate::state::{BondingCurve, BuybackVault, Global, HolderRewardVault, MigrationStage};
use crate::trade::assert_curve_backed;

#[derive(Accounts)]
pub struct CollectLpFees<'info> {
    /// Pays the temporary WSOL account's rent; refunded in the same instruction.
    #[account(mut, address = global.crank_authority @ ParabullError::Unauthorized)]
    pub crank: Signer<'info>,

    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    /// Writable: burning the collected tokens reduces the mint's supply.
    #[account(mut, mint::token_program = token_2022_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [SEED_BONDING_CURVE, mint.key().as_ref()], bump = bonding_curve.bump)]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(mut, seeds = [SEED_FEE_KEY_VAULT], bump)]
    pub fee_key_vault: SystemAccount<'info>,

    /// Receives the launched-token side; burned and closed before the instruction ends.
    #[account(
        init_if_needed,
        payer = crank,
        associated_token::mint = mint,
        associated_token::authority = fee_key_vault,
        associated_token::token_program = token_2022_program,
    )]
    pub fee_vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Temporary WSOL receiver; closed (unwrapped) before the instruction ends.
    #[account(
        init_if_needed,
        payer = crank,
        associated_token::mint = wsol_mint,
        associated_token::authority = fee_key_vault,
        associated_token::token_program = token_program,
    )]
    pub fee_vault_wsol_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, seeds = [SEED_BUYBACK_VAULT], bump = buyback_vault.bump)]
    pub buyback_vault: Box<Account<'info, BuybackVault>>,
    #[account(mut, seeds = [SEED_HOLDER_VAULT], bump = holder_vault.bump)]
    pub holder_vault: Box<Account<'info, HolderRewardVault>>,
    #[account(mut, address = global.treasury @ ParabullError::InvalidAuthority)]
    pub treasury: SystemAccount<'info>,

    /// CHECK: configured Burn & Earn program.
    #[account(address = global.lp_lock_program @ ParabullError::InvalidMigrationAccount, executable)]
    pub lp_lock_program: UncheckedAccount<'info>,
    /// CHECK: configured Burn & Earn authority.
    #[account(address = global.lp_lock_authority @ ParabullError::InvalidMigrationAccount)]
    pub lp_lock_authority: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub fee_nft_account: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub locked_liquidity: UncheckedAccount<'info>,
    /// CHECK: configured CPMM program.
    #[account(address = global.cpmm_program @ ParabullError::InvalidMigrationAccount, executable)]
    pub cpmm_program: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    pub cpmm_authority: UncheckedAccount<'info>,
    /// CHECK: the pool recorded at migration.
    #[account(mut, address = bonding_curve.raydium_pool @ ParabullError::InvalidMigrationAccount)]
    pub pool_state: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub token_0_vault: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub token_1_vault: UncheckedAccount<'info>,
    /// CHECK: derived and compared in the handler.
    #[account(mut)]
    pub lock_lp_vault: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    /// CHECK: SPL Memo program.
    #[account(address = MEMO_PROGRAM_ID)]
    pub memo_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(mut ctx: Context<CollectLpFees>, fee_lp_amount: u64) -> Result<()> {
    let vault_bump = [ctx.bumps.fee_key_vault];
    let a = &mut ctx.accounts;
    require!(a.bonding_curve.stage() == MigrationStage::LpLocked, ParabullError::InvalidMigrationStage);
    require!(fee_lp_amount > 0, ParabullError::ZeroAmount);

    let mint_key = a.mint.key();
    let order = sort_pool_mints(&mint_key, &WSOL_MINT)?;
    let creator = Pubkey::find_program_address(&[SEED_MIGRATION_AUTHORITY, mint_key.as_ref()], &crate::ID).0;
    let pool = cpmm_pool_accounts(&a.cpmm_program.key(), &a.bonding_curve.raydium_pool, &order, &creator);
    let lock = lock_accounts(&a.lp_lock_program.key(), &a.lp_lock_authority.key(), &a.bonding_curve.fee_nft_mint, &a.fee_key_vault.key(), &pool.lp_mint);
    for (passed, expected) in [
        (a.cpmm_authority.key(), pool.authority),
        (a.lp_mint.key(), pool.lp_mint),
        (a.token_0_vault.key(), pool.token_0_vault),
        (a.token_1_vault.key(), pool.token_1_vault),
        (a.fee_nft_account.key(), lock.fee_nft_account),
        (a.locked_liquidity.key(), lock.locked_liquidity),
        (a.lock_lp_vault.key(), lock.lock_lp_vault),
    ] {
        require_keys_eq!(passed, expected, ParabullError::InvalidMigrationAccount);
    }

    let tokens_before = a.fee_vault_token_account.amount;
    let wsol_before = a.fee_vault_wsol_account.amount;
    let (recipient_0, recipient_1) = if order.mint_is_token_0 {
        (a.fee_vault_token_account.to_account_info(), a.fee_vault_wsol_account.to_account_info())
    } else {
        (a.fee_vault_wsol_account.to_account_info(), a.fee_vault_token_account.to_account_info())
    };
    let (mint_0, mint_1) = if order.mint_is_token_0 {
        (a.mint.to_account_info(), a.wsol_mint.to_account_info())
    } else {
        (a.wsol_mint.to_account_info(), a.mint.to_account_info())
    };
    let signer: &[&[&[u8]]] = &[&[SEED_FEE_KEY_VAULT, &vault_bump]];

    let ix = CollectCpFees {
        program: a.lp_lock_program.key(),
        authority: a.lp_lock_authority.key(),
        fee_nft_owner: a.fee_key_vault.key(),
        fee_nft_account: lock.fee_nft_account,
        locked_liquidity: lock.locked_liquidity,
        cpmm_program: a.cpmm_program.key(),
        cpmm_authority: pool.authority,
        pool_state: pool.pool_state,
        lp_mint: pool.lp_mint,
        recipient_token_0: recipient_0.key(),
        recipient_token_1: recipient_1.key(),
        token_0_vault: pool.token_0_vault,
        token_1_vault: pool.token_1_vault,
        token_0_mint: order.token_0,
        token_1_mint: order.token_1,
        lock_lp_vault: lock.lock_lp_vault,
        fee_lp_amount,
    }
    .instruction();
    invoke_signed(
        &ix,
        &[
            a.lp_lock_authority.to_account_info(),
            a.fee_key_vault.to_account_info(),
            a.fee_nft_account.to_account_info(),
            a.locked_liquidity.to_account_info(),
            a.cpmm_program.to_account_info(),
            a.cpmm_authority.to_account_info(),
            a.pool_state.to_account_info(),
            a.lp_mint.to_account_info(),
            recipient_0,
            recipient_1,
            a.token_0_vault.to_account_info(),
            a.token_1_vault.to_account_info(),
            mint_0,
            mint_1,
            a.lock_lp_vault.to_account_info(),
            a.token_program.to_account_info(),
            a.token_2022_program.to_account_info(),
            a.memo_program.to_account_info(),
            a.lp_lock_program.to_account_info(),
        ],
        signer,
    )?;

    // Measure what actually arrived.
    a.fee_vault_token_account.reload()?;
    a.fee_vault_wsol_account.reload()?;
    let tokens_collected = a.fee_vault_token_account.amount.checked_sub(tokens_before).ok_or(ParabullError::Overflow)?;
    let sol_collected = a.fee_vault_wsol_account.amount.checked_sub(wsol_before).ok_or(ParabullError::Overflow)?;
    require!(sol_collected > 0 || tokens_collected > 0, ParabullError::NothingCollected);

    // Unwrap: close the WSOL account into the vault PDA (balance + rent).
    let wsol_info = a.fee_vault_wsol_account.to_account_info();
    let wsol_rent = wsol_info.lamports().checked_sub(a.fee_vault_wsol_account.amount).ok_or(ParabullError::Overflow)?;
    close_account(CpiContext::new_with_signer(
        a.token_program.to_account_info(),
        CloseAccount { account: wsol_info, destination: a.fee_key_vault.to_account_info(), authority: a.fee_key_vault.to_account_info() },
        signer,
    ))?;

    // Burn the launched-token side (whole balance, incl. anything donated to
    // this account), then close it; rent back to the crank that funded it.
    let burn_amount = a.fee_vault_token_account.amount;
    if burn_amount > 0 {
        burn(
            CpiContext::new_with_signer(
                a.token_2022_program.to_account_info(),
                Burn {
                    mint: a.mint.to_account_info(),
                    from: a.fee_vault_token_account.to_account_info(),
                    authority: a.fee_key_vault.to_account_info(),
                },
                signer,
            ),
            burn_amount,
        )?;
    }
    close_account(CpiContext::new_with_signer(
        a.token_2022_program.to_account_info(),
        CloseAccount {
            account: a.fee_vault_token_account.to_account_info(),
            destination: a.crank.to_account_info(),
            authority: a.fee_key_vault.to_account_info(),
        },
        signer,
    ))?;

    // Route the measured SOL.
    let split = route_harvested_sol(&mut a.bonding_curve, &a.global, sol_collected)?;
    let (sys, from) = (&a.system_program, &a.fee_key_vault);
    pay(sys, from, a.bonding_curve.to_account_info(), split.escrow, signer)?;
    pay(sys, from, a.buyback_vault.to_account_info(), split.buyback, signer)?;
    pay(sys, from, a.holder_vault.to_account_info(), split.holder, signer)?;
    pay(sys, from, a.treasury.to_account_info(), split.treasury, signer)?;
    // Refund the temporary account's rent to the crank, then sweep anything
    // else the PDA holds (e.g. WSOL someone pre-deposited) to the treasury.
    pay(sys, from, a.crank.to_account_info(), wsol_rent, signer)?;
    let stray = a.fee_key_vault.lamports();
    pay(sys, from, a.treasury.to_account_info(), stray, signer)?;

    let bv = &mut a.buyback_vault;
    bv.total_deposited_lamports = bv.total_deposited_lamports.checked_add(split.buyback).ok_or(ParabullError::Overflow)?;
    let hv = &mut a.holder_vault;
    hv.total_deposited_lamports = hv.total_deposited_lamports.checked_add(split.holder).ok_or(ParabullError::Overflow)?;
    let c = &mut a.bonding_curve;
    c.lp_fees_sol_collected = c.lp_fees_sol_collected.checked_add(sol_collected).ok_or(ParabullError::Overflow)?;
    c.lp_fees_tokens_burned = c.lp_fees_tokens_burned.checked_add(burn_amount).ok_or(ParabullError::Overflow)?;
    assert_curve_backed(&a.bonding_curve)?;

    emit!(LpFeesCollected {
        mint: mint_key,
        pool: pool.pool_state,
        fee_lp_amount,
        sol_collected,
        tokens_burned: burn_amount,
        to_escrow: split.escrow,
        to_buyback_vault: split.buyback,
        to_holder_vault: split.holder,
        to_treasury: split.treasury,
    });
    Ok(())
}

/// System transfer out of the fee-key vault PDA (signed by its seeds).
fn pay<'info>(
    system_program: &Program<'info, System>,
    from: &SystemAccount<'info>,
    to: AccountInfo<'info>,
    amount: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            system_program::Transfer { from: from.to_account_info(), to },
            signer,
        ),
        amount,
    )
}

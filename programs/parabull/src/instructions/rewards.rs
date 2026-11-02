//! $PARABULL holder rewards: Merkle epochs with a claimed-bitmap.
//!
//! - `publish_reward_epoch` (crank): commits `total_lamports` of the
//!   HolderRewardVault to a snapshot root. Only allowed if the vault covers
//!   rent + every outstanding reward + this epoch.
//! - `claim_holder_reward` (permissionless): pays one leaf to the address in
//!   the leaf, once. Anyone can submit it, so the crank can push many claims
//!   per transaction and holders can also pull their own. No CPI: the only
//!   transfer is a direct lamport move from the vault, which stays rent-exempt.
//! - `expire_reward_epoch` (crank or admin): after the epoch's claim window
//!   (fixed at publish from `Global.reward_claim_window_seconds`, >= 7 days),
//!   closes it to claims and releases the unclaimed reservation so those
//!   lamports can fund future epochs.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ParabullError;
use crate::events::{EpochExpired, HolderRewardClaimed, RewardEpochPublished};
use crate::merkle;
use crate::state::{reward_epoch_fundable, vault_spendable, Global, HolderRewardVault, RewardEpoch};

#[derive(Accounts)]
#[instruction(merkle_root: [u8; 32], total_lamports: u64, num_leaves: u32)]
pub struct PublishRewardEpoch<'info> {
    #[account(mut, address = global.crank_authority @ ParabullError::Unauthorized)]
    pub crank: Signer<'info>,

    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    #[account(mut, seeds = [SEED_HOLDER_VAULT], bump = holder_vault.bump)]
    pub holder_vault: Box<Account<'info, HolderRewardVault>>,

    #[account(
        init,
        payer = crank,
        space = RewardEpoch::space(num_leaves),
        seeds = [SEED_REWARD_EPOCH, &holder_vault.next_epoch.to_le_bytes()],
        bump,
    )]
    pub reward_epoch: Box<Account<'info, RewardEpoch>>,

    pub system_program: Program<'info, System>,
}

pub fn publish_handler(ctx: Context<PublishRewardEpoch>, merkle_root: [u8; 32], total_lamports: u64, num_leaves: u32, snapshot_slot: u64) -> Result<()> {
    let a = ctx.accounts;
    require!(!a.global.paused, ParabullError::Paused);
    require!(num_leaves > 0 && num_leaves <= MAX_REWARD_LEAVES && total_lamports > 0, ParabullError::InvalidRewardEpoch);
    require!(merkle_root != [0u8; 32], ParabullError::InvalidRewardEpoch);

    let info = a.holder_vault.to_account_info();
    let rent = Rent::get()?.minimum_balance(info.data_len());
    require!(
        reward_epoch_fundable(info.lamports(), rent, a.holder_vault.outstanding()?, total_lamports),
        ParabullError::InsufficientRewardFunds
    );

    let epoch = a.holder_vault.next_epoch;
    let e = &mut a.reward_epoch;
    e.bump = ctx.bumps.reward_epoch;
    e.epoch = epoch;
    e.merkle_root = merkle_root;
    e.snapshot_slot = snapshot_slot;
    e.total_lamports = total_lamports;
    e.claimed_lamports = 0;
    e.num_leaves = num_leaves;
    e.claimed_count = 0;
    let now = Clock::get()?.unix_timestamp;
    e.published_at = now;
    e.expires_at = now.checked_add(a.global.reward_claim_window_seconds).ok_or(ParabullError::Overflow)?;
    e.expired = false;
    let expires_at = e.expires_at;
    e.claimed_bitmap = vec![0; RewardEpoch::bitmap_len(num_leaves)];

    let v = &mut a.holder_vault;
    v.next_epoch = epoch.checked_add(1).ok_or(ParabullError::Overflow)?;
    v.total_committed_lamports = v.total_committed_lamports.checked_add(total_lamports).ok_or(ParabullError::Overflow)?;

    emit!(RewardEpochPublished { epoch, merkle_root, total_lamports, num_leaves, snapshot_slot, expires_at });
    Ok(())
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct ClaimHolderReward<'info> {
    #[account(mut, seeds = [SEED_HOLDER_VAULT], bump = holder_vault.bump)]
    pub holder_vault: Box<Account<'info, HolderRewardVault>>,

    #[account(mut, seeds = [SEED_REWARD_EPOCH, &epoch.to_le_bytes()], bump = reward_epoch.bump)]
    pub reward_epoch: Box<Account<'info, RewardEpoch>>,

    /// Recipient named in the Merkle leaf (system-owned wallet). Not a signer:
    /// anyone may submit the claim, funds can only go here.
    #[account(mut)]
    pub claimant: SystemAccount<'info>,
}

pub fn claim_handler(mut ctx: Context<ClaimHolderReward>, epoch: u64, index: u32, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
    let a = &mut ctx.accounts;
    require!(amount > 0, ParabullError::ZeroAmount);
    let leaf = merkle::leaf_hash(index, &a.claimant.key(), amount);
    require!(merkle::verify(&proof, &a.reward_epoch.merkle_root, leaf), ParabullError::InvalidMerkleProof);
    a.reward_epoch.mark_claimed(index, amount)?;

    let info = a.holder_vault.to_account_info();
    let rent = Rent::get()?.minimum_balance(info.data_len());
    require!(amount <= vault_spendable(info.lamports(), rent), ParabullError::InsufficientVaultBalance);
    a.holder_vault.sub_lamports(amount)?;
    a.claimant.add_lamports(amount)?;
    let v = &mut a.holder_vault;
    v.total_claimed_lamports = v.total_claimed_lamports.checked_add(amount).ok_or(ParabullError::Overflow)?;

    emit!(HolderRewardClaimed { epoch, index, claimant: a.claimant.key(), amount });
    Ok(())
}

#[derive(Accounts)]
#[instruction(epoch_index: u64)]
pub struct ExpireRewardEpoch<'info> {
    /// The crank authority or the admin.
    #[account(constraint = authority.key() == global.crank_authority || authority.key() == global.admin @ ParabullError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    #[account(mut, seeds = [SEED_HOLDER_VAULT], bump = holder_vault.bump)]
    pub holder_vault: Box<Account<'info, HolderRewardVault>>,

    #[account(mut, seeds = [SEED_REWARD_EPOCH, &epoch_index.to_le_bytes()], bump = reward_epoch.bump)]
    pub reward_epoch: Box<Account<'info, RewardEpoch>>,
}

/// No lamports move: the unclaimed amount already sits in the vault; only its
/// reservation is released (it stops counting as outstanding).
pub fn expire_handler(mut ctx: Context<ExpireRewardEpoch>, epoch_index: u64) -> Result<()> {
    let a = &mut ctx.accounts;
    let reclaimed = a.reward_epoch.expire(Clock::get()?.unix_timestamp)?;
    let v = &mut a.holder_vault;
    v.total_expired_lamports = v.total_expired_lamports.checked_add(reclaimed).ok_or(ParabullError::Overflow)?;
    v.outstanding()?; // invariant: committed >= claimed + expired
    emit!(EpochExpired { epoch_index, reclaimed_lamports: reclaimed, expired_by: a.authority.key() });
    Ok(())
}

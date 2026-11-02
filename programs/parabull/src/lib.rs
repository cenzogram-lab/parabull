//! Parabull: blind-launch bonding curves with a ticker registry, a 1% platform
//! fee flywheel (DexScreener escrow -> $PARABULL buyback/burn -> holder rewards)
//! and Raydium CPMM graduation.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod flywheel;
pub mod instructions;
pub mod launch;
pub mod math;
pub mod merkle;
pub mod raydium;
pub mod state;
pub mod trade;

use instructions::*;
use state::{GlobalParams, GlobalUpdate};

declare_id!("8tBGLgWXDAssTBgUaamsB4ZbyRQivNDiGFiyTMfQiPFW");

#[program]
pub mod parabull {
    use super::*;

    /// One-time `Global` setup. Only the program's upgrade authority may call it,
    /// so deployment cannot be front-run.
    pub fn initialize(ctx: Context<Initialize>, params: GlobalParams) -> Result<()> {
        instructions::initialize::handler(ctx, params)
    }

    /// User deposits `Global.ticket_deposit_lamports` and commits to the exact
    /// name/symbol/URI. `symbol` must be the canonical ticker.
    pub fn request_launch(ctx: Context<RequestLaunch>, nonce: u64, name: String, symbol: String, uri: String) -> Result<()> {
        instructions::request_launch::handler(ctx, nonce, name, symbol, uri)
    }

    /// Return an unused ticket's deposit + rent to its payer. Payer: after
    /// expiry. Launch authority: any time (backend rejection).
    pub fn refund_ticket(ctx: Context<RefundTicket>) -> Result<()> {
        instructions::refund_ticket::handler(ctx)
    }

    /// Blind launch. Signed by the launch authority and the fresh mint keypair;
    /// consumes the ticket, claims the ticker/name locks, creates the curve.
    pub fn create(ctx: Context<Create>, name: String, symbol: String, uri: String) -> Result<()> {
        instructions::create::handler(ctx, name, symbol, uri)
    }

    /// Buy `amount` tokens for at most `max_sol_cost` lamports (fee inclusive).
    /// Partially fills to the curve's remaining tokens; the final fill completes it.
    pub fn buy(ctx: Context<Trade>, amount: u64, max_sol_cost: u64) -> Result<()> {
        instructions::buy::handler(ctx, amount, max_sol_cost)
    }

    /// Sell `amount` tokens for at least `min_sol_output` lamports (net of fee).
    pub fn sell(ctx: Context<Trade>, amount: u64, min_sol_output: u64) -> Result<()> {
        instructions::sell::handler(ctx, amount, min_sol_output)
    }

    /// Graduation 1/3 (crank): move the curve's tokens + SOL to the migration authority.
    pub fn prepare_migration(ctx: Context<PrepareMigration>) -> Result<()> {
        instructions::prepare_migration::handler(ctx)
    }

    /// Graduation 2/3 (crank): create the Raydium CPMM pool.
    pub fn migrate_raydium(ctx: Context<MigrateRaydium>) -> Result<()> {
        instructions::migrate_raydium::handler(ctx)
    }

    /// Graduation 3/3 (crank + fresh NFT mint keypair): lock all LP in Burn & Earn.
    pub fn lock_migrated_lp(ctx: Context<LockMigratedLp>) -> Result<()> {
        instructions::lock_migrated_lp::handler(ctx)
    }

    /// Anyone can add protocol fees to a curve's DexScreener escrow, up to the target.
    pub fn top_up_dex_escrow(ctx: Context<TopUpDexEscrow>, amount: u64) -> Result<()> {
        instructions::escrow::top_up_handler(ctx, amount)
    }

    /// Pay a funded escrow (`dex_target_lamports`) to the treasury, once.
    pub fn release_dex_escrow(ctx: Context<ReleaseDexEscrow>) -> Result<()> {
        instructions::escrow::release_handler(ctx)
    }

    /// Move buyback / holder / treasury buckets to their vaults (never the escrow).
    pub fn sweep_fees(ctx: Context<SweepFees>) -> Result<()> {
        instructions::sweep_fees::handler(ctx)
    }

    /// Admin: partial `Global` update, validated as a whole.
    pub fn update_global_params(ctx: Context<AdminOnly>, update: GlobalUpdate) -> Result<()> {
        instructions::admin::update_handler(ctx, update)
    }

    /// Admin: nominate a new admin (`Pubkey::default()` cancels).
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::propose_handler(ctx, new_admin)
    }

    /// Nominee: accept the admin role.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::accept_handler(ctx)
    }

    /// Admin: emergency pause (launches, trading, buybacks, new reward epochs).
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        instructions::admin::set_paused_handler(ctx, paused)
    }

    /// Crank: stage `amount` lamports from BuybackVault for `buyback_and_burn`
    /// (send both in one transaction).
    pub fn prepare_buyback(ctx: Context<PrepareBuyback>, amount: u64) -> Result<()> {
        instructions::buyback::prepare_handler(ctx, amount)
    }

    /// Crank: swap the staged SOL for $PARABULL on Raydium CPMM (enforcing
    /// `min_amount_out`) and burn everything received.
    pub fn buyback_and_burn(ctx: Context<BuybackAndBurn>, min_amount_out: u64) -> Result<()> {
        instructions::buyback::buyback_handler(ctx, min_amount_out)
    }

    /// Crank: commit `total_lamports` of the holder vault to a snapshot Merkle root.
    pub fn publish_reward_epoch(
        ctx: Context<PublishRewardEpoch>,
        merkle_root: [u8; 32],
        total_lamports: u64,
        num_leaves: u32,
        snapshot_slot: u64,
    ) -> Result<()> {
        instructions::rewards::publish_handler(ctx, merkle_root, total_lamports, num_leaves, snapshot_slot)
    }

    /// Anyone: pay leaf `index` of `epoch` to its claimant (push or pull).
    pub fn claim_holder_reward(ctx: Context<ClaimHolderReward>, epoch: u64, index: u32, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        instructions::rewards::claim_handler(ctx, epoch, index, amount, proof)
    }

    /// Crank or admin: after an epoch's claim window, stop its claims and
    /// release its unclaimed reservation back to the holder vault.
    pub fn expire_reward_epoch(ctx: Context<ExpireRewardEpoch>, epoch_index: u64) -> Result<()> {
        instructions::rewards::expire_handler(ctx, epoch_index)
    }

    /// Crank: harvest post-graduation LP fees via the fee-key NFT and route the
    /// SOL (escrow first, then buyback / holder vaults / treasury).
    pub fn collect_lp_fees(ctx: Context<CollectLpFees>, fee_lp_amount: u64) -> Result<()> {
        instructions::collect_lp_fees::handler(ctx, fee_lp_amount)
    }
}

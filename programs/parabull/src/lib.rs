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
pub mod raydium;
pub mod state;
pub mod trade;

use instructions::*;
use state::GlobalParams;

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
}

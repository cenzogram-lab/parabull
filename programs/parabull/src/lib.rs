//! Parabull: blind-launch bonding curves with a ticker registry, a 1% platform
//! fee flywheel (DexScreener escrow -> $PARABULL buyback/burn -> holder rewards)
//! and Raydium CPMM graduation.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod launch;
pub mod math;
pub mod state;

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
}

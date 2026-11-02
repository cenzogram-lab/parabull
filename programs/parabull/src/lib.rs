//! Parabull: blind-launch bonding curves with a ticker registry, a 1% platform
//! fee flywheel (DexScreener escrow -> $PARABULL buyback/burn -> holder rewards)
//! and Raydium CPMM graduation.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
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
}

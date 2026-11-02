use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::instructions::trade_accounts::Trade;
use crate::trade::apply_buy;

/// Buy `amount` tokens (partial-filled to the curve's remaining real tokens)
/// paying at most `max_sol_cost` lamports including the 1% platform fee.
/// The whole payment lands in the curve account: cost backs the reserves,
/// fee is tallied into the curve's buckets.
pub fn handler(mut ctx: Context<Trade>, amount: u64, max_sol_cost: u64) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    let out = apply_buy(&mut a.bonding_curve, &a.global, clock.slot, amount, max_sol_cost)?;

    system_program::transfer(
        CpiContext::new(
            a.system_program.to_account_info(),
            system_program::Transfer { from: a.user.to_account_info(), to: a.bonding_curve.to_account_info() },
        ),
        out.quote.total,
    )?;
    a.send_tokens_to_user(out.quote.tokens_out)?;
    a.assert_lamport_invariant()?;

    a.emit_trade(true, out.quote.tokens_out, out.quote.sol_cost, out.quote.fee, out.split, &clock);
    if out.graduated {
        a.emit_graduation(&clock);
    }
    Ok(())
}

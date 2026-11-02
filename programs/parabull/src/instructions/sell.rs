use anchor_lang::prelude::*;

use crate::instructions::trade_accounts::Trade;
use crate::trade::apply_sell;

/// Sell `amount` tokens for at least `min_sol_output` lamports after the 1%
/// platform fee. The fee never leaves the curve account; only the net is paid.
pub fn handler(mut ctx: Context<Trade>, amount: u64, min_sol_output: u64) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    let out = apply_sell(&mut a.bonding_curve, &a.global, clock.slot, amount, min_sol_output)?;

    a.take_tokens_from_user(out.quote.tokens_in)?;

    // Raw lamport move strictly after the last CPI.
    a.bonding_curve.sub_lamports(out.quote.sol_net)?;
    a.user.add_lamports(out.quote.sol_net)?;
    a.assert_lamport_invariant()?;

    a.emit_trade(false, out.quote.tokens_in, out.quote.sol_gross, out.quote.fee, out.split, &clock);
    Ok(())
}

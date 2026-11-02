//! Pure trade state transitions shared by `buy` and `sell`.
//!
//! Each function validates, quotes, enforces slippage and mutates the curve
//! in memory; the instruction handlers then move tokens/lamports to match.
//! Keeping this free of account I/O lets every rule be unit-tested.

use anchor_lang::prelude::*;

use crate::error::ParabullError;
use crate::math::{self, BuyQuote, FeeSplit, SellQuote};
use crate::state::{BondingCurve, Global};

/// Trading requires: program not paused, curve not complete, open slot reached.
pub fn check_tradeable(global: &Global, curve: &BondingCurve, slot: u64) -> Result<()> {
    require!(!global.paused, ParabullError::Paused);
    require!(!curve.complete, ParabullError::CurveComplete);
    require!(slot >= curve.trading_open_slot, ParabullError::TradingNotOpenYet);
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuyOutcome {
    pub quote: BuyQuote,
    pub split: FeeSplit,
    /// This buy took the last real token; the curve is now complete.
    pub graduated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SellOutcome {
    pub quote: SellQuote,
    pub split: FeeSplit,
}

/// Buy exactly `token_amount` (partially filled to the remaining real tokens)
/// for at most `max_sol_cost` lamports, fee included.
pub fn apply_buy(curve: &mut BondingCurve, global: &Global, slot: u64, token_amount: u64, max_sol_cost: u64) -> Result<BuyOutcome> {
    check_tradeable(global, curve, slot)?;
    let quote = math::quote_buy_exact_tokens(&curve.reserves(), token_amount, global.platform_fee_bps)?;
    require!(quote.total <= max_sol_cost, ParabullError::SlippageExceeded);
    curve.apply_buy(quote.tokens_out, quote.sol_cost)?;
    let split = curve.accrue_platform_fee(global, quote.fee)?;
    Ok(BuyOutcome { quote, split, graduated: curve.complete })
}

/// Sell exactly `token_amount` for at least `min_sol_output` lamports, net of fee.
pub fn apply_sell(curve: &mut BondingCurve, global: &Global, slot: u64, token_amount: u64, min_sol_output: u64) -> Result<SellOutcome> {
    check_tradeable(global, curve, slot)?;
    let quote = math::quote_sell(&curve.reserves(), token_amount, global.platform_fee_bps)?;
    require!(quote.sol_net >= min_sol_output, ParabullError::SlippageExceeded);
    curve.apply_sell(quote.tokens_in, quote.sol_gross)?;
    let split = curve.accrue_platform_fee(global, quote.fee)?;
    Ok(SellOutcome { quote, split })
}

/// Fail closed unless the curve account's lamports cover rent + real SOL +
/// every fee bucket. Call at the end of any instruction that moves curve SOL.
pub fn assert_curve_backed(curve: &Account<BondingCurve>) -> Result<()> {
    let info = curve.to_account_info();
    let rent = Rent::get()?.minimum_balance(info.data_len());
    require!(info.lamports() >= required_curve_lamports(curve, rent)?, ParabullError::LamportInvariantViolated);
    Ok(())
}

/// Minimum lamports the curve account must hold: rent + real SOL reserves + all fee buckets.
pub fn required_curve_lamports(curve: &BondingCurve, rent_exempt_minimum: u64) -> Result<u64> {
    rent_exempt_minimum
        .checked_add(curve.real_sol_reserves)
        .and_then(|v| v.checked_add(curve.accrued_fees().ok()?))
        .ok_or_else(|| error!(ParabullError::Overflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::*;
    use crate::state::fixtures::{curve, global};

    const OPEN: u64 = 1_000 + DEFAULT_TRADING_OPEN_DELAY_SLOTS;

    fn code(e: anchor_lang::error::Error) -> u32 {
        match e {
            anchor_lang::error::Error::AnchorError(a) => a.error_code_number,
            other => panic!("unexpected error {other:?}"),
        }
    }

    fn err(e: ParabullError) -> u32 {
        e.into()
    }

    #[test]
    fn trading_not_open_until_delay_elapses() {
        let g = global();
        let mut c = curve(&g); // created at slot 1_000
        for slot in [1_000, OPEN - 1] {
            let e = apply_buy(&mut c, &g, slot, 1_000_000, u64::MAX).unwrap_err();
            assert_eq!(code(e), err(ParabullError::TradingNotOpenYet), "buy at slot {slot}");
            let e = apply_sell(&mut c, &g, slot, 1_000_000, 0).unwrap_err();
            assert_eq!(code(e), err(ParabullError::TradingNotOpenYet), "sell at slot {slot}");
        }
        assert_eq!(c.real_token_reserves, DEFAULT_INITIAL_REAL_TOKEN_RESERVES, "rejected trades leave state untouched");
        apply_buy(&mut c, &g, OPEN, 1_000_000, u64::MAX).unwrap();
    }

    #[test]
    fn paused_blocks_trading() {
        let mut g = global();
        g.paused = true;
        let mut c = curve(&g);
        assert_eq!(code(apply_buy(&mut c, &g, OPEN, 1, u64::MAX).unwrap_err()), err(ParabullError::Paused));
    }

    #[test]
    fn buy_slippage_is_fee_inclusive() {
        let g = global();
        let mut c = curve(&g);
        let q = math::quote_buy_exact_tokens(&c.reserves(), 10_000_000_000_000, g.platform_fee_bps).unwrap();
        let before = c.reserves();
        let e = apply_buy(&mut c, &g, OPEN, 10_000_000_000_000, q.total - 1).unwrap_err();
        assert_eq!(code(e), err(ParabullError::SlippageExceeded));
        assert_eq!(c.reserves(), before);
        let out = apply_buy(&mut c, &g, OPEN, 10_000_000_000_000, q.total).unwrap();
        assert_eq!(out.quote, q);
    }

    #[test]
    fn sell_slippage_is_net_of_fee() {
        let g = global();
        let mut c = curve(&g);
        apply_buy(&mut c, &g, OPEN, 50_000_000_000_000, u64::MAX).unwrap();
        let q = math::quote_sell(&c.reserves(), 20_000_000_000_000, g.platform_fee_bps).unwrap();
        let e = apply_sell(&mut c, &g, OPEN, 20_000_000_000_000, q.sol_net + 1).unwrap_err();
        assert_eq!(code(e), err(ParabullError::SlippageExceeded));
        let out = apply_sell(&mut c, &g, OPEN, 20_000_000_000_000, q.sol_net).unwrap();
        assert_eq!(out.quote, q);
    }

    #[test]
    fn sell_cannot_drain_more_than_real_sol() {
        let g = global();
        let mut c = curve(&g);
        apply_buy(&mut c, &g, OPEN, 1_000_000_000_000, u64::MAX).unwrap();
        // Selling more tokens than were bought would pay out SOL the curve never received.
        assert!(apply_sell(&mut c, &g, OPEN, 2_000_000_000_000, 0).is_err());
    }

    #[test]
    fn completion_on_last_token_then_locked() {
        let g = global();
        let mut c = curve(&g);
        apply_buy(&mut c, &g, OPEN, 100_000_000_000_000, u64::MAX).unwrap();
        // Over-ask is partially filled to exactly the remaining real tokens.
        let remaining = c.real_token_reserves;
        let out = apply_buy(&mut c, &g, OPEN, u64::MAX, u64::MAX).unwrap();
        assert!(out.graduated);
        assert_eq!(out.quote.tokens_out, remaining);
        assert_eq!(c.real_token_reserves, 0);
        assert!(c.complete);
        assert_eq!(code(apply_buy(&mut c, &g, OPEN, 1, u64::MAX).unwrap_err()), err(ParabullError::CurveComplete));
        assert_eq!(code(apply_sell(&mut c, &g, OPEN, 1, 0).unwrap_err()), err(ParabullError::CurveComplete));
    }

    #[test]
    fn buy_that_leaves_tokens_does_not_graduate() {
        let g = global();
        let mut c = curve(&g);
        let out = apply_buy(&mut c, &g, OPEN, DEFAULT_INITIAL_REAL_TOKEN_RESERVES - 1, u64::MAX).unwrap();
        assert!(!out.graduated && !c.complete);
        assert_eq!(c.real_token_reserves, 1);
    }

    /// Expected values computed independently (Python, same formulas) and pinned.
    #[test]
    fn multi_trade_fee_bucket_allocation_is_exact() {
        let mut g = global(); // 1% fee, buyback 50%, holder 40%, treasury remainder
        g.dex_target_lamports = 15_000_000;
        let mut c = curve(&g);

        let b1 = apply_buy(&mut c, &g, OPEN, 10_000_000_000_000, u64::MAX).unwrap();
        assert_eq!((b1.quote.sol_cost, b1.quote.fee, b1.quote.total), (282_220_132, 2_822_202, 285_042_334));
        assert_eq!(b1.split, FeeSplit { escrow: 2_822_202, ..Default::default() });

        let b2 = apply_buy(&mut c, &g, OPEN, 20_000_000_000_000, u64::MAX).unwrap();
        assert_eq!((b2.quote.sol_cost, b2.quote.fee), (580_675_363, 5_806_754));
        assert_eq!(b2.split, FeeSplit { escrow: 5_806_754, ..Default::default() });

        let s1 = apply_sell(&mut c, &g, OPEN, 5_000_000_000_000, 0).unwrap();
        assert_eq!((s1.quote.sol_gross, s1.quote.fee, s1.quote.sol_net), (147_246_638, 1_472_467, 145_774_171));
        assert_eq!(s1.split, FeeSplit { escrow: 1_472_467, ..Default::default() });

        // Crosses the 0.015 SOL escrow target mid-fee.
        let b3 = apply_buy(&mut c, &g, OPEN, 30_000_000_000_000, u64::MAX).unwrap();
        assert_eq!((b3.quote.sol_cost, b3.quote.fee), (905_176_293, 9_051_763));
        assert_eq!(b3.split, FeeSplit { escrow: 4_898_577, buyback: 2_076_593, holder: 1_661_274, treasury: 415_319 });

        assert_eq!(
            (c.escrow_accrued, c.buyback_accrued, c.holder_accrued, c.treasury_accrued),
            (15_000_000, 2_076_593, 1_661_274, 415_319)
        );
        assert!(c.is_escrow_funded(&g));
        assert_eq!(
            (c.virtual_token_reserves, c.virtual_sol_reserves, c.real_token_reserves, c.real_sol_reserves),
            (1_018_000_000_000_000, 31_620_825_150, 738_100_000_000_000, 1_620_825_150)
        );
        // Every lamport of every fee landed in exactly one bucket.
        let fees = b1.quote.fee + b2.quote.fee + s1.quote.fee + b3.quote.fee;
        assert_eq!(c.accrued_fees().unwrap(), fees);
    }

    #[test]
    fn lamport_requirement_tracks_reserves_and_buckets() {
        let g = global();
        let mut c = curve(&g);
        let rent = 2_000_000;
        assert_eq!(required_curve_lamports(&c, rent).unwrap(), rent);
        let out = apply_buy(&mut c, &g, OPEN, 10_000_000_000_000, u64::MAX).unwrap();
        // Curve receives cost + fee on a buy: exactly the new requirement.
        assert_eq!(required_curve_lamports(&c, rent).unwrap(), rent + out.quote.total);
        let s = apply_sell(&mut c, &g, OPEN, 4_000_000_000_000, 0).unwrap();
        // On a sell the curve pays out only the net; the fee stays as a bucket.
        assert_eq!(required_curve_lamports(&c, rent).unwrap(), rent + out.quote.total - s.quote.sol_net);
    }
}

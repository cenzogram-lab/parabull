//! Pure bonding-curve and fee arithmetic.
//!
//! Curve formulas are ported from the reference pump program and must stay
//! bit-for-bit identical to it (see `tests/reference_parity.rs`):
//! - `buy_cost`        <- `reference/programs/pump/src/lib.rs` `buy_quote`
//! - `sell_proceeds`   <- `reference/programs/pump/src/lib.rs` `BondingCurve::sell_quote`
//! - `tokens_for_sol`  <- `reference/programs/pump/src/lib.rs` `tokens_for_quote`
//!                        + `util/constant_product.rs` `output`
//! - `fee`             <- `reference/programs/pump/src/util/fee.rs` `fee` / `checked_ceil_div`
//! - `sol_budget_net_of_fee` <- `reference/programs/pump/src/buy_v2.rs` exact-quote-in path
//!
//! Everything else here (quotes, fee bucket split) is Parabull-specific.

use crate::error::ParabullError;
use anchor_lang::prelude::*;

const BPS: u128 = crate::constants::BPS_DENOMINATOR as u128;

#[inline]
fn to_u64(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| error!(ParabullError::Truncation))
}

/// Curve reserve snapshot. Virtual reserves price the curve; real reserves are
/// what the curve actually holds and can pay out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reserves {
    pub virtual_token: u64,
    pub virtual_sol: u64,
    pub real_token: u64,
    pub real_sol: u64,
}

impl Reserves {
    /// Debit tokens out / credit SOL in. Fails if the curve lacks real tokens.
    pub fn apply_buy(&mut self, tokens_out: u64, sol_in: u64) -> Result<()> {
        self.virtual_token = self.virtual_token.checked_sub(tokens_out).ok_or(ParabullError::InsufficientReserves)?;
        self.real_token = self.real_token.checked_sub(tokens_out).ok_or(ParabullError::InsufficientReserves)?;
        self.virtual_sol = self.virtual_sol.checked_add(sol_in).ok_or(ParabullError::Overflow)?;
        self.real_sol = self.real_sol.checked_add(sol_in).ok_or(ParabullError::Overflow)?;
        Ok(())
    }

    /// Credit tokens in / debit SOL out. Fails if the curve lacks real SOL.
    pub fn apply_sell(&mut self, tokens_in: u64, sol_out: u64) -> Result<()> {
        self.virtual_token = self.virtual_token.checked_add(tokens_in).ok_or(ParabullError::Overflow)?;
        self.real_token = self.real_token.checked_add(tokens_in).ok_or(ParabullError::Overflow)?;
        self.virtual_sol = self.virtual_sol.checked_sub(sol_out).ok_or(ParabullError::InsufficientReserves)?;
        self.real_sol = self.real_sol.checked_sub(sol_out).ok_or(ParabullError::InsufficientReserves)?;
        Ok(())
    }
}

/// Lamports (before fee) to buy exactly `token_amount`:
/// `floor(amount * vs / (vt - amount)) + 1`.
pub fn buy_cost(r: &Reserves, token_amount: u64) -> Result<u64> {
    let numerator = u128::from(token_amount) * u128::from(r.virtual_sol);
    let denominator = u128::from(r.virtual_token)
        .checked_sub(u128::from(token_amount))
        .ok_or(ParabullError::InsufficientReserves)?;
    require!(denominator != 0, ParabullError::DivisionByZero);
    to_u64(numerator / denominator + 1)
}

/// Lamports (before fee) received for selling `token_amount`:
/// `floor(vs * amount / (vt + amount))`.
pub fn sell_proceeds(r: &Reserves, token_amount: u64) -> Result<u64> {
    let numerator = u128::from(r.virtual_sol) * u128::from(token_amount);
    let denominator = u128::from(r.virtual_token) + u128::from(token_amount);
    to_u64(numerator.checked_div(denominator).ok_or(ParabullError::DivisionByZero)?)
}

/// Tokens bought with `sol_in` lamports (fee already removed):
/// `floor((sol_in - 1) * vt / (vs + sol_in - 1))`.
pub fn tokens_for_sol(r: &Reserves, sol_in: u64) -> Result<u64> {
    let effective = u128::from(sol_in.checked_sub(1).ok_or(ParabullError::ZeroAmount)?);
    let numerator = effective.checked_mul(u128::from(r.virtual_token)).ok_or(ParabullError::Overflow)?;
    let denominator = u128::from(r.virtual_sol).checked_add(effective).ok_or(ParabullError::Overflow)?;
    to_u64(numerator.checked_div(denominator).ok_or(ParabullError::DivisionByZero)?)
}

/// Fee rounded up: `ceil(amount * bps / 10_000)`.
pub fn fee(amount: u64, bps: u16) -> Result<u64> {
    let numerator = u128::from(amount) * u128::from(bps);
    let value = numerator
        .checked_add(BPS)
        .and_then(|v| v.checked_sub(1))
        .ok_or(ParabullError::Overflow)?
        / BPS;
    to_u64(value)
}

/// Largest curve spend whose fee-inclusive total fits in `budget`:
/// `floor(budget * 10_000 / (10_000 + bps))`.
pub fn sol_budget_net_of_fee(budget: u64, bps: u16) -> Result<u64> {
    if bps == 0 {
        return Ok(budget);
    }
    to_u64(u128::from(budget) * BPS / (BPS + u128::from(bps)))
}

/// Fully-diluted market cap in lamports: `supply * vs / vt`.
pub fn market_cap(r: &Reserves, total_supply: u64) -> Result<u64> {
    let numerator = u128::from(total_supply) * u128::from(r.virtual_sol);
    to_u64(numerator.checked_div(u128::from(r.virtual_token)).ok_or(ParabullError::DivisionByZero)?)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuyQuote {
    pub tokens_out: u64,
    /// Lamports credited to the curve reserves.
    pub sol_cost: u64,
    /// Platform fee in lamports (ceil).
    pub fee: u64,
    /// `sol_cost + fee`, what the buyer pays.
    pub total: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SellQuote {
    pub tokens_in: u64,
    /// Lamports debited from the curve reserves.
    pub sol_gross: u64,
    pub fee: u64,
    /// `sol_gross - fee`, what the seller receives.
    pub sol_net: u64,
}

fn buy_quote_for_tokens(r: &Reserves, tokens_out: u64, fee_bps: u16) -> Result<BuyQuote> {
    let sol_cost = buy_cost(r, tokens_out)?;
    let fee = fee(sol_cost, fee_bps)?;
    let total = sol_cost.checked_add(fee).ok_or(ParabullError::Overflow)?;
    Ok(BuyQuote { tokens_out, sol_cost, fee, total })
}

/// Buy an exact token amount, partially filled down to the curve's remaining
/// real tokens (the final buy that completes the curve).
pub fn quote_buy_exact_tokens(r: &Reserves, token_amount: u64, fee_bps: u16) -> Result<BuyQuote> {
    require!(token_amount > 0, ParabullError::ZeroAmount);
    let tokens_out = token_amount.min(r.real_token);
    require!(tokens_out > 0, ParabullError::InsufficientReserves);
    buy_quote_for_tokens(r, tokens_out, fee_bps)
}

/// Spend at most `budget` lamports (fee inclusive). `total <= budget` always holds.
pub fn quote_buy_exact_sol_in(r: &Reserves, budget: u64, fee_bps: u16) -> Result<BuyQuote> {
    require!(budget > 0, ParabullError::ZeroAmount);
    let net = sol_budget_net_of_fee(budget, fee_bps)?;
    let tokens_out = tokens_for_sol(r, net)?.min(r.real_token);
    require!(tokens_out > 0, ParabullError::ZeroAmount);
    let quote = buy_quote_for_tokens(r, tokens_out, fee_bps)?;
    require!(quote.total <= budget, ParabullError::Overflow);
    Ok(quote)
}

pub fn quote_sell(r: &Reserves, token_amount: u64, fee_bps: u16) -> Result<SellQuote> {
    require!(token_amount > 0, ParabullError::ZeroAmount);
    let sol_gross = sell_proceeds(r, token_amount)?;
    require!(sol_gross <= r.real_sol, ParabullError::InsufficientReserves);
    let fee = fee(sol_gross, fee_bps)?;
    let sol_net = sol_gross.checked_sub(fee).ok_or(ParabullError::Overflow)?;
    Ok(SellQuote { tokens_in: token_amount, sol_gross, fee, sol_net })
}

/// Where one trade's platform fee goes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeeSplit {
    /// Stage 1: per-token DexScreener escrow, until the target is met.
    pub escrow: u64,
    /// Stage 2: $PARABULL buyback & burn.
    pub buyback: u64,
    /// Stage 3: $PARABULL holder rewards.
    pub holder: u64,
    /// Remainder (ops treasury); absorbs rounding dust.
    pub treasury: u64,
}

impl FeeSplit {
    pub fn total(&self) -> Result<u64> {
        self.escrow
            .checked_add(self.buyback)
            .and_then(|v| v.checked_add(self.holder))
            .and_then(|v| v.checked_add(self.treasury))
            .ok_or_else(|| error!(ParabullError::Overflow))
    }
}

/// Split a platform fee across the flywheel stages.
///
/// While `escrow_open`, fees fill the escrow up to `escrow_target`; the excess
/// (and every fee once the escrow is closed) is split `buyback_bps` /
/// `holder_bps`, remainder to treasury. Floors on buyback/holder, so the sum
/// always equals `fee` exactly.
pub fn split_platform_fee(
    fee: u64,
    escrow_accrued: u64,
    escrow_target: u64,
    escrow_open: bool,
    buyback_bps: u16,
    holder_bps: u16,
) -> Result<FeeSplit> {
    require!(
        u64::from(buyback_bps) + u64::from(holder_bps) <= crate::constants::BPS_DENOMINATOR,
        ParabullError::FeeSplitOutOfRange
    );
    let room = if escrow_open { escrow_target.saturating_sub(escrow_accrued) } else { 0 };
    let escrow = fee.min(room);
    let rest = fee - escrow;
    let buyback = to_u64(u128::from(rest) * u128::from(buyback_bps) / BPS)?;
    let holder = to_u64(u128::from(rest) * u128::from(holder_bps) / BPS)?;
    let treasury = rest - buyback - holder;
    Ok(FeeSplit { escrow, buyback, holder, treasury })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::*;

    fn fresh() -> Reserves {
        Reserves {
            virtual_token: DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
            virtual_sol: DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES,
            real_token: DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
            real_sol: 0,
        }
    }

    /// Deterministic xorshift so tests need no extra dependencies.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n.max(1)
        }
    }

    #[test]
    fn known_values_on_fresh_curve() {
        let r = fresh();
        // 1 SOL in (fee excluded): (1e9-1)*1.073e15/(3e10+1e9-1)
        assert_eq!(tokens_for_sol(&r, 1_000_000_000).unwrap(), 34_612_903_192_310);
        assert_eq!(fee(1_000_000_000, 100).unwrap(), 10_000_000);
        assert_eq!(fee(1, 100).unwrap(), 1, "fee rounds up");
        assert_eq!(fee(0, 100).unwrap(), 0);
        assert_eq!(sol_budget_net_of_fee(1_010_000_000, 100).unwrap(), 1_000_000_000);
        // Starting FDV: 1e15 * 3e10 / 1.073e15 lamports.
        assert_eq!(market_cap(&r, DEFAULT_TOKEN_TOTAL_SUPPLY).unwrap(), 27_958_993_476);
    }

    #[test]
    fn full_curve_drain_cost() {
        let r = fresh();
        // Buying every real token costs ~85 SOL before fees with the default shape.
        let cost = buy_cost(&r, r.real_token).unwrap();
        assert_eq!(cost, 85_005_359_057);
        let q = quote_buy_exact_tokens(&r, u64::MAX, 100).unwrap();
        assert_eq!(q.tokens_out, r.real_token, "partial fill caps at real reserves");
        assert_eq!(q.sol_cost, cost);
    }

    #[test]
    fn buy_rejects_draining_virtual_reserves() {
        let r = fresh();
        assert!(buy_cost(&r, r.virtual_token).is_err());
        assert!(buy_cost(&r, r.virtual_token + 1).is_err());
        assert!(tokens_for_sol(&r, 0).is_err());
    }

    #[test]
    fn exact_sol_in_never_exceeds_budget_and_cost_covers_tokens() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for _ in 0..20_000 {
            let mut r = fresh();
            // Move the curve to a random point first.
            let pre = 1 + rng.below(r.real_token - 1);
            let pre_cost = buy_cost(&r, pre).unwrap();
            r.apply_buy(pre, pre_cost).unwrap();
            if r.real_token == 0 {
                continue;
            }
            let budget = 2 + rng.below(100_000_000_000);
            let bps = (rng.below(u64::from(MAX_PLATFORM_FEE_BPS)) + 1) as u16;
            let Ok(q) = quote_buy_exact_sol_in(&r, budget, bps) else { continue };
            assert!(q.total <= budget);
            assert!(q.tokens_out <= r.real_token);
            assert_eq!(q.fee, fee(q.sol_cost, bps).unwrap());
        }
    }

    #[test]
    fn round_trip_never_profits() {
        let mut rng = Rng(0xD1B5_4A32_D192_ED03);
        for _ in 0..20_000 {
            let mut r = fresh();
            let tokens = 1 + rng.below(r.real_token);
            let cost = buy_cost(&r, tokens).unwrap();
            r.apply_buy(tokens, cost).unwrap();
            let back = sell_proceeds(&r, tokens).unwrap();
            assert!(back <= cost, "buy {tokens} for {cost}, sold for {back}");
            r.apply_sell(tokens, back).unwrap();
            assert_eq!(r.real_token, DEFAULT_INITIAL_REAL_TOKEN_RESERVES);
        }
    }

    #[test]
    fn sell_cannot_exceed_real_sol() {
        let r = fresh();
        assert!(quote_sell(&r, 1_000_000, 100).is_err());
    }

    #[test]
    fn fee_split_cases() {
        // Escrow has 10 of room left: 10 to escrow, remaining 90 split 40/40/20.
        let s = split_platform_fee(100, 90, 100, true, 4_000, 4_000).unwrap();
        assert_eq!(s, FeeSplit { escrow: 10, buyback: 36, holder: 36, treasury: 18 });

        let s = split_platform_fee(100, 0, 1_000, true, 5_000, 5_000).unwrap();
        assert_eq!(s, FeeSplit { escrow: 100, ..Default::default() });

        let s = split_platform_fee(101, 1_000, 1_000, true, 5_000, 5_000).unwrap();
        assert_eq!(s, FeeSplit { escrow: 0, buyback: 50, holder: 50, treasury: 1 });

        let s = split_platform_fee(100, 0, 1_000, false, 7_000, 3_000).unwrap();
        assert_eq!(s, FeeSplit { escrow: 0, buyback: 70, holder: 30, treasury: 0 });

        assert!(split_platform_fee(1, 0, 0, true, 6_000, 5_000).is_err());
    }

    #[test]
    fn fee_split_always_sums_to_fee() {
        let mut rng = Rng(0xA076_1D64_78BD_642F);
        for _ in 0..20_000 {
            let fee = rng.below(1_000_000_000_000);
            let target = rng.below(5_000_000_000);
            let accrued = rng.below(target.saturating_add(1));
            let buyback = rng.below(10_001) as u16;
            let holder = rng.below(u64::from(10_000 - buyback) + 1) as u16;
            let s = split_platform_fee(fee, accrued, target, rng.next() & 1 == 0, buyback, holder).unwrap();
            assert_eq!(s.total().unwrap(), fee);
            assert!(accrued + s.escrow <= target);
        }
    }
}

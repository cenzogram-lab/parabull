//! Runtime tests for buy / sell: Token-2022 transfers, lamport accounting,
//! slot-delay enforcement, slippage, fee buckets and graduation.
//!
//! Note: Parabull runs as a native processor here, and program-test does not
//! copy a native program's own logs (`msg!` / `emit!`) into transaction
//! metadata. `TradeEvent` / `GraduationReady` are therefore asserted through
//! the state they report; log-level event checks need an SBF build.

mod common;
use common::*;
use parabull::math;

const M: u64 = 1_000_000_000_000; // 1M tokens (6 decimals)

/// Launch a token and warp to its open slot.
async fn open_market(env: &mut Env) -> (Pubkey, Pubkey) {
    let creator = env.funded_user().await;
    let mint = env.launch_token(&creator, 1, "Pepe Coin", "PEPE").await;
    let curve = curve_pda(&mint);
    let c: BondingCurve = env.anchor(&curve).await;
    env.warp_to(c.trading_open_slot).await;
    (mint, curve)
}

/// Curve lamports must equal rent + real SOL + all buckets, exactly.
async fn assert_curve_backed(env: &mut Env, curve: &Pubkey) {
    let c: BondingCurve = env.anchor(curve).await;
    let rent = env.rent_exempt(8 + BondingCurve::INIT_SPACE).await;
    let lamports = env.lamports(curve).await;
    assert_eq!(lamports, rent + c.real_sol_reserves + c.accrued_fees().unwrap(), "curve lamport accounting drifted");
}

#[tokio::test]
async fn trading_rejected_before_open_slot() {
    let mut env = Env::with_global(|g| g.trading_open_delay_slots = 1_000).await;
    let creator = env.funded_user().await;
    let trader = env.funded_user().await;
    let mint = env.launch_token(&creator, 1, "Pepe Coin", "PEPE").await;
    let c: BondingCurve = env.anchor(&curve_pda(&mint)).await;
    assert_eq!(c.trading_open_slot, c.created_slot + 1_000);
    assert!(env.clock().await.slot < c.trading_open_slot);

    // Neither the creator nor anyone else can buy or sell before the open slot.
    assert_custom(env.buy(&creator, &mint, M, u64::MAX).await, ParabullError::TradingNotOpenYet);
    assert_custom(env.buy(&trader, &mint, M, u64::MAX).await, ParabullError::TradingNotOpenYet);
    assert_custom(env.sell(&trader, &mint, M, 0).await, ParabullError::TradingNotOpenYet);

    env.warp_to(c.trading_open_slot - 1).await;
    assert_custom(env.buy(&trader, &mint, M, u64::MAX).await, ParabullError::TradingNotOpenYet);

    env.warp_to(c.trading_open_slot).await;
    env.buy(&trader, &mint, M, u64::MAX).await.unwrap();
    assert_eq!(env.token_balance(&trader.pubkey(), &mint).await, M);
}

#[tokio::test]
async fn buy_moves_exact_lamports_and_tokens() {
    let mut env = Env::new().await;
    let (mint, curve) = open_market(&mut env).await;
    let trader = env.user_with(10 * SOL).await;

    let before: BondingCurve = env.anchor(&curve).await;
    let q = math::quote_buy_exact_tokens(&before.reserves(), 25 * M, DEFAULT_PLATFORM_FEE_BPS).unwrap();
    let user_before = env.lamports(&trader.pubkey()).await;
    let curve_before = env.lamports(&curve).await;
    let curve_tokens_before = env.token_balance(&curve, &mint).await;

    env.buy(&trader, &mint, 25 * M, q.total).await.unwrap();

    // User pays cost + 1% fee (+ rent for their new ATA, which they own).
    let ata_rent = env.lamports(&ata(&trader.pubkey(), &mint)).await;
    assert_eq!(user_before - env.lamports(&trader.pubkey()).await, q.total + ata_rent);
    // The whole payment, fee included, stays in the curve account.
    assert_eq!(env.lamports(&curve).await - curve_before, q.total);
    assert_eq!(env.token_balance(&trader.pubkey(), &mint).await, 25 * M);
    assert_eq!(curve_tokens_before - env.token_balance(&curve, &mint).await, 25 * M);

    let after: BondingCurve = env.anchor(&curve).await;
    assert_eq!(after.real_token_reserves, before.real_token_reserves - 25 * M);
    assert_eq!(after.virtual_token_reserves, before.virtual_token_reserves - 25 * M);
    assert_eq!(after.real_sol_reserves, q.sol_cost);
    assert_eq!(after.virtual_sol_reserves, before.virtual_sol_reserves + q.sol_cost);
    assert_eq!(after.escrow_accrued, q.fee, "below the DexScreener target, the whole fee goes to escrow");
    assert!(!after.complete);
    assert_curve_backed(&mut env, &curve).await;
}

#[tokio::test]
async fn sell_pays_net_and_keeps_fee_in_curve() {
    let mut env = Env::new().await;
    let (mint, curve) = open_market(&mut env).await;
    let trader = env.user_with(10 * SOL).await;
    env.buy(&trader, &mint, 40 * M, u64::MAX).await.unwrap();

    let before: BondingCurve = env.anchor(&curve).await;
    let q = math::quote_sell(&before.reserves(), 15 * M, DEFAULT_PLATFORM_FEE_BPS).unwrap();
    let user_before = env.lamports(&trader.pubkey()).await;
    let curve_before = env.lamports(&curve).await;

    env.sell(&trader, &mint, 15 * M, q.sol_net).await.unwrap();

    assert_eq!(env.lamports(&trader.pubkey()).await - user_before, q.sol_net);
    assert_eq!(curve_before - env.lamports(&curve).await, q.sol_net);
    assert_eq!(env.token_balance(&trader.pubkey(), &mint).await, 25 * M);

    let after: BondingCurve = env.anchor(&curve).await;
    assert_eq!(after.real_token_reserves, before.real_token_reserves + 15 * M);
    assert_eq!(after.real_sol_reserves, before.real_sol_reserves - q.sol_gross);
    assert_eq!(after.escrow_accrued, before.escrow_accrued + q.fee);
    assert_curve_backed(&mut env, &curve).await;

    // Can't sell tokens you don't have.
    assert!(env.sell(&trader, &mint, 26 * M, 0).await.is_err());
}

#[tokio::test]
async fn slippage_limits_are_enforced() {
    let mut env = Env::new().await;
    let (mint, curve) = open_market(&mut env).await;
    let trader = env.user_with(10 * SOL).await;

    let c: BondingCurve = env.anchor(&curve).await;
    let q = math::quote_buy_exact_tokens(&c.reserves(), 30 * M, DEFAULT_PLATFORM_FEE_BPS).unwrap();
    assert_custom(env.buy(&trader, &mint, 30 * M, q.total - 1).await, ParabullError::SlippageExceeded);
    let unchanged: BondingCurve = env.anchor(&curve).await;
    assert_eq!(unchanged.reserves(), c.reserves());
    env.buy(&trader, &mint, 30 * M, q.total).await.unwrap();

    let c: BondingCurve = env.anchor(&curve).await;
    let s = math::quote_sell(&c.reserves(), 10 * M, DEFAULT_PLATFORM_FEE_BPS).unwrap();
    assert_custom(env.sell(&trader, &mint, 10 * M, s.sol_net + 1).await, ParabullError::SlippageExceeded);
    env.sell(&trader, &mint, 10 * M, s.sol_net).await.unwrap();
}

/// Same trade sequence and pinned numbers as the unit test in `trade.rs`,
/// now through the runtime with real token and lamport movement.
#[tokio::test]
async fn fee_buckets_cross_escrow_target_exactly() {
    let mut env = Env::with_global(|g| g.dex_target_lamports = 15_000_000).await;
    let (mint, curve) = open_market(&mut env).await;
    let trader = env.user_with(10 * SOL).await;

    env.buy(&trader, &mint, 10 * M, u64::MAX).await.unwrap();
    env.buy(&trader, &mint, 20 * M, u64::MAX).await.unwrap();
    env.sell(&trader, &mint, 5 * M, 0).await.unwrap();
    let pre: BondingCurve = env.anchor(&curve).await;
    assert_eq!(
        (pre.escrow_accrued, pre.buyback_accrued, pre.holder_accrued, pre.treasury_accrued),
        (2_822_202 + 5_806_754 + 1_472_467, 0, 0, 0),
        "first three fees all land in escrow"
    );
    env.buy(&trader, &mint, 30 * M, u64::MAX).await.unwrap();

    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(
        (c.escrow_accrued, c.buyback_accrued, c.holder_accrued, c.treasury_accrued),
        (15_000_000, 2_076_593, 1_661_274, 415_319)
    );
    assert_eq!(c.real_sol_reserves, 1_620_825_150);
    assert_eq!(env.token_balance(&trader.pubkey(), &mint).await, 55 * M);
    assert_curve_backed(&mut env, &curve).await;
}

#[tokio::test]
async fn final_buy_graduates_and_locks_trading() {
    let mut env = Env::new().await;
    let (mint, curve) = open_market(&mut env).await;
    let whale = env.user_with(100 * SOL).await;
    let small = env.user_with(5 * SOL).await;
    env.buy(&small, &mint, 10 * M, u64::MAX).await.unwrap();

    // Ask for more than remains: partial fill to exactly the remaining real tokens.
    let c: BondingCurve = env.anchor(&curve).await;
    let remaining = c.real_token_reserves;
    env.buy(&whale, &mint, u64::MAX, u64::MAX).await.unwrap();

    let c: BondingCurve = env.anchor(&curve).await;
    assert!(c.complete);
    assert_eq!(c.real_token_reserves, 0);
    assert_eq!(env.token_balance(&whale.pubkey(), &mint).await, remaining);
    // Only the migration allocation is left in the curve's token account.
    assert_eq!(env.token_balance(&curve, &mint).await, DEFAULT_TOKEN_TOTAL_SUPPLY - DEFAULT_INITIAL_REAL_TOKEN_RESERVES);
    assert_curve_backed(&mut env, &curve).await;

    // Net buys of a whole curve generate ~0.86 SOL of 1% fees: below a 2 SOL
    // DexScreener target, so every fee lamport sits in escrow, unfunded.
    let g: Global = env.anchor(&global_pda()).await;
    assert!(!c.is_escrow_funded(&g));
    assert_eq!(c.escrow_accrued, c.accrued_fees().unwrap());
    assert_eq!(c.buyback_accrued + c.holder_accrued + c.treasury_accrued, 0);

    assert_custom(env.buy(&small, &mint, M, u64::MAX).await, ParabullError::CurveComplete);
    assert_custom(env.sell(&small, &mint, M, 0).await, ParabullError::CurveComplete);
}

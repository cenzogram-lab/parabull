//! Runtime tests for set_paused: admin-only, halts launches / trading /
//! buybacks / new reward epochs, leaves refunds, sweeps and escrow open.

mod common;
use common::*;

#[tokio::test]
async fn only_admin_can_pause() {
    let mut env = Env::new().await;
    let crank = env.crank.insecure_clone();
    let stranger = env.funded_user().await;
    for s in [&crank, &stranger] {
        let ix = env.set_paused_ix(&s.pubkey(), true);
        assert_custom(env.send(&[ix], &[s]).await, ParabullError::Unauthorized);
    }
    let g: Global = env.anchor(&global_pda()).await;
    assert!(!g.paused);
}

#[tokio::test]
async fn pause_halts_launches_and_trading_but_not_exits() {
    let mut env = Env::with_global(|g| g.dex_target_lamports = 1_000_000).await;
    let admin = env.admin.insecure_clone();
    let creator = env.funded_user().await;
    let mint = env.launch_token(&creator, 1, "Pepe Coin", "PEPE").await;
    let curve = curve_pda(&mint);
    let c: BondingCurve = env.anchor(&curve).await;
    env.warp_to(c.trading_open_slot).await;
    let trader = env.user_with(10 * SOL).await;
    env.buy(&trader, &mint, 50_000_000_000_000, u64::MAX).await.unwrap();
    // A pending ticket from before the pause.
    let late = env.funded_user().await;
    env.request(&late, 1, "Other Coin", "OTHER", URI).await.unwrap();

    let ix = env.set_paused_ix(&admin.pubkey(), true);
    env.send(&[ix], &[&admin]).await.unwrap();
    assert!(env.anchor::<Global>(&global_pda()).await.paused);

    // Halted.
    let newbie = env.funded_user().await;
    assert_custom(env.request(&newbie, 1, "New Coin", "NEW", URI).await, ParabullError::Paused);
    assert_custom(env.create(&late.pubkey(), 1, "Other Coin", "OTHER", URI).await, ParabullError::Paused);
    assert_custom(env.buy(&trader, &mint, 1_000_000, u64::MAX).await, ParabullError::Paused);
    assert_custom(env.sell(&trader, &mint, 1_000_000, 0).await, ParabullError::Paused);
    let crank = env.crank.insecure_clone();
    let ix = env.prepare_buyback_ix(&crank.pubkey(), 1);
    assert_custom(env.send(&[ix], &[&crank]).await, ParabullError::Paused);
    let ix = env.publish_epoch_ix(&crank.pubkey(), [1; 32], 1, 1).await;
    assert_custom(env.send(&[ix], &[&crank]).await, ParabullError::Paused);

    // Still open: refunds (launch authority rejects the pending ticket), sweeps, escrow release.
    let launch = env.launch.insecure_clone();
    let ix = env.refund_ix(&launch.pubkey(), &late.pubkey(), 1);
    env.send(&[ix], &[&launch]).await.unwrap();
    env.send(&[env.sweep_ix(&mint)], &[]).await.unwrap();
    env.send(&[env.release_ix(&mint)], &[]).await.unwrap();
    assert!(env.anchor::<BondingCurve>(&curve).await.escrow_released);

    // Unpause: trading resumes.
    let ix = env.set_paused_ix(&admin.pubkey(), false);
    env.send(&[ix], &[&admin]).await.unwrap();
    env.buy(&trader, &mint, 1_000_000, u64::MAX).await.unwrap();
}

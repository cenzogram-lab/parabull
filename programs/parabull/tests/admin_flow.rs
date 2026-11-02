//! Runtime tests for update_global_params and the two-step admin transfer.

mod common;
use common::*;
use parabull::state::GlobalUpdate;

#[tokio::test]
async fn admin_updates_params_and_new_launches_use_them() {
    let mut env = Env::new().await;
    let admin = env.admin.insecure_clone();
    let new_config = Pubkey::new_unique();
    let update = GlobalUpdate {
        dex_target_lamports: Some(1_750_000_000),
        buyback_bps: Some(6_000),
        holder_bps: Some(3_500),
        migration_reserve_lamports: Some(300_000_000),
        trading_open_delay_slots: Some(25),
        cpmm_amm_config: Some(new_config),
        ..Default::default()
    };
    let ix = env.update_params_ix(&admin.pubkey(), update);
    env.send(&[ix], &[&admin]).await.unwrap();

    let g: Global = env.anchor(&global_pda()).await;
    let now = env.clock().await.unix_timestamp;
    assert_eq!(g.dex_target_lamports, 1_750_000_000);
    assert_eq!(g.dex_target_updated_at, now);
    assert_eq!((g.buyback_bps, g.holder_bps), (6_000, 3_500));
    assert_eq!(g.migration_reserve_lamports, 300_000_000);
    assert_eq!(g.trading_open_delay_slots, 25);
    assert_eq!(g.cpmm_amm_config, new_config);
    // Untouched fields stay put.
    assert_eq!(g.cpmm_program, common::raydium_mock::CPMM_ID);
    assert_eq!(g.platform_fee_bps, DEFAULT_PLATFORM_FEE_BPS);
    assert_eq!(g.launch_authority, env.launch.pubkey());

    // The new open-slot delay applies to the next launch.
    let creator = env.funded_user().await;
    let mint = env.launch_token(&creator, 1, "Pepe Coin", "PEPE").await;
    let c: BondingCurve = env.anchor(&curve_pda(&mint)).await;
    assert_eq!(c.trading_open_slot, c.created_slot + 25);
}

#[tokio::test]
async fn non_admins_cannot_update() {
    let mut env = Env::new().await;
    let crank = env.crank.insecure_clone();
    let stranger = env.funded_user().await;
    for signer in [&crank, &stranger] {
        let ix = env.update_params_ix(&signer.pubkey(), GlobalUpdate { dex_target_lamports: Some(1), ..Default::default() });
        assert_custom(env.send(&[ix], &[signer]).await, ParabullError::Unauthorized);
        let ix = env.propose_admin_ix(&signer.pubkey(), signer.pubkey());
        assert_custom(env.send(&[ix], &[signer]).await, ParabullError::Unauthorized);
    }
    let g: Global = env.anchor(&global_pda()).await;
    assert_eq!(g.dex_target_lamports, 2 * SOL);
    assert_eq!(g.pending_admin, Pubkey::default());
}

#[tokio::test]
async fn invalid_update_is_rejected_and_nothing_changes() {
    let mut env = Env::new().await;
    let admin = env.admin.insecure_clone();
    let before: Global = env.anchor(&global_pda()).await;
    let cases = [
        (GlobalUpdate { holder_bps: Some(5_001), dex_target_lamports: Some(9), ..Default::default() }, ParabullError::FeeSplitOutOfRange),
        (GlobalUpdate { migration_reserve_lamports: Some(0), ..Default::default() }, ParabullError::InvalidMigrationParams),
        (GlobalUpdate { cpmm_program: Some(Pubkey::default()), ..Default::default() }, ParabullError::InvalidAuthority),
    ];
    for (update, expected) in cases {
        let ix = env.update_params_ix(&admin.pubkey(), update);
        assert_custom(env.send(&[ix], &[&admin]).await, expected);
    }
    let after: Global = env.anchor(&global_pda()).await;
    assert_eq!(after.to_params().holder_bps, before.holder_bps);
    assert_eq!(after.dex_target_lamports, before.dex_target_lamports);
    assert_eq!(after.migration_reserve_lamports, before.migration_reserve_lamports);
    assert_eq!(after.cpmm_program, before.cpmm_program);
}

#[tokio::test]
async fn two_step_admin_transfer() {
    let mut env = Env::new().await;
    let old = env.admin.insecure_clone();
    let new = env.funded_user().await;
    let stranger = env.funded_user().await;

    let ix = env.propose_admin_ix(&old.pubkey(), new.pubkey());
    env.send(&[ix], &[&old]).await.unwrap();
    let g: Global = env.anchor(&global_pda()).await;
    assert_eq!((g.admin, g.pending_admin), (old.pubkey(), new.pubkey()), "proposal alone transfers nothing");

    let ix = env.accept_admin_ix(&stranger.pubkey());
    assert_custom(env.send(&[ix], &[&stranger]).await, ParabullError::NoPendingAdmin);

    let ix = env.accept_admin_ix(&new.pubkey());
    env.send(&[ix], &[&new]).await.unwrap();
    let g: Global = env.anchor(&global_pda()).await;
    assert_eq!((g.admin, g.pending_admin), (new.pubkey(), Pubkey::default()));

    // Old admin is out; new admin is in.
    let ix = env.update_params_ix(&old.pubkey(), GlobalUpdate { trading_open_delay_slots: Some(9), ..Default::default() });
    assert_custom(env.send(&[ix], &[&old]).await, ParabullError::Unauthorized);
    let ix = env.update_params_ix(&new.pubkey(), GlobalUpdate { trading_open_delay_slots: Some(9), ..Default::default() });
    env.send(&[ix], &[&new]).await.unwrap();

    // A proposal can be cancelled by proposing the default key.
    let ix = env.propose_admin_ix(&new.pubkey(), stranger.pubkey());
    env.send(&[ix], &[&new]).await.unwrap();
    let ix = env.propose_admin_ix(&new.pubkey(), Pubkey::default());
    env.send(&[ix], &[&new]).await.unwrap();
    let ix = env.accept_admin_ix(&stranger.pubkey());
    assert_custom(env.send(&[ix], &[&stranger]).await, ParabullError::NoPendingAdmin);
}

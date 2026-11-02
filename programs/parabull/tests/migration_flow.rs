//! Runtime tests for graduation (prepare -> CPMM pool -> Burn & Earn lock),
//! the post-graduation DexScreener escrow, and fee sweeps. Raydium programs
//! are the native mocks in `common/raydium_mock.rs`.

mod common;
use common::raydium_mock::{LOCK_AUTH, LOCK_MARKER, MOCK_CREATE_POOL_FEE, POOL_MARKER};
use common::*;
use parabull::state::{BuybackVault, HolderRewardVault, MigrationStage};

const M: u64 = 1_000_000_000_000;

/// Launch, open trading and buy out the whole curve. Returns (mint, curve).
async fn graduate(env: &mut Env) -> (Pubkey, Pubkey) {
    let creator = env.funded_user().await;
    let mint = env.launch_token(&creator, 1, "Pepe Coin", "PEPE").await;
    let curve = curve_pda(&mint);
    let c: BondingCurve = env.anchor(&curve).await;
    env.warp_to(c.trading_open_slot).await;
    let whale = env.user_with(100 * SOL).await;
    env.buy(&whale, &mint, u64::MAX, u64::MAX).await.unwrap();
    let c: BondingCurve = env.anchor(&curve).await;
    assert!(c.complete);
    (mint, curve)
}

async fn assert_curve_backed(env: &mut Env, curve: &Pubkey) {
    let c: BondingCurve = env.anchor(curve).await;
    let rent = env.rent_exempt(8 + BondingCurve::INIT_SPACE).await;
    assert_eq!(env.lamports(curve).await, rent + c.real_sol_reserves + c.accrued_fees().unwrap());
}

async fn crank_send(env: &mut Env, ixs: &[Instruction], extra: &[&Keypair]) -> Result<(), BanksClientError> {
    let crank = env.crank.insecure_clone();
    let mut signers = vec![&crank];
    signers.extend_from_slice(extra);
    env.send(ixs, &signers).await
}

#[tokio::test]
async fn prepare_requires_complete_curve_and_crank() {
    let mut env = Env::new().await;
    let creator = env.funded_user().await;
    let mint = env.launch_token(&creator, 1, "Pepe Coin", "PEPE").await;
    let c: BondingCurve = env.anchor(&curve_pda(&mint)).await;
    env.warp_to(c.trading_open_slot).await;
    let trader = env.user_with(10 * SOL).await;
    env.buy(&trader, &mint, 10 * M, u64::MAX).await.unwrap();

    let crank = env.crank.pubkey();
    let ix = env.prepare_migration_ix(&crank, &mint);
    assert_custom(crank_send(&mut env, &[ix], &[]).await, ParabullError::CurveNotComplete);

    let whale = env.user_with(100 * SOL).await;
    env.buy(&whale, &mint, u64::MAX, u64::MAX).await.unwrap();

    // Only the crank authority may migrate.
    let ix = env.prepare_migration_ix(&trader.pubkey(), &mint);
    assert_custom(env.send(&[ix], &[&trader]).await, ParabullError::Unauthorized);
}

#[tokio::test]
async fn full_graduation_creates_pool_and_locks_lp() {
    let mut env = Env::new().await;
    let (mint, curve) = graduate(&mut env).await;
    let k = pool_keys(&mint);
    env.seed_cpmm_pool_accounts(&mint);

    let before: BondingCurve = env.anchor(&curve).await;
    let real_sol = before.real_sol_reserves;
    let escrow_at_graduation = before.escrow_accrued;
    let migration_tokens = env.token_balance(&curve, &mint).await;
    assert_eq!(migration_tokens, DEFAULT_TOKEN_TOTAL_SUPPLY - DEFAULT_INITIAL_REAL_TOKEN_RESERVES);
    let crank_before = env.lamports(&env.crank.pubkey()).await;

    // ---- Step 1 alone: state after prepare ----
    let crank = env.crank.pubkey();
    let ix = env.prepare_migration_ix(&crank, &mint);
    crank_send(&mut env, &[ix], &[]).await.unwrap();
    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c.stage(), MigrationStage::Prepared);
    assert_eq!(c.real_sol_reserves, 0);
    assert_eq!(c.migration_sol, real_sol - DEFAULT_MIGRATION_RESERVE_LAMPORTS);
    assert_eq!(c.migration_tokens, migration_tokens);
    assert_eq!(env.lamports(&k.migration_authority).await, real_sol);
    assert_eq!(env.token_balance(&k.migration_authority, &mint).await, migration_tokens);
    assert_eq!(env.token_balance(&curve, &mint).await, 0);
    assert_curve_backed(&mut env, &curve).await;

    // Step 1 cannot run twice.
    let ix = env.prepare_migration_ix(&crank, &mint);
    assert_custom(crank_send(&mut env, &[ix], &[]).await, ParabullError::InvalidMigrationStage);

    // ---- Step 2: CPMM pool ----
    let ix = env.migrate_raydium_ix(&crank, &mint);
    crank_send(&mut env, &[ix], &[]).await.unwrap();
    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c.stage(), MigrationStage::PoolCreated);
    assert!(c.migrated);
    assert_eq!(c.raydium_pool, k.cpmm.pool_state);

    let sol_to_pool = real_sol - DEFAULT_MIGRATION_RESERVE_LAMPORTS;
    let (a0, a1) = k.order.amounts(migration_tokens, sol_to_pool);
    assert_eq!(env.token_amount_at(&k.cpmm.token_0_vault).await, Some(a0));
    assert_eq!(env.token_amount_at(&k.cpmm.token_1_vault).await, Some(a1));
    let pool = env.account(&k.cpmm.pool_state).await.unwrap();
    assert!(pool.data.starts_with(POOL_MARKER));
    assert_eq!(u64::from_le_bytes(pool.data[8..16].try_into().unwrap()), a0);
    let lp = u64::from_le_bytes(pool.data[24..32].try_into().unwrap());
    assert_eq!(env.token_amount_at(&k.cpmm.creator_lp_token).await, Some(lp));
    // Source ATAs closed; their rent went back to the crank, which ends whole.
    assert!(env.account(&ata(&k.migration_authority, &mint)).await.is_none());
    assert_eq!(env.lamports(&env.crank.pubkey()).await, crank_before);
    let lp_ata_rent = env.lamports(&k.cpmm.creator_lp_token).await;
    let auth_after_pool = env.lamports(&k.migration_authority).await;
    assert_eq!(auth_after_pool, DEFAULT_MIGRATION_RESERVE_LAMPORTS - MOCK_CREATE_POOL_FEE - lp_ata_rent);

    // ---- Step 3: Burn & Earn ----
    let nft = Keypair::new();
    let treasury_before = env.lamports(&env.treasury.clone()).await;
    let ix = env.lock_lp_ix(&crank, &mint, &nft.pubkey());
    crank_send(&mut env, &[ix], &[&nft]).await.unwrap();

    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c.stage(), MigrationStage::LpLocked);
    assert_eq!(c.fee_nft_mint, nft.pubkey());
    let lock = parabull::raydium::lock_accounts(&common::raydium_mock::LOCK_ID, &LOCK_AUTH, &nft.pubkey(), &fee_key_vault(), &k.cpmm.lp_mint);
    assert_eq!(env.token_amount_at(&k.cpmm.creator_lp_token).await, Some(0), "all LP left the protocol");
    assert_eq!(env.token_amount_at(&lock.lock_lp_vault).await, Some(lp), "all LP locked");
    assert_eq!(env.token_amount_at(&lock.fee_nft_account).await, Some(1), "fee-key NFT held by the fee-key vault");
    let record = env.account(&lock.locked_liquidity).await.unwrap();
    assert!(record.data.starts_with(LOCK_MARKER));

    // Reserve fully accounted for: lock rents + refund to treasury, PDA emptied.
    let lock_rents = env.lamports(&nft.pubkey()).await + env.lamports(&lock.fee_nft_account).await + env.lamports(&lock.locked_liquidity).await;
    assert_eq!(env.lamports(&k.migration_authority).await, 0);
    assert_eq!(env.lamports(&env.treasury.clone()).await - treasury_before, auth_after_pool - lock_rents);

    // Migration never touches the escrow: it stays open (Option 1).
    assert_eq!(c.escrow_accrued, escrow_at_graduation);
    assert!(!c.escrow_released);
    assert_curve_backed(&mut env, &curve).await;

    // Steps 2 and 3 cannot be replayed. Step 2 closed the migration
    // authority's token ATA, so Anchor rejects the replay at account
    // validation (AccountNotInitialized) before the stage check runs.
    let ix = env.migrate_raydium_ix(&crank, &mint);
    let not_init: u32 = anchor_lang::error::ErrorCode::AccountNotInitialized.into();
    assert_custom_code(crank_send(&mut env, &[ix], &[]).await, not_init, "AccountNotInitialized");
    let nft2 = Keypair::new();
    let ix = env.lock_lp_ix(&crank, &mint, &nft2.pubkey());
    assert_custom(crank_send(&mut env, &[ix], &[&nft2]).await, ParabullError::InvalidMigrationStage);
    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!((c.stage(), c.fee_nft_mint), (MigrationStage::LpLocked, nft.pubkey()));
}

#[tokio::test]
async fn prepare_and_migrate_fit_in_one_transaction() {
    let mut env = Env::new().await;
    let (mint, curve) = graduate(&mut env).await;
    env.seed_cpmm_pool_accounts(&mint);
    let crank = env.crank.pubkey();
    let ixs = [env.prepare_migration_ix(&crank, &mint), env.migrate_raydium_ix(&crank, &mint)];
    crank_send(&mut env, &ixs, &[]).await.unwrap();
    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c.stage(), MigrationStage::PoolCreated);
}

#[tokio::test]
async fn migrate_rejects_substituted_raydium_accounts() {
    let mut env = Env::new().await;
    let (mint, _) = graduate(&mut env).await;
    env.seed_cpmm_pool_accounts(&mint);
    let crank = env.crank.pubkey();
    let ix = env.prepare_migration_ix(&crank, &mint);
    crank_send(&mut env, &[ix], &[]).await.unwrap();
    let k = pool_keys(&mint);

    // A non-canonical pool account.
    let mut ix = env.migrate_raydium_ix(&crank, &mint);
    for m in ix.accounts.iter_mut() {
        if m.pubkey == k.cpmm.pool_state {
            m.pubkey = Pubkey::new_unique();
        }
    }
    assert_custom(crank_send(&mut env, &[ix], &[]).await, ParabullError::InvalidMigrationAccount);

    // A different AmmConfig than the one configured in Global.
    let rogue_config = Pubkey::new_unique();
    env.ctx.set_account(
        &rogue_config,
        &Account { lamports: SOL, data: vec![0; 8], owner: common::raydium_mock::CPMM_ID, executable: false, rent_epoch: 0 }.into(),
    );
    let mut ix = env.migrate_raydium_ix(&crank, &mint);
    for m in ix.accounts.iter_mut() {
        if m.pubkey == AMM_CONFIG {
            m.pubkey = rogue_config;
        }
    }
    assert_custom(crank_send(&mut env, &[ix], &[]).await, ParabullError::InvalidMigrationAccount);

    // The honest call still works afterwards.
    let ix = env.migrate_raydium_ix(&crank, &mint);
    crank_send(&mut env, &[ix], &[]).await.unwrap();
}

#[tokio::test]
async fn token_donation_to_migration_authority_cannot_block_migration() {
    let mut env = Env::new().await;
    let creator = env.funded_user().await;
    let mint = env.launch_token(&creator, 1, "Pepe Coin", "PEPE").await;
    let curve = curve_pda(&mint);
    let c: BondingCurve = env.anchor(&curve).await;
    env.warp_to(c.trading_open_slot).await;
    let whale = env.user_with(100 * SOL).await;
    env.buy(&whale, &mint, u64::MAX, u64::MAX).await.unwrap();
    env.seed_cpmm_pool_accounts(&mint);

    let crank = env.crank.pubkey();
    let ix = env.prepare_migration_ix(&crank, &mint);
    crank_send(&mut env, &[ix], &[]).await.unwrap();

    // Griefer sends 1 raw token unit to the migration authority's ATA.
    let k = pool_keys(&mint);
    let ix = anchor_spl::token_2022::spl_token_2022::instruction::transfer_checked(
        &TOKEN_2022,
        &ata(&whale.pubkey(), &mint),
        &mint,
        &ata(&k.migration_authority, &mint),
        &whale.pubkey(),
        &[],
        1,
        TOKEN_DECIMALS,
    )
    .unwrap();
    env.send(&[ix], &[&whale]).await.unwrap();

    let ix = env.migrate_raydium_ix(&crank, &mint);
    crank_send(&mut env, &[ix], &[]).await.unwrap();
    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c.migration_tokens, DEFAULT_TOKEN_TOTAL_SUPPLY - DEFAULT_INITIAL_REAL_TOKEN_RESERVES + 1, "donation joins the pool");
    let vault = if k.order.mint_is_token_0 { k.cpmm.token_0_vault } else { k.cpmm.token_1_vault };
    assert_eq!(env.token_amount_at(&vault).await, Some(c.migration_tokens));
}

#[tokio::test]
async fn escrow_stays_open_after_graduation_then_tops_up_and_releases_once() {
    let mut env = Env::new().await; // target 2 SOL
    let (mint, curve) = graduate(&mut env).await;
    env.seed_cpmm_pool_accounts(&mint);
    let crank = env.crank.pubkey();
    let nft = Keypair::new();
    let ixs = [env.prepare_migration_ix(&crank, &mint), env.migrate_raydium_ix(&crank, &mint)];
    crank_send(&mut env, &ixs, &[]).await.unwrap();
    let ix = env.lock_lp_ix(&crank, &mint, &nft.pubkey());
    crank_send(&mut env, &[ix], &[&nft]).await.unwrap();

    let c: BondingCurve = env.anchor(&curve).await;
    let target = 2 * SOL;
    assert!(c.escrow_accrued < target && !c.escrow_released, "under-funded but still open after migration");
    assert_custom(env.send(&[env.release_ix(&mint)], &[]).await, ParabullError::EscrowNotFunded);

    // Post-graduation protocol fees (e.g. collected LP fees) top it up; an
    // over-payment is capped at the remaining room, the rest stays with the payer.
    let feeder = env.user_with(10 * SOL).await;
    let room = target - c.escrow_accrued;
    let feeder_before = env.lamports(&feeder.pubkey()).await;
    let ix = env.top_up_ix(&feeder.pubkey(), &mint, 5 * SOL);
    env.send(&[ix], &[&feeder]).await.unwrap();
    assert_eq!(feeder_before - env.lamports(&feeder.pubkey()).await, room);
    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c.escrow_accrued, target);
    assert_curve_backed(&mut env, &curve).await;

    let ix = env.top_up_ix(&feeder.pubkey(), &mint, 1);
    assert_custom(env.send(&[ix], &[&feeder]).await, ParabullError::EscrowAlreadyFunded);

    // Permissionless release: funds can only go to the treasury.
    let treasury_before = env.lamports(&env.treasury.clone()).await;
    env.send(&[env.release_ix(&mint)], &[]).await.unwrap();
    assert_eq!(env.lamports(&env.treasury.clone()).await - treasury_before, target);
    let c: BondingCurve = env.anchor(&curve).await;
    assert!(c.escrow_released);
    assert_eq!(c.escrow_accrued, 0);
    assert_curve_backed(&mut env, &curve).await;

    assert_custom(env.send(&[env.release_ix(&mint)], &[]).await, ParabullError::EscrowAlreadyReleased);
    let ix = env.top_up_ix(&feeder.pubkey(), &mint, SOL);
    assert_custom(env.send(&[ix], &[&feeder]).await, ParabullError::EscrowAlreadyReleased);
}

#[tokio::test]
async fn release_rejects_wrong_treasury() {
    let mut env = Env::with_global(|g| g.dex_target_lamports = 1_000).await;
    let creator = env.funded_user().await;
    let mint = env.launch_token(&creator, 1, "Pepe Coin", "PEPE").await;
    let c: BondingCurve = env.anchor(&curve_pda(&mint)).await;
    env.warp_to(c.trading_open_slot).await;
    let trader = env.user_with(10 * SOL).await;
    env.buy(&trader, &mint, 50 * M, u64::MAX).await.unwrap();

    let mut ix = env.release_ix(&mint);
    let thief = Pubkey::new_unique();
    for m in ix.accounts.iter_mut() {
        if m.pubkey == env.treasury {
            m.pubkey = thief;
        }
    }
    assert_custom(env.send(&[ix], &[]).await, ParabullError::InvalidAuthority);
}

#[tokio::test]
async fn sweep_moves_flywheel_buckets_to_vaults_and_keeps_escrow() {
    let mut env = Env::with_global(|g| g.dex_target_lamports = 10_000_000).await;
    let creator = env.funded_user().await;
    let mint = env.launch_token(&creator, 1, "Pepe Coin", "PEPE").await;
    let curve = curve_pda(&mint);
    let c: BondingCurve = env.anchor(&curve).await;
    env.warp_to(c.trading_open_slot).await;
    let trader = env.user_with(20 * SOL).await;
    env.buy(&trader, &mint, 200 * M, u64::MAX).await.unwrap();
    env.sell(&trader, &mint, 50 * M, 0).await.unwrap();

    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c.escrow_accrued, 10_000_000);
    assert!(c.buyback_accrued > 0 && c.holder_accrued > 0 && c.treasury_accrued > 0);

    let bv_key = pda(&[SEED_BUYBACK_VAULT]);
    let hv_key = pda(&[SEED_HOLDER_VAULT]);
    let (bv0, hv0, tr0) = (env.lamports(&bv_key).await, env.lamports(&hv_key).await, env.lamports(&env.treasury.clone()).await);

    env.send(&[env.sweep_ix(&mint)], &[]).await.unwrap();

    assert_eq!(env.lamports(&bv_key).await - bv0, c.buyback_accrued);
    assert_eq!(env.lamports(&hv_key).await - hv0, c.holder_accrued);
    assert_eq!(env.lamports(&env.treasury.clone()).await - tr0, c.treasury_accrued);
    let bv: BuybackVault = env.anchor(&bv_key).await;
    let hv: HolderRewardVault = env.anchor(&hv_key).await;
    assert_eq!(bv.total_deposited_lamports, c.buyback_accrued);
    assert_eq!(hv.total_deposited_lamports, c.holder_accrued);

    let after: BondingCurve = env.anchor(&curve).await;
    assert_eq!((after.buyback_accrued, after.holder_accrued, after.treasury_accrued), (0, 0, 0));
    assert_eq!(after.escrow_accrued, c.escrow_accrued, "escrow is never swept");
    assert_eq!(after.real_sol_reserves, c.real_sol_reserves, "trading reserves untouched");
    assert_curve_backed(&mut env, &curve).await;

    // A second sweep is a harmless no-op, and trading still works afterwards.
    env.send(&[env.sweep_ix(&mint)], &[]).await.unwrap();
    env.buy(&trader, &mint, M, u64::MAX).await.unwrap();
    assert_curve_backed(&mut env, &curve).await;
}

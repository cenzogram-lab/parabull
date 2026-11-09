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
    let pool_rent = env.lamports(&k.cpmm.pool_state).await;
    let auth_after_pool = env.lamports(&k.migration_authority).await;
    assert_eq!(auth_after_pool, DEFAULT_MIGRATION_RESERVE_LAMPORTS - MOCK_CREATE_POOL_FEE - lp_ata_rent - pool_rent);

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

    // A non-canonical pool account while the canonical pool is free.
    let mut ix = env.migrate_raydium_ix(&crank, &mint);
    let first = ix.accounts.iter().position(|m| m.pubkey == k.cpmm.pool_state).unwrap();
    ix.accounts[first].pubkey = Pubkey::new_unique();
    assert_custom(crank_send(&mut env, &[ix], &[]).await, ParabullError::FreshPoolNotAllowed);

    // A wrong canonical pool account (to hide that the real one is free or taken).
    let mut ix = env.migrate_raydium_ix(&crank, &mint);
    let second = ix.accounts.iter().rposition(|m| m.pubkey == k.cpmm.pool_state).unwrap();
    assert_ne!(first, second);
    ix.accounts[second].pubkey = Pubkey::new_unique();
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

/// Someone creates the canonical CPMM pool for the coin before the crank does (anyone holding the token can: the
/// address depends only on the config and the two mints).
fn squat_canonical_pool(env: &mut Env, mint: &Pubkey) -> Pubkey {
    let k = pool_keys(mint);
    let mut data = vec![0u8; 64];
    data[..8].copy_from_slice(b"SQUATTED");
    env.ctx.set_account(&k.cpmm.pool_state, &Account { lamports: SOL, data, owner: common::raydium_mock::CPMM_ID, executable: false, rent_epoch: 0 }.into());
    k.cpmm.pool_state
}

#[tokio::test]
async fn front_run_canonical_pool_migrates_into_a_fresh_address_pool_and_locks() {
    let mut env = Env::new().await;
    let (mint, curve) = graduate(&mut env).await;
    let crank = env.crank.pubkey();
    let ix = env.prepare_migration_ix(&crank, &mint);
    crank_send(&mut env, &[ix], &[]).await.unwrap();
    let squatted = squat_canonical_pool(&mut env, &mint);

    // The canonical pool can't be used any more, and says so.
    env.seed_cpmm_pool_accounts(&mint);
    let ix = env.migrate_raydium_ix(&crank, &mint);
    assert_custom(crank_send(&mut env, &[ix], &[]).await, ParabullError::CanonicalPoolTaken);

    // A fresh address must sign: an address nobody signed for is refused.
    let fresh = Keypair::new();
    env.seed_cpmm_pool_accounts_at(&mint, Some(&fresh.pubkey()));
    let mut ix = env.migrate_raydium_ix_at(&crank, &mint, Some(&fresh.pubkey()));
    for m in ix.accounts.iter_mut().filter(|m| m.pubkey == fresh.pubkey()) {
        m.is_signer = false;
    }
    assert_custom(crank_send(&mut env, &[ix], &[]).await, ParabullError::InvalidMigrationAccount);

    // The crank's fresh keypair: the pool is created there with all of the migration liquidity.
    let c: BondingCurve = env.anchor(&curve).await;
    let (sol, tokens) = (c.migration_sol, c.migration_tokens);
    let ix = env.migrate_raydium_ix_at(&crank, &mint, Some(&fresh.pubkey()));
    crank_send(&mut env, &[ix], &[&fresh]).await.unwrap();
    let k = pool_keys_at(&mint, Some(&fresh.pubkey()));
    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c.stage(), MigrationStage::PoolCreated);
    assert!(c.migrated);
    assert_eq!(c.raydium_pool, fresh.pubkey(), "the curve records the fresh pool");
    let (a0, a1) = k.order.amounts(tokens, sol);
    assert_eq!(env.token_amount_at(&k.cpmm.token_0_vault).await, Some(a0));
    assert_eq!(env.token_amount_at(&k.cpmm.token_1_vault).await, Some(a1));
    assert!(env.account(&fresh.pubkey()).await.unwrap().data.starts_with(POOL_MARKER));
    assert!(env.account(&squatted).await.unwrap().data.starts_with(b"SQUATTED"), "the squatter's pool is untouched");
    let lp = env.token_amount_at(&k.cpmm.creator_lp_token).await.unwrap();
    assert!(lp > 0);

    // Step 3 locks the fresh pool's LP, found through the curve.
    let nft = Keypair::new();
    let ix = env.lock_lp_ix_at(&crank, &mint, &nft.pubkey(), Some(&fresh.pubkey()));
    crank_send(&mut env, &[ix], &[&nft]).await.unwrap();
    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c.stage(), MigrationStage::LpLocked);
    let lock = parabull::raydium::lock_accounts(&common::raydium_mock::LOCK_ID, &LOCK_AUTH, &nft.pubkey(), &fee_key_vault(), &k.cpmm.lp_mint);
    assert_eq!(env.token_amount_at(&lock.lock_lp_vault).await, Some(lp), "all LP locked");
    assert_curve_backed(&mut env, &curve).await;
}

#[tokio::test]
async fn lock_follows_the_recorded_pool_not_the_canonical_one() {
    let mut env = Env::new().await;
    let (mint, _) = graduate(&mut env).await;
    let crank = env.crank.pubkey();
    let ix = env.prepare_migration_ix(&crank, &mint);
    crank_send(&mut env, &[ix], &[]).await.unwrap();
    squat_canonical_pool(&mut env, &mint);
    let fresh = Keypair::new();
    env.seed_cpmm_pool_accounts_at(&mint, Some(&fresh.pubkey()));
    env.seed_cpmm_pool_accounts(&mint);
    let ix = env.migrate_raydium_ix_at(&crank, &mint, Some(&fresh.pubkey()));
    crank_send(&mut env, &[ix], &[&fresh]).await.unwrap();
    let nft = Keypair::new();
    let ix = env.lock_lp_ix(&crank, &mint, &nft.pubkey());
    assert!(crank_send(&mut env, &[ix], &[&nft]).await.is_err(), "the canonical pool's accounts don't match the curve's pool");
}

/// Launch, buy out the curve, seed the mock pool accounts. Returns (mint, curve, whale).
async fn completed_curve(env: &mut Env) -> (Pubkey, Pubkey, Keypair) {
    let creator = env.funded_user().await;
    let mint = env.launch_token(&creator, 1, "Pepe Coin", "PEPE").await;
    let curve = curve_pda(&mint);
    let c: BondingCurve = env.anchor(&curve).await;
    env.warp_to(c.trading_open_slot).await;
    let whale = env.user_with(100 * SOL).await;
    env.buy(&whale, &mint, u64::MAX, u64::MAX).await.unwrap();
    env.seed_cpmm_pool_accounts(&mint);
    (mint, curve, whale)
}

/// Token-2022 transfer of `amount` raw units from `from`'s ATA to `to_token_account`.
fn donate_tokens_ix(mint: &Pubkey, from: &Keypair, to_token_account: &Pubkey, amount: u64) -> Instruction {
    anchor_spl::token_2022::spl_token_2022::instruction::transfer_checked(
        &TOKEN_2022,
        &ata(&from.pubkey(), mint),
        mint,
        to_token_account,
        &from.pubkey(),
        &[],
        amount,
        TOKEN_DECIMALS,
    )
    .unwrap()
}

const TRACKED: u64 = DEFAULT_TOKEN_TOTAL_SUPPLY - DEFAULT_INITIAL_REAL_TOKEN_RESERVES;

/// Codex review finding: a donation to the curve's ATA used to be counted in
/// the pool amount, so ~10M+ tokens failed the 5% price check forever.
#[tokio::test]
async fn donation_to_curve_ata_is_burned_not_priced() {
    let mut env = Env::new().await;
    let (mint, curve, whale) = completed_curve(&mut env).await;
    // 50M tokens: far past what the 5% bound tolerates when priced on balance.
    let donation = 50 * M;
    env.send(&[donate_tokens_ix(&mint, &whale, &ata(&curve, &mint), donation)], &[&whale]).await.unwrap();
    assert_eq!(env.token_balance(&curve, &mint).await, TRACKED + donation);
    let supply_before = env.mint_supply(&mint).await;

    let crank = env.crank.pubkey();
    let ixs = [env.prepare_migration_ix(&crank, &mint), env.migrate_raydium_ix(&crank, &mint)];
    crank_send(&mut env, &ixs, &[]).await.unwrap();

    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c.migration_tokens, TRACKED, "pool priced and seeded on tracked tokens only");
    assert_eq!(supply_before - env.mint_supply(&mint).await, donation, "the donation was burned");
    assert_eq!(env.token_balance(&curve, &mint).await, 0);
    let k = pool_keys(&mint);
    let token_vault = if k.order.mint_is_token_0 { k.cpmm.token_0_vault } else { k.cpmm.token_1_vault };
    assert_eq!(env.token_amount_at(&token_vault).await, Some(TRACKED));
}

/// Codex review finding: a donation to the migration authority after prepare
/// used to be added to the pool without re-checking the price bound.
#[tokio::test]
async fn donation_to_migration_authority_is_burned_not_added_to_pool() {
    let mut env = Env::new().await;
    let (mint, curve, whale) = completed_curve(&mut env).await;
    let crank = env.crank.pubkey();
    let ix = env.prepare_migration_ix(&crank, &mint);
    crank_send(&mut env, &[ix], &[]).await.unwrap();

    let k = pool_keys(&mint);
    let donation = 30 * M;
    env.send(&[donate_tokens_ix(&mint, &whale, &ata(&k.migration_authority, &mint), donation)], &[&whale]).await.unwrap();
    let supply_before = env.mint_supply(&mint).await;

    let ix = env.migrate_raydium_ix(&crank, &mint);
    crank_send(&mut env, &[ix], &[]).await.unwrap();

    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c.migration_tokens, TRACKED);
    let (token_vault, sol_vault) = if k.order.mint_is_token_0 { (k.cpmm.token_0_vault, k.cpmm.token_1_vault) } else { (k.cpmm.token_1_vault, k.cpmm.token_0_vault) };
    assert_eq!(env.token_amount_at(&token_vault).await, Some(TRACKED), "opening price unaffected");
    assert_eq!(env.token_amount_at(&sol_vault).await, Some(c.migration_sol));
    assert_eq!(supply_before - env.mint_supply(&mint).await, donation, "the donation was burned");
}

#[tokio::test]
async fn wsol_donation_goes_to_treasury_not_pool() {
    let mut env = Env::new().await;
    let (mint, curve, _) = completed_curve(&mut env).await;
    let crank = env.crank.pubkey();
    let ix = env.prepare_migration_ix(&crank, &mint);
    crank_send(&mut env, &[ix], &[]).await.unwrap();

    // A donor creates the migration authority's WSOL account and wraps 3 SOL into it.
    let k = pool_keys(&mint);
    let donor = env.user_with(5 * SOL).await;
    let wsol_ata = anchor_spl::associated_token::get_associated_token_address_with_program_id(&k.migration_authority, &WSOL_MINT, &SPL_TOKEN);
    let donation = 3 * SOL;
    let ixs = [
        anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account(
            &donor.pubkey(),
            &k.migration_authority,
            &WSOL_MINT,
            &SPL_TOKEN,
        ),
        solana_sdk::system_instruction::transfer(&donor.pubkey(), &wsol_ata, donation),
        anchor_spl::token::spl_token::instruction::sync_native(&SPL_TOKEN, &wsol_ata).unwrap(),
    ];
    env.send(&ixs, &[&donor]).await.unwrap();

    let crank_before = env.lamports(&crank).await;
    let ix = env.migrate_raydium_ix(&crank, &mint);
    crank_send(&mut env, &[ix], &[]).await.unwrap();
    let c: BondingCurve = env.anchor(&curve).await;
    let sol_vault = if k.order.mint_is_token_0 { k.cpmm.token_1_vault } else { k.cpmm.token_0_vault };
    assert_eq!(env.token_amount_at(&sol_vault).await, Some(c.migration_sol), "pool SOL is exactly the prepared amount");
    assert!(env.account(&wsol_ata).await.is_none(), "WSOL account unwrapped and closed");
    // The donor paid this account's rent, so the crank (which paid nothing) is
    // refunded that rent: never worse off.
    assert!(env.lamports(&crank).await >= crank_before);

    // The donated SOL sits with the migration authority and reaches the treasury at lock.
    let auth_after_pool = env.lamports(&k.migration_authority).await;
    assert!(auth_after_pool >= donation);
    let treasury_before = env.lamports(&env.treasury.clone()).await;
    let nft = Keypair::new();
    let ix = env.lock_lp_ix(&crank, &mint, &nft.pubkey());
    crank_send(&mut env, &[ix], &[&nft]).await.unwrap();
    let lock = parabull::raydium::lock_accounts(&common::raydium_mock::LOCK_ID, &LOCK_AUTH, &nft.pubkey(), &fee_key_vault(), &k.cpmm.lp_mint);
    let lock_rents = env.lamports(&nft.pubkey()).await + env.lamports(&lock.fee_nft_account).await + env.lamports(&lock.locked_liquidity).await;
    assert_eq!(env.lamports(&env.treasury.clone()).await - treasury_before, auth_after_pool - lock_rents);
    assert_eq!(env.lamports(&k.migration_authority).await, 0);
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

/// The devnet test curve from scripts/src/curveParams.ts `smallCurve(2 SOL,
/// 0.25 SOL)` (values pinned in curveParams.test.ts, cross-checked in Python):
/// graduates at ~2 SOL and passes the on-chain 5% opening-price check.
#[tokio::test]
async fn small_devnet_curve_graduates_and_migrates() {
    const VS0: u64 = 705_837_852;
    const SUPPLY: u64 = 974_125_259_823_200;
    let mut env = Env::with_global(|g| {
        g.initial_virtual_sol_reserves = VS0;
        g.token_total_supply = SUPPLY;
    })
    .await;
    let creator = env.funded_user().await;
    let mint = env.launch_token(&creator, 1, "Pepe Coin", "PEPE").await;
    let curve = curve_pda(&mint);
    let c: BondingCurve = env.anchor(&curve).await;
    env.warp_to(c.trading_open_slot).await;
    let whale = env.user_with(5 * SOL).await;
    env.buy(&whale, &mint, u64::MAX, u64::MAX).await.unwrap();
    let c: BondingCurve = env.anchor(&curve).await;
    assert!(c.complete);
    assert_eq!(c.real_sol_reserves, 2_000_000_002, "graduates at ~2 SOL");

    env.seed_cpmm_pool_accounts(&mint);
    let crank = env.crank.pubkey();
    let ixs = [env.prepare_migration_ix(&crank, &mint), env.migrate_raydium_ix(&crank, &mint)];
    crank_send(&mut env, &ixs, &[]).await.unwrap();
    let nft = Keypair::new();
    let ix = env.lock_lp_ix(&crank, &mint, &nft.pubkey());
    crank_send(&mut env, &[ix], &[&nft]).await.unwrap();

    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c.stage(), MigrationStage::LpLocked);
    assert_eq!(c.migration_sol, 2_000_000_002 - DEFAULT_MIGRATION_RESERVE_LAMPORTS);
    assert_eq!(c.migration_tokens, SUPPLY - DEFAULT_INITIAL_REAL_TOKEN_RESERVES);
}

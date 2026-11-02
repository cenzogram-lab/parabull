//! Runtime tests for collect_lp_fees: harvest via the fee-key NFT and route
//! the measured SOL (escrow first, then buyback / holder vaults / treasury).

mod common;
use anchor_lang::solana_program::program_pack::Pack;
use common::*;
use parabull::state::{BuybackVault, GlobalUpdate, HolderRewardVault, MigrationStage};

struct Balances {
    curve: u64,
    buyback: u64,
    holder: u64,
    treasury: u64,
    crank: u64,
}

async fn balances(env: &mut Env, curve: &Pubkey) -> Balances {
    let treasury = env.treasury;
    let crank = env.crank.pubkey();
    Balances {
        curve: env.lamports(curve).await,
        buyback: env.lamports(&pda(&[SEED_BUYBACK_VAULT])).await,
        holder: env.lamports(&pda(&[SEED_HOLDER_VAULT])).await,
        treasury: env.lamports(&treasury).await,
        crank: env.lamports(&crank).await,
    }
}

/// (wsol vault, token vault) of the graduated pool.
fn pool_vaults(mint: &Pubkey) -> (Pubkey, Pubkey) {
    let k = pool_keys(mint);
    if k.order.mint_is_token_0 {
        (k.cpmm.token_1_vault, k.cpmm.token_0_vault)
    } else {
        (k.cpmm.token_0_vault, k.cpmm.token_1_vault)
    }
}

async fn locked_lp(env: &mut Env, mint: &Pubkey) -> u64 {
    let k = pool_keys(mint);
    let v = anchor_spl::associated_token::get_associated_token_address_with_program_id(&common::raydium_mock::LOCK_AUTH, &k.cpmm.lp_mint, &SPL_TOKEN);
    env.token_amount_at(&v).await.unwrap()
}

async fn assert_curve_backed(env: &mut Env, curve: &Pubkey) {
    let c: BondingCurve = env.anchor(curve).await;
    let rent = env.rent_exempt(8 + BondingCurve::INIT_SPACE).await;
    assert_eq!(env.lamports(curve).await, rent + c.real_sol_reserves + c.accrued_fees().unwrap());
}

#[tokio::test]
async fn harvest_fills_escrow_first_then_pays_vaults() {
    let mut env = Env::new().await; // target 2 SOL, buyback 50%, holder 40%
    let (mint, curve, nft) = env.graduate_and_lock().await;
    let c0: BondingCurve = env.anchor(&curve).await;
    let target = 2 * SOL;
    let room = target - c0.escrow_accrued;
    let (wsol_vault, token_vault) = pool_vaults(&mint);
    let wsol_before = env.token_amount_at(&wsol_vault).await.unwrap();
    let token_before = env.token_amount_at(&token_vault).await.unwrap();
    let fee_lp = locked_lp(&mut env, &mint).await * 3 / 100;
    let b0 = balances(&mut env, &curve).await;
    let supply_before = env.mint_supply(&mint).await;

    let crank = env.crank.insecure_clone();
    let ix = env.collect_lp_fees_ix(&crank.pubkey(), &mint, &c0.raydium_pool, &nft, fee_lp);
    env.send(&[ix], &[&crank]).await.unwrap();

    // What Raydium actually paid out.
    let sol = wsol_before - env.token_amount_at(&wsol_vault).await.unwrap();
    let tokens = token_before - env.token_amount_at(&token_vault).await.unwrap();
    assert!(sol > room, "precondition: harvest crosses the escrow target ({sol} vs room {room})");

    let rest = sol - room;
    let (buyback, holder) = (rest * 5_000 / 10_000, rest * 4_000 / 10_000);
    let treasury_part = rest - buyback - holder;
    let b1 = balances(&mut env, &curve).await;
    assert_eq!(b1.curve - b0.curve, room, "escrow topped up to exactly the target");
    assert_eq!(b1.buyback - b0.buyback, buyback);
    assert_eq!(b1.holder - b0.holder, holder);
    assert_eq!(b1.treasury - b0.treasury, treasury_part);

    let vault = fee_key_vault();
    assert_eq!(b1.crank, b0.crank, "both temporary accounts' rent refunded to the crank");
    assert_eq!(supply_before - env.mint_supply(&mint).await, tokens, "token side burned: supply reduced");
    assert!(env.account(&ata(&vault, &mint)).await.is_none(), "token account closed; protocol holds no launched tokens");
    assert_eq!(env.lamports(&vault).await, 0, "vault PDA keeps no SOL");
    let wsol_ata = anchor_spl::associated_token::get_associated_token_address_with_program_id(&vault, &WSOL_MINT, &SPL_TOKEN);
    assert!(env.account(&wsol_ata).await.is_none(), "temporary WSOL account closed");

    let c1: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c1.escrow_accrued, target);
    assert_eq!((c1.lp_fees_sol_collected, c1.lp_fees_tokens_burned), (sol, tokens));
    let bv: BuybackVault = env.anchor(&pda(&[SEED_BUYBACK_VAULT])).await;
    let hv: HolderRewardVault = env.anchor(&pda(&[SEED_HOLDER_VAULT])).await;
    assert_eq!((bv.total_deposited_lamports, hv.total_deposited_lamports), (buyback, holder));
    assert_curve_backed(&mut env, &curve).await;

    // Release the listing fund, then harvest again: nothing goes to escrow now.
    env.send(&[env.release_ix(&mint)], &[]).await.unwrap();
    let b2 = balances(&mut env, &curve).await;
    let wsol_before = env.token_amount_at(&wsol_vault).await.unwrap();
    let ix = env.collect_lp_fees_ix(&crank.pubkey(), &mint, &c0.raydium_pool, &nft, fee_lp / 3);
    env.send(&[ix], &[&crank]).await.unwrap();
    let sol2 = wsol_before - env.token_amount_at(&wsol_vault).await.unwrap();
    let b3 = balances(&mut env, &curve).await;
    assert_eq!(b3.curve, b2.curve, "released escrow is not refilled");
    assert_eq!(b3.buyback - b2.buyback, sol2 * 5_000 / 10_000);
    assert_eq!(b3.holder - b2.holder, sol2 * 4_000 / 10_000);
    assert_eq!(b3.crank, b2.crank, "second harvest costs the crank nothing");
    let c2: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c2.lp_fees_sol_collected, sol + sol2);
    assert_curve_backed(&mut env, &curve).await;
}

#[tokio::test]
async fn collect_requires_crank_locked_lp_and_amount() {
    let mut env = Env::new().await;
    let (mint, curve, nft) = env.graduate_and_lock().await;
    let pool = env.anchor::<BondingCurve>(&curve).await.raydium_pool;

    let stranger = env.funded_user().await;
    let ix = env.collect_lp_fees_ix(&stranger.pubkey(), &mint, &pool, &nft, 1_000);
    assert_custom(env.send(&[ix], &[&stranger]).await, ParabullError::Unauthorized);

    let crank = env.crank.insecure_clone();
    let ix = env.collect_lp_fees_ix(&crank.pubkey(), &mint, &pool, &nft, 0);
    assert_custom(env.send(&[ix], &[&crank]).await, ParabullError::ZeroAmount);

    // A fee NFT that isn't this curve's recorded one.
    let ix = env.collect_lp_fees_ix(&crank.pubkey(), &mint, &pool, &Pubkey::new_unique(), 1_000);
    assert_custom(env.send(&[ix], &[&crank]).await, ParabullError::InvalidMigrationAccount);
}

#[tokio::test]
async fn collect_rejected_before_lp_is_locked() {
    let mut env = Env::new().await;
    let creator = env.funded_user().await;
    let mint = env.launch_token(&creator, 1, "Pepe Coin", "PEPE").await;
    let curve = curve_pda(&mint);
    let c: BondingCurve = env.anchor(&curve).await;
    env.warp_to(c.trading_open_slot).await;
    let whale = env.user_with(100 * SOL).await;
    env.buy(&whale, &mint, u64::MAX, u64::MAX).await.unwrap();
    env.seed_cpmm_pool_accounts(&mint);
    let crank = env.crank.insecure_clone();
    let ixs = [env.prepare_migration_ix(&crank.pubkey(), &mint), env.migrate_raydium_ix(&crank.pubkey(), &mint)];
    env.send(&ixs, &[&crank]).await.unwrap();
    let c: BondingCurve = env.anchor(&curve).await;
    assert_eq!(c.stage(), MigrationStage::PoolCreated);

    let ix = env.collect_lp_fees_ix(&crank.pubkey(), &mint, &c.raydium_pool, &Pubkey::default(), 1_000);
    assert_custom(env.send(&[ix], &[&crank]).await, ParabullError::InvalidMigrationStage);
}

#[tokio::test]
async fn amm_config_change_does_not_orphan_graduated_pools() {
    let mut env = Env::new().await;
    let (mint, curve, nft) = env.graduate_and_lock().await;
    let pool = env.anchor::<BondingCurve>(&curve).await.raydium_pool;

    let admin = env.admin.insecure_clone();
    let ix = env.update_params_ix(&admin.pubkey(), GlobalUpdate { cpmm_amm_config: Some(Pubkey::new_unique()), ..Default::default() });
    env.send(&[ix], &[&admin]).await.unwrap();

    let fee_lp = locked_lp(&mut env, &mint).await / 100;
    let crank = env.crank.insecure_clone();
    let ix = env.collect_lp_fees_ix(&crank.pubkey(), &mint, &pool, &nft, fee_lp);
    env.send(&[ix], &[&crank]).await.unwrap();
    let c: BondingCurve = env.anchor(&curve).await;
    assert!(c.lp_fees_sol_collected > 0);
}

#[tokio::test]
async fn lp_mint_supply_unchanged_by_harvest() {
    // Harvest pays from pool vaults; it must not touch the locked LP itself.
    let mut env = Env::new().await;
    let (mint, curve, nft) = env.graduate_and_lock().await;
    let pool = env.anchor::<BondingCurve>(&curve).await.raydium_pool;
    let locked_before = locked_lp(&mut env, &mint).await;
    let k = pool_keys(&mint);
    let supply = |acc: Account| anchor_spl::token::spl_token::state::Mint::unpack_from_slice(&acc.data).unwrap().supply;
    let supply_before = supply(env.account(&k.cpmm.lp_mint).await.unwrap());

    let crank = env.crank.insecure_clone();
    let ix = env.collect_lp_fees_ix(&crank.pubkey(), &mint, &pool, &nft, locked_before / 50);
    env.send(&[ix], &[&crank]).await.unwrap();

    assert_eq!(locked_lp(&mut env, &mint).await, locked_before);
    assert_eq!(supply(env.account(&k.cpmm.lp_mint).await.unwrap()), supply_before);
}

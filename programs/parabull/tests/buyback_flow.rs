//! Runtime tests for prepare_buyback + buyback_and_burn against the CPMM mock's
//! constant-product swap (no fee): out = r_out * in / (r_in + in).

mod common;
use common::raydium_mock::MOCK_SLIPPAGE_ERROR;
use common::*;
use parabull::state::BuybackVault;

const WSOL_LIQ: u64 = 500 * SOL;
const PB_LIQ: u64 = 1_000_000_000_000_000; // 1B tokens, 6 decimals

fn expected_out(amount_in: u64) -> u64 {
    (u128::from(PB_LIQ) * u128::from(amount_in) / (u128::from(WSOL_LIQ) + u128::from(amount_in))) as u64
}

async fn funded_env() -> (Env, ParabullPool) {
    let mut env = Env::new().await;
    let p = env.setup_parabull_pool(WSOL_LIQ, PB_LIQ).await;
    env.fund_account(&pda(&[SEED_BUYBACK_VAULT]), 10 * SOL).await;
    (env, p)
}

#[tokio::test]
async fn buyback_swaps_and_burns_everything_received() {
    let (mut env, p) = funded_env().await;
    let crank = env.crank.insecure_clone();
    let vault_key = pda(&[SEED_BUYBACK_VAULT]);
    let vault_before = env.lamports(&vault_key).await;
    let crank_before = env.lamports(&crank.pubkey()).await;
    let supply_before = env.mint_supply(&p.mint).await;
    let amount = 3 * SOL;
    let out = expected_out(amount);

    let ixs = [env.prepare_buyback_ix(&crank.pubkey(), amount), env.buyback_and_burn_ix(&crank.pubkey(), &p, out)];
    env.send(&ixs, &[&crank]).await.unwrap();

    assert_eq!(vault_before - env.lamports(&vault_key).await, amount);
    assert_eq!(supply_before - env.mint_supply(&p.mint).await, out, "every token bought was burned");
    assert_eq!(env.token_amount_at(&p.wsol_vault).await, Some(WSOL_LIQ + amount), "SOL went into the pool");
    assert_eq!(env.token_amount_at(&p.parabull_vault).await, Some(PB_LIQ - out));
    let auth = buyback_authority();
    assert_eq!(env.lamports(&auth).await, 0, "no SOL left staged");
    assert!(env.account(&ata(&auth, &p.mint)).await.is_none(), "temporary $PARABULL account closed");
    assert_eq!(env.lamports(&crank.pubkey()).await, crank_before, "crank's temporary rent refunded");

    let v: BuybackVault = env.anchor(&vault_key).await;
    assert_eq!((v.total_spent_lamports, v.total_tokens_burned, v.buyback_count), (amount, out, 1));
    assert!(v.last_buyback_at > 0);
}

#[tokio::test]
async fn slippage_floor_is_enforced_atomically() {
    let (mut env, p) = funded_env().await;
    let crank = env.crank.insecure_clone();
    let vault_key = pda(&[SEED_BUYBACK_VAULT]);
    let vault_before = env.lamports(&vault_key).await;
    let supply_before = env.mint_supply(&p.mint).await;
    let amount = 2 * SOL;

    // One token unit more than the pool can give: the swap fails, the whole
    // transaction (including the staging step) reverts.
    let ixs = [env.prepare_buyback_ix(&crank.pubkey(), amount), env.buyback_and_burn_ix(&crank.pubkey(), &p, expected_out(amount) + 1)];
    assert_custom_code(env.send(&ixs, &[&crank]).await, MOCK_SLIPPAGE_ERROR, "CPMM ExceededSlippage");
    assert_eq!(env.lamports(&vault_key).await, vault_before);
    assert_eq!(env.mint_supply(&p.mint).await, supply_before);

    // A zero floor is refused outright (no unprotected buybacks).
    let ixs = [env.prepare_buyback_ix(&crank.pubkey(), amount), env.buyback_and_burn_ix(&crank.pubkey(), &p, 0)];
    assert_custom(env.send(&ixs, &[&crank]).await, ParabullError::SlippageExceeded);
}

#[tokio::test]
async fn buyback_keeps_vault_rent_exempt_and_is_crank_only() {
    let (mut env, p) = funded_env().await;
    let crank = env.crank.insecure_clone();
    let vault_key = pda(&[SEED_BUYBACK_VAULT]);
    let rent = env.rent_exempt(8 + BuybackVault::INIT_SPACE).await;
    let spendable = env.lamports(&vault_key).await - rent;

    let ix = env.prepare_buyback_ix(&crank.pubkey(), spendable + 1);
    assert_custom(env.send(&[ix], &[&crank]).await, ParabullError::InsufficientVaultBalance);

    let stranger = env.funded_user().await;
    let ix = env.prepare_buyback_ix(&stranger.pubkey(), SOL);
    assert_custom(env.send(&[ix], &[&stranger]).await, ParabullError::Unauthorized);
    let ix = env.buyback_and_burn_ix(&stranger.pubkey(), &p, 1);
    assert_custom(env.send(&[ix], &[&stranger]).await, ParabullError::Unauthorized);

    // Spending exactly everything above rent works and leaves the vault rent-exempt.
    let ixs = [env.prepare_buyback_ix(&crank.pubkey(), spendable), env.buyback_and_burn_ix(&crank.pubkey(), &p, expected_out(spendable))];
    env.send(&ixs, &[&crank]).await.unwrap();
    assert_eq!(env.lamports(&vault_key).await, rent);
}

#[tokio::test]
async fn buyback_requires_configured_pool() {
    let mut env = Env::new().await; // parabull_pool not set
    env.fund_account(&pda(&[SEED_BUYBACK_VAULT]), SOL).await;
    let crank = env.crank.insecure_clone();
    let ix = env.prepare_buyback_ix(&crank.pubkey(), SOL / 2);
    assert_custom(env.send(&[ix], &[&crank]).await, ParabullError::BuybackNotConfigured);
}

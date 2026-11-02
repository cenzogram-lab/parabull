//! Runtime tests for request_launch / refund_ticket / create.

mod common;
use common::*;

#[tokio::test]
async fn request_launch_escrows_deposit_and_commits_metadata() {
    let mut env = Env::new().await;
    let user = env.funded_user().await;
    let before = env.lamports(&user.pubkey()).await;
    env.request(&user, 1, "Pepe Coin", "PEPE", URI).await.unwrap();

    let key = ticket_pda(&user.pubkey(), 1);
    let t: LaunchTicket = env.anchor(&key).await;
    let now = env.clock().await.unix_timestamp;
    assert_eq!(t.payer, user.pubkey());
    assert_eq!(t.nonce, 1);
    assert_eq!(t.deposit_lamports, DEFAULT_TICKET_DEPOSIT_LAMPORTS);
    assert_eq!(t.launch_fee_lamports, DEFAULT_LAUNCH_FEE_LAMPORTS);
    assert_eq!(t.ticker(), b"PEPE");
    assert_eq!(t.name_hash, normalize_name_hash("pepe coin").unwrap());
    assert_eq!(t.metadata_hash, metadata_commitment("Pepe Coin", "PEPE", URI));
    assert_eq!(t.expires_at, t.created_at + DEFAULT_TICKET_TTL_SECONDS);
    assert!(t.created_at <= now);

    let ticket_lamports = env.lamports(&key).await;
    let rent = ticket_lamports - DEFAULT_TICKET_DEPOSIT_LAMPORTS;
    assert_eq!(before - env.lamports(&user.pubkey()).await, DEFAULT_TICKET_DEPOSIT_LAMPORTS + rent);
}

#[tokio::test]
async fn request_launch_rejects_non_canonical_symbol() {
    let mut env = Env::new().await;
    let user = env.funded_user().await;
    assert_custom(env.request(&user, 1, "Pepe", "pepe", URI).await, ParabullError::NonCanonicalSymbol);
    assert_custom(env.request(&user, 2, "Pepe", "PE-PE", URI).await, ParabullError::InvalidTicker);
}

#[tokio::test]
async fn create_consumes_ticket_and_launches_token() {
    let mut env = Env::new().await;
    let user = env.funded_user().await;
    env.request(&user, 7, "Pepe Coin", "PEPE", URI).await.unwrap();

    let ticket_key = ticket_pda(&user.pubkey(), 7);
    let ticket_lamports = env.lamports(&ticket_key).await;
    let ticket_rent = ticket_lamports - DEFAULT_TICKET_DEPOSIT_LAMPORTS;
    let user_before = env.lamports(&user.pubkey()).await;
    let treasury_before = env.lamports(&env.treasury.clone()).await;
    let launch_key = env.launch.pubkey();
    let launch_before = env.lamports(&launch_key).await;

    let mint = env.create(&user.pubkey(), 7, "Pepe Coin", "PEPE", URI).await.unwrap();
    let slot = env.clock().await.slot;
    let now = env.clock().await.unix_timestamp;

    // Ticket closed; its rent goes back to the payer.
    assert!(env.account(&ticket_key).await.is_none());
    assert_eq!(env.lamports(&user.pubkey()).await, user_before + ticket_rent);
    // 0.2 SOL to treasury.
    assert_eq!(env.lamports(&env.treasury.clone()).await, treasury_before + DEFAULT_LAUNCH_FEE_LAMPORTS);
    // Launch authority is reimbursed 0.03 SOL, which more than covers the rent it fronted.
    let launch_after = env.lamports(&launch_key).await;
    assert!(launch_after < launch_before + 30_000_000);
    assert!(launch_after > launch_before, "0.03 SOL reimbursement must cover rent: before={launch_before} after={launch_after}");

    // Curve.
    let curve_key = pda(&[SEED_BONDING_CURVE, mint.as_ref()]);
    let c: BondingCurve = env.anchor(&curve_key).await;
    assert_eq!(c.mint, mint);
    assert_eq!(c.creator, user.pubkey());
    assert!(!c.complete && !c.migrated && !c.escrow_released);
    assert_eq!(c.virtual_token_reserves, DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES);
    assert_eq!(c.virtual_sol_reserves, DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES);
    assert_eq!(c.real_token_reserves, DEFAULT_INITIAL_REAL_TOKEN_RESERVES);
    assert_eq!(c.real_sol_reserves, 0);
    assert_eq!(c.trading_open_slot, c.created_slot + DEFAULT_TRADING_OPEN_DELAY_SLOTS);
    assert!(c.created_slot <= slot);
    assert!(!c.is_trading_open(c.created_slot), "no trading in the creation slot");

    // Mint: fixed supply, no mint/freeze authority, immutable metadata.
    let mint_acc = env.account(&mint).await.unwrap();
    assert_eq!(mint_acc.owner, TOKEN_2022);
    let m = StateWithExtensions::<SplMint>::unpack(&mint_acc.data).unwrap();
    assert_eq!(m.base.decimals, TOKEN_DECIMALS);
    assert_eq!(m.base.supply, DEFAULT_TOKEN_TOTAL_SUPPLY);
    assert!(m.base.mint_authority.is_none());
    assert!(m.base.freeze_authority.is_none());
    let md = m.get_variable_len_extension::<TokenMetadata>().unwrap();
    assert_eq!((md.name.as_str(), md.symbol.as_str(), md.uri.as_str()), ("Pepe Coin", "PEPE", URI));
    assert_eq!(Option::<Pubkey>::from(md.update_authority), None);

    // Whole supply sits in the curve's ATA.
    let ata_acc = env.account(&ata(&curve_key, &mint)).await.unwrap();
    let ta = StateWithExtensions::<SplTokenAccount>::unpack(&ata_acc.data).unwrap();
    assert_eq!(ta.base.amount, DEFAULT_TOKEN_TOTAL_SUPPLY);
    assert_eq!(ta.base.owner, curve_key);

    // Registry locks.
    let tr: TickerRegistry = env.anchor(&pda(&[SEED_TICKER_REGISTRY, b"PEPE"])).await;
    assert_eq!((tr.mint, &tr.ticker[..usize::from(tr.ticker_len)]), (mint, &b"PEPE"[..]));
    assert!(tr.launch_timestamp <= now);
    let nr: NameRegistry = env.anchor(&pda(&[SEED_NAME_REGISTRY, &normalize_name_hash("Pepe Coin").unwrap()])).await;
    assert_eq!(nr.mint, mint);

    let g: Global = env.anchor(&global_pda()).await;
    assert_eq!(g.launch_count, 1);
}

#[tokio::test]
async fn registry_blocks_duplicates_and_lookalikes_for_three_days() {
    let mut env = Env::new().await;
    let alice = env.funded_user().await;
    let bob = env.funded_user().await;
    env.request(&alice, 1, "Pepe Coin", "PEPE", URI).await.unwrap();
    let first = env.create(&alice.pubkey(), 1, "Pepe Coin", "PEPE", URI).await.unwrap();

    // Same ticker, different name.
    env.request(&bob, 1, "Totally Different", "PEPE", URI).await.unwrap();
    assert_custom(env.create(&bob.pubkey(), 1, "Totally Different", "PEPE", URI).await, ParabullError::TickerLocked);

    // Different ticker, lookalike name (case + whitespace).
    env.request(&bob, 2, "PEPE   coin", "PEPE2", URI).await.unwrap();
    assert_custom(env.create(&bob.pubkey(), 2, "PEPE   coin", "PEPE2", URI).await, ParabullError::NameLocked);

    // The backend rejects both tickets immediately instead of making Bob wait.
    let launch = env.launch.insecure_clone();
    let bob_before = env.lamports(&bob.pubkey()).await;
    let t1 = env.lamports(&ticket_pda(&bob.pubkey(), 1)).await;
    let t2 = env.lamports(&ticket_pda(&bob.pubkey(), 2)).await;
    let ixs = [env.refund_ix(&launch.pubkey(), &bob.pubkey(), 1), env.refund_ix(&launch.pubkey(), &bob.pubkey(), 2)];
    env.send(&ixs, &[&launch]).await.unwrap();
    assert_eq!(env.lamports(&bob.pubkey()).await, bob_before + t1 + t2);

    // Just before the lock lapses: still blocked.
    env.advance(3 * DAY - 120).await;
    env.request(&bob, 3, "Pepe Coin", "PEPE", URI).await.unwrap();
    assert_custom(env.create(&bob.pubkey(), 3, "Pepe Coin", "PEPE", URI).await, ParabullError::TickerLocked);

    // After 3 days: the same ticker and name can be launched again; registries now point at the new mint.
    env.advance(180).await;
    let second = env.create(&bob.pubkey(), 3, "Pepe Coin", "PEPE", URI).await.unwrap();
    assert_ne!(first, second);
    let tr: TickerRegistry = env.anchor(&pda(&[SEED_TICKER_REGISTRY, b"PEPE"])).await;
    assert_eq!(tr.mint, second);
    let nr: NameRegistry = env.anchor(&pda(&[SEED_NAME_REGISTRY, &normalize_name_hash("Pepe Coin").unwrap()])).await;
    assert_eq!(nr.mint, second);
}

#[tokio::test]
async fn create_rejects_wrong_metadata_signer_and_expired_ticket() {
    let mut env = Env::new().await;
    let user = env.funded_user().await;
    env.request(&user, 1, "Pepe Coin", "PEPE", URI).await.unwrap();

    // Backend cannot swap the URI (or any field) the user paid for.
    assert_custom(
        env.create(&user.pubkey(), 1, "Pepe Coin", "PEPE", "https://evil.example/x.json").await,
        ParabullError::MetadataMismatch,
    );

    // Only the launch authority can create.
    let impostor = env.funded_user().await;
    let mint = Keypair::new();
    let ix = env.create_ix(&impostor.pubkey(), &user.pubkey(), 1, &mint.pubkey(), "Pepe Coin", "PEPE", URI);
    assert_custom(env.send(&[ix], &[&impostor, &mint]).await, ParabullError::Unauthorized);

    // The mint keypair must sign (blind launch: the backend holds it).
    let mint = Keypair::new();
    let launch = env.launch.insecure_clone();
    let mut ix = env.create_ix(&launch.pubkey(), &user.pubkey(), 1, &mint.pubkey(), "Pepe Coin", "PEPE", URI);
    for meta in ix.accounts.iter_mut() {
        if meta.pubkey == mint.pubkey() {
            meta.is_signer = false;
        }
    }
    assert!(env.send(&[ix], &[&launch]).await.is_err());

    // Expired tickets cannot be consumed.
    env.advance(DEFAULT_TICKET_TTL_SECONDS).await;
    assert_custom(env.create(&user.pubkey(), 1, "Pepe Coin", "PEPE", URI).await, ParabullError::TicketExpired);
}

#[tokio::test]
async fn payer_refund_only_after_expiry_and_strangers_never() {
    let mut env = Env::new().await;
    let user = env.funded_user().await;
    let stranger = env.funded_user().await;
    env.request(&user, 9, "Pepe Coin", "PEPE", URI).await.unwrap();
    let key = ticket_pda(&user.pubkey(), 9);

    let ix = env.refund_ix(&user.pubkey(), &user.pubkey(), 9);
    assert_custom(env.send(&[ix], &[&user]).await, ParabullError::TicketNotExpired);

    let ix = env.refund_ix(&stranger.pubkey(), &user.pubkey(), 9);
    assert_custom(env.send(&[ix], &[&stranger]).await, ParabullError::Unauthorized);

    // Refund can't be redirected to someone else's wallet.
    let ix = env.refund_ix(&stranger.pubkey(), &stranger.pubkey(), 9);
    assert!(env.send(&[ix], &[&stranger]).await.is_err());

    env.advance(DEFAULT_TICKET_TTL_SECONDS).await;
    let before = env.lamports(&user.pubkey()).await;
    let held = env.lamports(&key).await;
    let ix = env.refund_ix(&user.pubkey(), &user.pubkey(), 9);
    // The test harness payer covers the tx fee, so the user gets back exactly deposit + rent.
    env.send(&[ix], &[&user]).await.unwrap();
    assert!(env.account(&key).await.is_none());
    assert_eq!(env.lamports(&user.pubkey()).await, before + held);
}

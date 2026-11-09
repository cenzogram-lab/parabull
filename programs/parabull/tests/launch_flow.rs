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

    // Flat price: the user pays exactly 0.230 SOL all-in (the harness payer
    // covers the network fee), and the ticket holds exactly that, rent included.
    assert_eq!(before - env.lamports(&user.pubkey()).await, DEFAULT_TICKET_DEPOSIT_LAMPORTS);
    assert_eq!(env.lamports(&key).await, DEFAULT_TICKET_DEPOSIT_LAMPORTS);
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
    assert_eq!(env.lamports(&ticket_key).await, DEFAULT_TICKET_DEPOSIT_LAMPORTS);
    let user_before = env.lamports(&user.pubkey()).await;
    let treasury_before = env.lamports(&env.treasury.clone()).await;
    let launch_key = env.launch.pubkey();
    let launch_before = env.lamports(&launch_key).await;

    let mint = env.create(&user.pubkey(), 7, "Pepe Coin", "PEPE", URI).await.unwrap();
    let slot = env.clock().await.slot;
    let now = env.clock().await.unix_timestamp;

    // Ticket closed; the user's 0.230 SOL is fully spent (nothing comes back).
    assert!(env.account(&ticket_key).await.is_none());
    assert_eq!(env.lamports(&user.pubkey()).await, user_before);
    // 0.2 SOL to treasury.
    // The launch authority is repaid exactly the rent it fronted: it ends whole.
    assert_eq!(env.lamports(&launch_key).await, launch_before, "launch authority neither gains nor loses");
    // Treasury gets the whole ticket minus that rent: 0.2 SOL fee + the unspent allocation.
    let curve_key = pda(&[SEED_BONDING_CURVE, mint.as_ref()]);
    let rent_fronted = env.lamports(&mint).await
        + env.lamports(&curve_key).await
        + env.lamports(&ata(&curve_key, &mint)).await
        + env.lamports(&pda(&[SEED_TICKER_REGISTRY, b"PEPE"])).await
        + env.lamports(&pda(&[SEED_NAME_REGISTRY, &normalize_name_hash("Pepe Coin").unwrap()])).await;
    let treasury_gain = env.lamports(&env.treasury.clone()).await - treasury_before;
    assert_eq!(treasury_gain, DEFAULT_TICKET_DEPOSIT_LAMPORTS - rent_fronted);
    assert!(treasury_gain > DEFAULT_LAUNCH_FEE_LAMPORTS && rent_fronted < 30_000_000, "rent {rent_fronted} fits the 0.03 allocation");

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
    // Bob buys a ticket for the same ticker before Alice's coin exists: allowed (nothing holds it yet)...
    env.request(&bob, 1, "Totally Different", "PEPE", URI).await.unwrap();
    let first = env.create(&alice.pubkey(), 1, "Pepe Coin", "PEPE", URI).await.unwrap();

    // ...but `create` still enforces the lock, so the race's loser can't launch.
    assert_custom(env.create(&bob.pubkey(), 1, "Totally Different", "PEPE", URI).await, ParabullError::TickerLocked);
    // Once the ticker is held, a ticket can't even be bought for it.
    let carol = env.funded_user().await;
    assert_custom(env.request(&carol, 1, "Another Name", "PEPE", URI).await, ParabullError::TickerLocked);
    assert!(env.account(&ticket_pda(&carol.pubkey(), 1)).await.is_none(), "nothing was paid");

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

    // Just before the lock lapses: still blocked, at purchase.
    env.advance(3 * DAY - 120).await;
    assert_custom(env.request(&bob, 3, "Pepe Coin", "PEPE", URI).await, ParabullError::TickerLocked);

    // After 3 days: the same ticker and name can be launched again; registries now point at the new mint.
    env.advance(180).await;
    env.request(&bob, 3, "Pepe Coin", "PEPE", URI).await.unwrap();
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
    let ix = env.create_ix(&impostor.pubkey(), &user.pubkey(), 1, &mint.pubkey(), "Pepe Coin", "PEPE", URI, None);
    assert_custom(env.send(&[ix], &[&impostor, &mint]).await, ParabullError::Unauthorized);

    // The mint keypair must sign (blind launch: the backend holds it).
    let mint = Keypair::new();
    let launch = env.launch.insecure_clone();
    let mut ix = env.create_ix(&launch.pubkey(), &user.pubkey(), 1, &mint.pubkey(), "Pepe Coin", "PEPE", URI, None);
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

// ---- Announcement-tweet lock ---------------------------------------------------

const TWEET: u64 = 1_850_000_000_000_000_000;

#[tokio::test]
async fn tweet_is_hashed_on_chain_and_locked_by_create() {
    let mut env = Env::new().await;
    let user = env.funded_user().await;
    env.request_with_tweet(&user, 1, "Pepe Coin", "PEPE", URI, Some(TWEET)).await.unwrap();
    let t: LaunchTicket = env.anchor(&ticket_pda(&user.pubkey(), 1)).await;
    assert_eq!(t.tweet_id_hash, Some(parabull::launch::tweet_id_hash(TWEET).unwrap()));

    let mint = env.create_with_tweet(&user.pubkey(), 1, "Pepe Coin", "PEPE", URI, Some(tweet_registry_pda(TWEET))).await.unwrap();
    let r: parabull::state::TweetRegistry = env.anchor(&tweet_registry_pda(TWEET)).await;
    assert_eq!((r.mint, r.tweet_id_hash), (mint, t.tweet_id_hash.unwrap()));
    assert!(r.launch_timestamp > 0);
}

#[tokio::test]
async fn reused_tweet_is_blocked_for_three_days_then_reclaimable() {
    let mut env = Env::new().await;
    let alice = env.funded_user().await;
    let bob = env.funded_user().await;
    env.request_with_tweet(&alice, 1, "Pepe Coin", "PEPE", URI, Some(TWEET)).await.unwrap();
    let first = env.create_with_tweet(&alice.pubkey(), 1, "Pepe Coin", "PEPE", URI, Some(tweet_registry_pda(TWEET))).await.unwrap();

    // Copycat: different ticker and name, same announcement tweet.
    env.request_with_tweet(&bob, 1, "Frog Cash", "FROG", URI, Some(TWEET)).await.unwrap();
    assert_custom(
        env.create_with_tweet(&bob.pubkey(), 1, "Frog Cash", "FROG", URI, Some(tweet_registry_pda(TWEET))).await,
        ParabullError::TweetLocked,
    );
    // A different tweet goes through.
    env.request_with_tweet(&bob, 2, "Frog Cash", "FROG", URI, Some(TWEET + 1)).await.unwrap();
    env.create_with_tweet(&bob.pubkey(), 2, "Frog Cash", "FROG", URI, Some(tweet_registry_pda(TWEET + 1))).await.unwrap();

    // One second before the 259,200 s lock lapses: still blocked.
    env.advance(DEFAULT_REGISTRY_LOCK_SECONDS - 120).await;
    env.request_with_tweet(&bob, 3, "Toad Cash", "TOAD", URI, Some(TWEET)).await.unwrap();
    assert_custom(
        env.create_with_tweet(&bob.pubkey(), 3, "Toad Cash", "TOAD", URI, Some(tweet_registry_pda(TWEET))).await,
        ParabullError::TweetLocked,
    );
    // After the lock: reclaimable, and the registry points at the new mint.
    env.advance(180).await;
    let second = env.create_with_tweet(&bob.pubkey(), 3, "Toad Cash", "TOAD", URI, Some(tweet_registry_pda(TWEET))).await.unwrap();
    assert_ne!(first, second);
    let r: parabull::state::TweetRegistry = env.anchor(&tweet_registry_pda(TWEET)).await;
    assert_eq!(r.mint, second);
}

#[tokio::test]
async fn tweet_registry_must_match_the_ticket() {
    let mut env = Env::new().await;
    let user = env.funded_user().await;

    // Ticket with a tweet, but the backend omits the registry: rejected.
    env.request_with_tweet(&user, 1, "Pepe Coin", "PEPE", URI, Some(TWEET)).await.unwrap();
    assert_custom(env.create_with_tweet(&user.pubkey(), 1, "Pepe Coin", "PEPE", URI, None).await, ParabullError::TweetRegistryMismatch);
    // ...or passes a registry for a different tweet: seeds don't match.
    assert!(env.create_with_tweet(&user.pubkey(), 1, "Pepe Coin", "PEPE", URI, Some(tweet_registry_pda(TWEET + 7))).await.is_err());

    // Ticket without a tweet, but a registry is passed: rejected (no lock is created).
    env.request(&user, 2, "Frog Cash", "FROG", URI).await.unwrap();
    assert!(env.create_with_tweet(&user.pubkey(), 2, "Frog Cash", "FROG", URI, Some(tweet_registry_pda(TWEET))).await.is_err());
    // Even the exact PDA a tweet-less ticket derives (["tweet", <empty>]) is refused.
    let empty_seed_pda = pda(&[SEED_TWEET_REGISTRY, &[]]);
    assert_custom(
        env.create_with_tweet(&user.pubkey(), 2, "Frog Cash", "FROG", URI, Some(empty_seed_pda)).await,
        ParabullError::TweetRegistryMismatch,
    );
    assert!(env.account(&empty_seed_pda).await.is_none());
    // Without a tweet the normal path works and creates no tweet registry.
    env.create(&user.pubkey(), 2, "Frog Cash", "FROG", URI).await.unwrap();
    assert!(env.account(&tweet_registry_pda(TWEET)).await.is_none());
}

#[tokio::test]
async fn zero_tweet_id_is_rejected_at_request() {
    let mut env = Env::new().await;
    let user = env.funded_user().await;
    assert_custom(env.request_with_tweet(&user, 1, "Pepe Coin", "PEPE", URI, Some(0)).await, ParabullError::InvalidTweetId);
}

#[tokio::test]
async fn relaunch_after_lock_repays_only_newly_created_rent() {
    // A re-claimed (expired) registry was paid for by an earlier launch, so the
    // second launch's backend is not repaid for it: that part stays with the treasury.
    let mut env = Env::new().await;
    let alice = env.funded_user().await;
    env.request(&alice, 1, "Pepe Coin", "PEPE", URI).await.unwrap();
    env.create(&alice.pubkey(), 1, "Pepe Coin", "PEPE", URI).await.unwrap();
    env.advance(DEFAULT_REGISTRY_LOCK_SECONDS + 1).await;

    let bob = env.funded_user().await;
    env.request(&bob, 1, "Pepe Coin", "PEPE", URI).await.unwrap();
    let launch_key = env.launch.pubkey();
    let launch_before = env.lamports(&launch_key).await;
    let treasury_before = env.lamports(&env.treasury.clone()).await;
    let mint = env.create(&bob.pubkey(), 1, "Pepe Coin", "PEPE", URI).await.unwrap();

    assert_eq!(env.lamports(&launch_key).await, launch_before, "repaid exactly: mint + curve + ATA only");
    let curve_key = pda(&[SEED_BONDING_CURVE, mint.as_ref()]);
    let fresh_rent = env.lamports(&mint).await + env.lamports(&curve_key).await + env.lamports(&ata(&curve_key, &mint)).await;
    assert_eq!(env.lamports(&env.treasury.clone()).await - treasury_before, DEFAULT_TICKET_DEPOSIT_LAMPORTS - fresh_rent);
}

#[tokio::test]
async fn flat_ticket_with_tweet_still_leaves_launch_authority_whole() {
    let mut env = Env::new().await;
    let user = env.funded_user().await;
    env.request_with_tweet(&user, 1, "Pepe Coin", "PEPE", URI, Some(TWEET)).await.unwrap();
    let launch_key = env.launch.pubkey();
    let launch_before = env.lamports(&launch_key).await;
    let treasury_before = env.lamports(&env.treasury.clone()).await;
    env.create_with_tweet(&user.pubkey(), 1, "Pepe Coin", "PEPE", URI, Some(tweet_registry_pda(TWEET))).await.unwrap();
    assert_eq!(env.lamports(&launch_key).await, launch_before, "tweet registry rent repaid too");
    assert!(env.lamports(&env.treasury.clone()).await - treasury_before > DEFAULT_LAUNCH_FEE_LAMPORTS);
}

#[tokio::test]
async fn prefunded_registry_donation_never_comes_out_of_the_treasury() {
    // Registry PDAs have public seeds, so anyone can send lamports to one
    // before `create`. Repayment is capped at the rent-exempt minimum, so the
    // treasury receives exactly what it would without the donation.
    let mut env = Env::new().await;
    let user = env.funded_user().await;
    env.request(&user, 1, "Pepe Coin", "PEPE", URI).await.unwrap();
    let ticker_key = pda(&[SEED_TICKER_REGISTRY, b"PEPE"]);
    let name_key = pda(&[SEED_NAME_REGISTRY, &normalize_name_hash("Pepe Coin").unwrap()]);
    let donation = 20_000_000; // well above either registry's rent
    for key in [ticker_key, name_key] {
        let ix = solana_sdk::system_instruction::transfer(&user.pubkey(), &key, donation);
        env.send(&[ix], &[&user]).await.unwrap();
    }
    let launch_key = env.launch.pubkey();
    let launch_before = env.lamports(&launch_key).await;
    let treasury_before = env.lamports(&env.treasury.clone()).await;
    let mint = env.create(&user.pubkey(), 1, "Pepe Coin", "PEPE", URI).await.unwrap();

    let rent = env.ctx.banks_client.get_rent().await.unwrap();
    let registry_rent = rent.minimum_balance(env.account(&ticker_key).await.unwrap().data.len())
        + rent.minimum_balance(env.account(&name_key).await.unwrap().data.len());
    let curve_key = pda(&[SEED_BONDING_CURVE, mint.as_ref()]);
    let fresh_rent = env.lamports(&mint).await + env.lamports(&curve_key).await + env.lamports(&ata(&curve_key, &mint)).await;
    assert_eq!(
        env.lamports(&env.treasury.clone()).await - treasury_before,
        DEFAULT_TICKET_DEPOSIT_LAMPORTS - fresh_rent - registry_rent,
        "treasury gets the same as without the donation"
    );
    // The authority paid nothing for the pre-funded registries and is repaid
    // only their minimum rent: the donor's lamports, never the treasury's.
    assert_eq!(env.lamports(&launch_key).await - launch_before, registry_rent);
    assert_eq!(env.lamports(&ticker_key).await, donation);
}

#[tokio::test]
async fn request_launch_checks_the_ticker_registry_it_is_given() {
    let mut env = Env::new().await;
    let alice = env.funded_user().await;
    env.launch_token(&alice, 1, "Pepe Coin", "PEPE").await;
    let bob = env.funded_user().await;

    // Passing another ticker's (free) registry to dodge the lock is refused.
    let mut ix = env.request_ix(&bob.pubkey(), 1, "Other", "PEPE", URI, None);
    for m in ix.accounts.iter_mut().filter(|m| m.pubkey == ticker_registry_for("PEPE")) {
        m.pubkey = ticker_registry_for("FREE");
    }
    assert_custom(env.send(&[ix], &[&bob]).await, ParabullError::TickerRegistryMismatch);

    // A registry address that only holds lamports someone sent it has no claim.
    let unused = ticker_registry_for("NEWONE");
    env.ctx.set_account(&unused, &Account { lamports: SOL, data: vec![], owner: system_program::ID, executable: false, rent_epoch: 0 }.into());
    env.request(&bob, 2, "New One", "NEWONE", URI).await.unwrap();
}

//! Runtime tests for request_launch / refund_ticket / create, run against the
//! real SPL Token-2022 and ATA programs bundled with solana-program-test.
//! Parabull itself runs as a native processor (no SBF toolchain needed).

use anchor_lang::{system_program, AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas};
use anchor_spl::token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata;
use anchor_spl::token_interface::spl_token_2022::extension::{BaseStateWithExtensions, StateWithExtensions};
use anchor_spl::token_interface::spl_token_2022::state::{Account as SplTokenAccount, Mint as SplMint};
use parabull::constants::*;
use parabull::error::ParabullError;
use parabull::state::{metadata_commitment, normalize_name_hash, BondingCurve, Global, LaunchTicket, NameRegistry, TickerRegistry};
use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
use solana_sdk::account::Account;
use solana_sdk::account_info::AccountInfo;
use solana_sdk::clock::Clock;
use solana_sdk::entrypoint::ProgramResult;
use solana_sdk::instruction::{Instruction, InstructionError};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::{Transaction, TransactionError};

const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
const ATA_PROGRAM: Pubkey = anchor_spl::associated_token::ID;
const SOL: u64 = 1_000_000_000;
const DAY: i64 = 24 * 60 * 60;

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let accounts = Box::leak(Box::new(accounts.to_vec()));
    parabull::entry(program_id, accounts, data)
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &parabull::ID).0
}

fn global_pda() -> Pubkey {
    pda(&[SEED_GLOBAL])
}

fn ticket_pda(payer: &Pubkey, nonce: u64) -> Pubkey {
    pda(&[SEED_LAUNCH_TICKET, payer.as_ref(), &nonce.to_le_bytes()])
}

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

fn err_code(e: ParabullError) -> u32 {
    e.into()
}

struct Env {
    ctx: ProgramTestContext,
    launch: Keypair,
    treasury: Pubkey,
}

impl Env {
    async fn new() -> Self {
        let mut pt = ProgramTest::new("parabull", parabull::ID, processor!(process));
        let launch = Keypair::new();
        let treasury = Pubkey::new_unique();

        let (global_key, bump) = Pubkey::find_program_address(&[SEED_GLOBAL], &parabull::ID);
        let global = Global {
            bump,
            paused: false,
            admin: Pubkey::new_unique(),
            launch_authority: launch.pubkey(),
            crank_authority: Pubkey::new_unique(),
            treasury,
            parabull_mint: Pubkey::new_unique(),
            launch_fee_lamports: DEFAULT_LAUNCH_FEE_LAMPORTS,
            ticket_deposit_lamports: DEFAULT_TICKET_DEPOSIT_LAMPORTS,
            ticket_ttl_seconds: DEFAULT_TICKET_TTL_SECONDS,
            platform_fee_bps: DEFAULT_PLATFORM_FEE_BPS,
            buyback_bps: 5_000,
            holder_bps: 4_000,
            dex_target_lamports: 2 * SOL,
            dex_target_updated_at: 0,
            trading_open_delay_slots: DEFAULT_TRADING_OPEN_DELAY_SLOTS,
            registry_lock_seconds: DEFAULT_REGISTRY_LOCK_SECONDS,
            initial_virtual_token_reserves: DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
            initial_virtual_sol_reserves: DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES,
            initial_real_token_reserves: DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
            token_total_supply: DEFAULT_TOKEN_TOTAL_SUPPLY,
            launch_count: 0,
            _reserved: [0; 128],
        };
        let mut data = Vec::with_capacity(8 + Global::INIT_SPACE);
        global.try_serialize(&mut data).unwrap();
        data.resize(8 + Global::INIT_SPACE, 0);
        pt.add_account(global_key, Account { lamports: SOL, data, owner: parabull::ID, executable: false, rent_epoch: 0 });
        pt.add_account(launch.pubkey(), Account { lamports: 10 * SOL, ..Account::default() });
        pt.add_account(treasury, Account { lamports: SOL, ..Account::default() });

        let ctx = pt.start_with_context().await;
        Env { ctx, launch, treasury }
    }

    async fn funded_user(&mut self) -> Keypair {
        let user = Keypair::new();
        self.ctx.set_account(&user.pubkey(), &Account { lamports: 5 * SOL, ..Account::default() }.into());
        user
    }

    async fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), BanksClientError> {
        let blockhash = self.ctx.get_new_latest_blockhash().await.unwrap();
        let mut all: Vec<&Keypair> = vec![&self.ctx.payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(ixs, Some(&self.ctx.payer.pubkey()), &all, blockhash);
        self.ctx.banks_client.process_transaction(tx).await
    }

    async fn account(&mut self, key: &Pubkey) -> Option<Account> {
        self.ctx.banks_client.get_account(*key).await.unwrap()
    }

    async fn lamports(&mut self, key: &Pubkey) -> u64 {
        self.account(key).await.map(|a| a.lamports).unwrap_or(0)
    }

    async fn anchor<T: AccountDeserialize>(&mut self, key: &Pubkey) -> T {
        let acc = self.account(key).await.expect("account exists");
        T::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    async fn clock(&mut self) -> Clock {
        self.ctx.banks_client.get_sysvar::<Clock>().await.unwrap()
    }

    /// Advance wall-clock time by `secs`.
    async fn advance(&mut self, secs: i64) {
        let mut clock = self.clock().await;
        clock.unix_timestamp += secs;
        self.ctx.set_sysvar(&clock);
    }

    fn request_ix(&self, payer: &Pubkey, nonce: u64, name: &str, symbol: &str, uri: &str) -> Instruction {
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::RequestLaunch {
                payer: *payer,
                global: global_pda(),
                ticket: ticket_pda(payer, nonce),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: parabull::instruction::RequestLaunch {
                nonce,
                name: name.into(),
                symbol: symbol.into(),
                uri: uri.into(),
            }
            .data(),
        }
    }

    fn refund_ix(&self, authority: &Pubkey, payer: &Pubkey, nonce: u64) -> Instruction {
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::RefundTicket {
                authority: *authority,
                payer: *payer,
                global: global_pda(),
                ticket: ticket_pda(payer, nonce),
            }
            .to_account_metas(None),
            data: parabull::instruction::RefundTicket {}.data(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn create_ix(
        &self,
        launch_authority: &Pubkey,
        payer: &Pubkey,
        nonce: u64,
        mint: &Pubkey,
        name: &str,
        symbol: &str,
        uri: &str,
    ) -> Instruction {
        let curve = pda(&[SEED_BONDING_CURVE, mint.as_ref()]);
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::Create {
                launch_authority: *launch_authority,
                global: global_pda(),
                ticket: ticket_pda(payer, nonce),
                payer: *payer,
                treasury: self.treasury,
                mint: *mint,
                mint_authority: pda(&[SEED_MINT_AUTHORITY]),
                bonding_curve: curve,
                curve_token_account: ata(&curve, mint),
                ticker_registry: pda(&[SEED_TICKER_REGISTRY, symbol.as_bytes()]),
                name_registry: pda(&[SEED_NAME_REGISTRY, &normalize_name_hash(name).unwrap()]),
                token_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: parabull::instruction::Create { name: name.into(), symbol: symbol.into(), uri: uri.into() }.data(),
        }
    }

    async fn request(&mut self, user: &Keypair, nonce: u64, name: &str, symbol: &str, uri: &str) -> Result<(), BanksClientError> {
        let ix = self.request_ix(&user.pubkey(), nonce, name, symbol, uri);
        self.send(&[ix], &[user]).await
    }

    /// Backend create with a fresh mint keypair. Returns the mint on success.
    async fn create(&mut self, user: &Pubkey, nonce: u64, name: &str, symbol: &str, uri: &str) -> Result<Pubkey, BanksClientError> {
        let mint = Keypair::new();
        let launch = self.launch.insecure_clone();
        let ix = self.create_ix(&launch.pubkey(), user, nonce, &mint.pubkey(), name, symbol, uri);
        self.send(&[ix], &[&launch, &mint]).await.map(|_| mint.pubkey())
    }
}

fn assert_custom(res: Result<impl std::fmt::Debug, BanksClientError>, expected: ParabullError) {
    let code = err_code(expected);
    match res {
        Err(BanksClientError::TransactionError(TransactionError::InstructionError(_, InstructionError::Custom(c))))
        | Err(BanksClientError::SimulationError { err: TransactionError::InstructionError(_, InstructionError::Custom(c)), .. }) => {
            assert_eq!(c, code, "expected {expected:?} ({code}), got custom error {c}")
        }
        other => panic!("expected {expected:?} ({code}), got {other:?}"),
    }
}

const URI: &str = "https://arweave.net/pepe.json";

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

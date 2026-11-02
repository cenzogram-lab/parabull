//! Shared solana-program-test harness. Parabull runs as a native processor
//! against the real SPL Token-2022 and ATA programs bundled with program-test.
#![allow(dead_code, unused_imports)]

pub mod raydium_mock;

pub use anchor_lang::{system_program, AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas};
pub use anchor_spl::token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata;
pub use anchor_spl::token_interface::spl_token_2022::extension::{BaseStateWithExtensions, StateWithExtensions};
pub use anchor_spl::token_interface::spl_token_2022::state::{Account as SplTokenAccount, Mint as SplMint};
pub use parabull::constants::*;
pub use parabull::error::ParabullError;
pub use parabull::state::{metadata_commitment, normalize_name_hash, BondingCurve, Global, LaunchTicket, NameRegistry, TickerRegistry};
pub use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
pub use solana_sdk::account::Account;
pub use solana_sdk::account_info::AccountInfo;
pub use solana_sdk::clock::Clock;
pub use solana_sdk::entrypoint::ProgramResult;
pub use solana_sdk::instruction::{Instruction, InstructionError};
pub use solana_sdk::pubkey::Pubkey;
pub use solana_sdk::signature::Keypair;
pub use solana_sdk::signer::Signer;
pub use solana_sdk::transaction::{Transaction, TransactionError};

pub const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
pub const ATA_PROGRAM: Pubkey = anchor_spl::associated_token::ID;
pub const SOL: u64 = 1_000_000_000;
pub const DAY: i64 = 24 * 60 * 60;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let accounts = Box::leak(Box::new(accounts.to_vec()));
    parabull::entry(program_id, accounts, data)
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &parabull::ID).0
}

pub fn global_pda() -> Pubkey {
    pda(&[SEED_GLOBAL])
}

pub fn ticket_pda(payer: &Pubkey, nonce: u64) -> Pubkey {
    pda(&[SEED_LAUNCH_TICKET, payer.as_ref(), &nonce.to_le_bytes()])
}

pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

pub fn err_code(e: ParabullError) -> u32 {
    e.into()
}

pub struct Env {
    pub ctx: ProgramTestContext,
    pub admin: Keypair,
    pub launch: Keypair,
    pub crank: Keypair,
    pub treasury: Pubkey,
}

impl Env {
    pub async fn new() -> Self {
        Self::with_global(|_| {}).await
    }

    /// Start a test validator with a pre-initialised `Global`, customised by `tweak`.
    pub async fn with_global(tweak: impl FnOnce(&mut Global)) -> Self {
        let mut pt = ProgramTest::new("parabull", parabull::ID, processor!(process));
        let admin = Keypair::new();
        let launch = Keypair::new();
        let crank = Keypair::new();
        let treasury = Pubkey::new_unique();

        let (global_key, bump) = Pubkey::find_program_address(&[SEED_GLOBAL], &parabull::ID);
        let global = Global {
            bump,
            paused: false,
            admin: admin.pubkey(),
            launch_authority: launch.pubkey(),
            crank_authority: crank.pubkey(),
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
            cpmm_program: raydium_mock::CPMM_ID,
            cpmm_amm_config: AMM_CONFIG,
            lp_lock_program: raydium_mock::LOCK_ID,
            lp_lock_authority: raydium_mock::LOCK_AUTH,
            migration_reserve_lamports: DEFAULT_MIGRATION_RESERVE_LAMPORTS,
            pending_admin: Pubkey::default(),
            parabull_pool: Pubkey::default(),
            reward_claim_window_seconds: DEFAULT_REWARD_CLAIM_WINDOW_SECONDS,
            _reserved: [0; 24],
        };
        let mut global = global;
        tweak(&mut global);
        let mut data = Vec::with_capacity(8 + Global::INIT_SPACE);
        global.try_serialize(&mut data).unwrap();
        data.resize(8 + Global::INIT_SPACE, 0);
        pt.add_account(global_key, Account { lamports: SOL, data, owner: parabull::ID, executable: false, rent_epoch: 0 });
        pt.add_account(launch.pubkey(), Account { lamports: 10 * SOL, ..Account::default() });
        pt.add_account(crank.pubkey(), Account { lamports: 10 * SOL, ..Account::default() });
        pt.add_account(admin.pubkey(), Account { lamports: 10 * SOL, ..Account::default() });
        pt.add_account(treasury, Account { lamports: SOL, ..Account::default() });
        add_flywheel_vaults(&mut pt);
        // Raydium mocks at the real program IDs, plus the accounts Raydium
        // itself would own on a real cluster (config, fee receiver). The WSOL
        // native mint is already part of program-test genesis.
        pt.add_program("raydium_cpmm_mock", raydium_mock::CPMM_ID, processor!(raydium_mock::mock_cpmm));
        pt.add_program("raydium_lock_mock", raydium_mock::LOCK_ID, processor!(raydium_mock::mock_lock));
        pt.add_account(AMM_CONFIG, Account { lamports: SOL, data: vec![0; 8], owner: raydium_mock::CPMM_ID, executable: false, rent_epoch: 0 });
        pt.add_account(raydium_mock::POOL_FEE_RECEIVER, Account { lamports: SOL, ..Account::default() });

        let ctx = pt.start_with_context().await;
        Env { ctx, admin, launch, crank, treasury }
    }

    pub async fn funded_user(&mut self) -> Keypair {
        self.user_with(5 * SOL).await
    }

    pub async fn user_with(&mut self, lamports: u64) -> Keypair {
        let user = Keypair::new();
        self.ctx.set_account(&user.pubkey(), &Account { lamports, ..Account::default() }.into());
        user
    }

    pub async fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), BanksClientError> {
        let blockhash = self.ctx.get_new_latest_blockhash().await.unwrap();
        let mut all: Vec<&Keypair> = vec![&self.ctx.payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(ixs, Some(&self.ctx.payer.pubkey()), &all, blockhash);
        self.ctx.banks_client.process_transaction(tx).await
    }

    pub async fn account(&mut self, key: &Pubkey) -> Option<Account> {
        self.ctx.banks_client.get_account(*key).await.unwrap()
    }

    pub async fn lamports(&mut self, key: &Pubkey) -> u64 {
        self.account(key).await.map(|a| a.lamports).unwrap_or(0)
    }

    pub async fn anchor<T: AccountDeserialize>(&mut self, key: &Pubkey) -> T {
        let acc = self.account(key).await.expect("account exists");
        T::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    pub async fn clock(&mut self) -> Clock {
        self.ctx.banks_client.get_sysvar::<Clock>().await.unwrap()
    }

    /// Advance wall-clock time by `secs`.
    pub async fn advance(&mut self, secs: i64) {
        let mut clock = self.clock().await;
        clock.unix_timestamp += secs;
        self.ctx.set_sysvar(&clock);
    }

    pub fn request_ix(&self, payer: &Pubkey, nonce: u64, name: &str, symbol: &str, uri: &str, tweet_id: Option<u64>) -> Instruction {
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
                tweet_id,
            }
            .data(),
        }
    }

    pub fn refund_ix(&self, authority: &Pubkey, payer: &Pubkey, nonce: u64) -> Instruction {
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
    pub fn create_ix(
        &self,
        launch_authority: &Pubkey,
        payer: &Pubkey,
        nonce: u64,
        mint: &Pubkey,
        name: &str,
        symbol: &str,
        uri: &str,
        tweet_registry: Option<Pubkey>,
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
                tweet_registry,
                token_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: parabull::instruction::Create { name: name.into(), symbol: symbol.into(), uri: uri.into() }.data(),
        }
    }

    pub async fn request(&mut self, user: &Keypair, nonce: u64, name: &str, symbol: &str, uri: &str) -> Result<(), BanksClientError> {
        self.request_with_tweet(user, nonce, name, symbol, uri, None).await
    }

    pub async fn request_with_tweet(&mut self, user: &Keypair, nonce: u64, name: &str, symbol: &str, uri: &str, tweet_id: Option<u64>) -> Result<(), BanksClientError> {
        let ix = self.request_ix(&user.pubkey(), nonce, name, symbol, uri, tweet_id);
        self.send(&[ix], &[user]).await
    }

    /// Backend create with a fresh mint keypair. Returns the mint on success.
    pub async fn create(&mut self, user: &Pubkey, nonce: u64, name: &str, symbol: &str, uri: &str) -> Result<Pubkey, BanksClientError> {
        self.create_with_tweet(user, nonce, name, symbol, uri, None).await
    }

    /// `tweet_registry`: pass `Some(tweet_registry_pda(hash))` when the ticket has a tweet.
    pub async fn create_with_tweet(&mut self, user: &Pubkey, nonce: u64, name: &str, symbol: &str, uri: &str, tweet_registry: Option<Pubkey>) -> Result<Pubkey, BanksClientError> {
        let mint = Keypair::new();
        let launch = self.launch.insecure_clone();
        let ix = self.create_ix(&launch.pubkey(), user, nonce, &mint.pubkey(), name, symbol, uri, tweet_registry);
        self.send(&[ix], &[&launch, &mint]).await.map(|_| mint.pubkey())
    }
}

pub fn assert_custom(res: Result<impl std::fmt::Debug, BanksClientError>, expected: ParabullError) {
    assert_custom_code(res, err_code(expected), &format!("{expected:?}"));
}

pub fn assert_custom_code(res: Result<impl std::fmt::Debug, BanksClientError>, code: u32, expected: &str) {
    match res {
        Err(BanksClientError::TransactionError(TransactionError::InstructionError(_, InstructionError::Custom(c))))
        | Err(BanksClientError::SimulationError { err: TransactionError::InstructionError(_, InstructionError::Custom(c)), .. }) => {
            assert_eq!(c, code, "expected {expected:?} ({code}), got custom error {c}")
        }
        other => panic!("expected {expected:?} ({code}), got {other:?}"),
    }
}

pub const URI: &str = "https://arweave.net/pepe.json";

// ---- Trading helpers --------------------------------------------------------

pub fn curve_pda(mint: &Pubkey) -> Pubkey {
    pda(&[SEED_BONDING_CURVE, mint.as_ref()])
}

impl Env {
    /// request_launch + create in one go; returns the new mint.
    pub async fn launch_token(&mut self, creator: &Keypair, nonce: u64, name: &str, symbol: &str) -> Pubkey {
        self.request(creator, nonce, name, symbol, URI).await.unwrap();
        self.create(&creator.pubkey(), nonce, name, symbol, URI).await.unwrap()
    }

    /// Move the `Clock` sysvar's slot forward to `slot` (no-op if already past).
    ///
    /// Parabull reads the slot only via `Clock::get()`, so this is what the
    /// program observes. `ProgramTestContext::warp_to_slot` would also work but
    /// computes a full accounts hash that exceeds this container's open-file
    /// limit ("Too many open files").
    pub async fn warp_to(&mut self, slot: u64) {
        let mut clock = self.clock().await;
        if clock.slot < slot {
            clock.slot = slot;
            self.ctx.set_sysvar(&clock);
        }
    }

    pub fn trade_ix(&self, user: &Pubkey, mint: &Pubkey, is_buy: bool, amount: u64, limit: u64) -> Instruction {
        let curve = curve_pda(mint);
        let accounts = parabull::accounts::Trade {
            user: *user,
            global: global_pda(),
            mint: *mint,
            bonding_curve: curve,
            curve_token_account: ata(&curve, mint),
            user_token_account: ata(user, mint),
            token_program: TOKEN_2022,
            associated_token_program: ATA_PROGRAM,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        let data = if is_buy {
            parabull::instruction::Buy { amount, max_sol_cost: limit }.data()
        } else {
            parabull::instruction::Sell { amount, min_sol_output: limit }.data()
        };
        Instruction { program_id: parabull::ID, accounts, data }
    }

    pub async fn buy(&mut self, user: &Keypair, mint: &Pubkey, amount: u64, max_sol_cost: u64) -> Result<(), BanksClientError> {
        let ix = self.trade_ix(&user.pubkey(), mint, true, amount, max_sol_cost);
        self.send(&[ix], &[user]).await
    }

    pub async fn sell(&mut self, user: &Keypair, mint: &Pubkey, amount: u64, min_sol_output: u64) -> Result<(), BanksClientError> {
        let ix = self.trade_ix(&user.pubkey(), mint, false, amount, min_sol_output);
        self.send(&[ix], &[user]).await
    }

    /// Token-2022 balance of `owner`'s ATA (0 if it doesn't exist).
    pub async fn token_balance(&mut self, owner: &Pubkey, mint: &Pubkey) -> u64 {
        match self.account(&ata(owner, mint)).await {
            Some(acc) => StateWithExtensions::<SplTokenAccount>::unpack(&acc.data).unwrap().base.amount,
            None => 0,
        }
    }

    pub async fn rent_exempt(&mut self, data_len: usize) -> u64 {
        self.ctx.banks_client.get_rent().await.unwrap().minimum_balance(data_len)
    }
}


// ---- Flywheel / migration helpers -----------------------------------------------

pub const SPL_TOKEN: Pubkey = anchor_spl::token::ID;
pub const WSOL_MINT: Pubkey = parabull::raydium::WSOL_MINT;
/// Test CPMM AmmConfig (owned by the CPMM mock).
pub const AMM_CONFIG: Pubkey = Pubkey::new_from_array([7u8; 32]);

fn add_flywheel_vaults(pt: &mut ProgramTest) {
    use parabull::state::{BuybackVault, HolderRewardVault};
    let (bv, bv_bump) = Pubkey::find_program_address(&[SEED_BUYBACK_VAULT], &parabull::ID);
    let (hv, hv_bump) = Pubkey::find_program_address(&[SEED_HOLDER_VAULT], &parabull::ID);
    let b = BuybackVault { bump: bv_bump, total_deposited_lamports: 0, total_spent_lamports: 0, total_tokens_burned: 0, buyback_count: 0, last_buyback_at: 0, _reserved: [0; 64] };
    let h = HolderRewardVault { bump: hv_bump, total_deposited_lamports: 0, total_committed_lamports: 0, total_claimed_lamports: 0, next_epoch: 0, total_expired_lamports: 0, _reserved: [0; 56] };
    let rent = solana_sdk::rent::Rent::default();
    for (key, data) in [(bv, anchor_bytes(&b, 8 + BuybackVault::INIT_SPACE)), (hv, anchor_bytes(&h, 8 + HolderRewardVault::INIT_SPACE))] {
        pt.add_account(key, Account { lamports: rent.minimum_balance(data.len()), data, owner: parabull::ID, executable: false, rent_epoch: 0 });
    }
}

pub fn anchor_bytes<T: AccountSerialize>(v: &T, len: usize) -> Vec<u8> {
    let mut data = Vec::with_capacity(len);
    v.try_serialize(&mut data).unwrap();
    data.resize(len, 0);
    data
}

pub fn packed_mint(authority: Option<Pubkey>, decimals: u8, program: Pubkey) -> Account {
    use anchor_lang::solana_program::program_option::COption;
    use anchor_lang::solana_program::program_pack::Pack;
    let m = anchor_spl::token::spl_token::state::Mint {
        mint_authority: authority.map(COption::Some).unwrap_or(COption::None),
        supply: 0,
        decimals,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut data = vec![0; anchor_spl::token::spl_token::state::Mint::LEN];
    m.pack_into_slice(&mut data);
    Account { lamports: SOL, data, owner: program, executable: false, rent_epoch: 0 }
}

/// Empty token account (165-byte base layout, valid for both token programs).
pub fn packed_token_account(mint: Pubkey, owner: Pubkey, program: Pubkey) -> Account {
    use anchor_lang::solana_program::program_option::COption;
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token::spl_token::state::{Account as TA, AccountState};
    let rent = solana_sdk::rent::Rent::default().minimum_balance(TA::LEN);
    let native = mint == WSOL_MINT;
    let t = TA {
        mint,
        owner,
        amount: 0,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: if native { COption::Some(rent) } else { COption::None },
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0; TA::LEN];
    t.pack_into_slice(&mut data);
    Account { lamports: rent, data, owner: program, executable: false, rent_epoch: 0 }
}

/// Raydium-side addresses for a launched mint, derived by Parabull's helpers.
pub struct PoolKeys {
    pub order: parabull::raydium::PoolOrder,
    pub cpmm: parabull::raydium::CpmmAccounts,
    pub migration_authority: Pubkey,
}

pub fn migration_authority(mint: &Pubkey) -> Pubkey {
    pda(&[SEED_MIGRATION_AUTHORITY, mint.as_ref()])
}

pub fn fee_key_vault() -> Pubkey {
    pda(&[SEED_FEE_KEY_VAULT])
}

pub fn pool_keys(mint: &Pubkey) -> PoolKeys {
    let order = parabull::raydium::sort_pool_mints(mint, &WSOL_MINT).unwrap();
    let auth = migration_authority(mint);
    let cpmm = parabull::raydium::cpmm_accounts(&raydium_mock::CPMM_ID, &AMM_CONFIG, &order, &auth);
    PoolKeys { order, cpmm, migration_authority: auth }
}

impl Env {
    /// Accounts the real CPMM program would create inside `initialize`; the
    /// mock expects them to exist (vaults, LP mint, pool + observation state).
    pub fn seed_cpmm_pool_accounts(&mut self, mint: &Pubkey) {
        let k = pool_keys(mint);
        let (p0, p1) = k.order.programs();
        let set = |ctx: &mut ProgramTestContext, key: &Pubkey, acc: Account| ctx.set_account(key, &acc.into());
        set(&mut self.ctx, &k.cpmm.token_0_vault, packed_token_account(k.order.token_0, k.cpmm.authority, p0));
        set(&mut self.ctx, &k.cpmm.token_1_vault, packed_token_account(k.order.token_1, k.cpmm.authority, p1));
        set(&mut self.ctx, &k.cpmm.lp_mint, packed_mint(Some(k.cpmm.authority), 9, SPL_TOKEN));
        let owned = |len: usize| Account { lamports: SOL, data: vec![0; len], owner: raydium_mock::CPMM_ID, executable: false, rent_epoch: 0 };
        set(&mut self.ctx, &k.cpmm.pool_state, owned(64));
        set(&mut self.ctx, &k.cpmm.observation_state, owned(8));
        // Burn & Earn's LP vault (owned by the lock authority).
        let lock_vault = anchor_spl::associated_token::get_associated_token_address_with_program_id(&raydium_mock::LOCK_AUTH, &k.cpmm.lp_mint, &SPL_TOKEN);
        set(&mut self.ctx, &lock_vault, packed_token_account(k.cpmm.lp_mint, raydium_mock::LOCK_AUTH, SPL_TOKEN));
    }

    pub fn prepare_migration_ix(&self, crank: &Pubkey, mint: &Pubkey) -> Instruction {
        let curve = curve_pda(mint);
        let auth = migration_authority(mint);
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::PrepareMigration {
                crank: *crank,
                global: global_pda(),
                mint: *mint,
                bonding_curve: curve,
                curve_token_account: ata(&curve, mint),
                migration_authority: auth,
                authority_token_account: ata(&auth, mint),
                token_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: parabull::instruction::PrepareMigration {}.data(),
        }
    }

    pub fn migrate_raydium_ix(&self, crank: &Pubkey, mint: &Pubkey) -> Instruction {
        let k = pool_keys(mint);
        let wsol_ata = anchor_spl::associated_token::get_associated_token_address_with_program_id(&k.migration_authority, &WSOL_MINT, &SPL_TOKEN);
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::MigrateRaydium {
                crank: *crank,
                global: global_pda(),
                mint: *mint,
                bonding_curve: curve_pda(mint),
                migration_authority: k.migration_authority,
                authority_token_account: ata(&k.migration_authority, mint),
                authority_wsol_account: wsol_ata,
                wsol_mint: WSOL_MINT,
                cpmm_program: raydium_mock::CPMM_ID,
                amm_config: AMM_CONFIG,
                cpmm_authority: k.cpmm.authority,
                pool_state: k.cpmm.pool_state,
                lp_mint: k.cpmm.lp_mint,
                creator_lp_token: k.cpmm.creator_lp_token,
                token_0_vault: k.cpmm.token_0_vault,
                token_1_vault: k.cpmm.token_1_vault,
                create_pool_fee: raydium_mock::POOL_FEE_RECEIVER,
                observation_state: k.cpmm.observation_state,
                token_program: SPL_TOKEN,
                token_2022_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
                rent: solana_sdk::sysvar::rent::ID,
            }
            .to_account_metas(None),
            data: parabull::instruction::MigrateRaydium {}.data(),
        }
    }

    pub fn lock_lp_ix(&self, crank: &Pubkey, mint: &Pubkey, fee_nft_mint: &Pubkey) -> Instruction {
        let k = pool_keys(mint);
        let lock = parabull::raydium::lock_accounts(&raydium_mock::LOCK_ID, &raydium_mock::LOCK_AUTH, fee_nft_mint, &fee_key_vault(), &k.cpmm.lp_mint);
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::LockMigratedLp {
                crank: *crank,
                global: global_pda(),
                mint: *mint,
                bonding_curve: curve_pda(mint),
                migration_authority: k.migration_authority,
                fee_key_vault: fee_key_vault(),
                fee_nft_mint: *fee_nft_mint,
                treasury: self.treasury,
                lp_lock_program: raydium_mock::LOCK_ID,
                lp_lock_authority: raydium_mock::LOCK_AUTH,
                pool_state: k.cpmm.pool_state,
                lp_mint: k.cpmm.lp_mint,
                creator_lp_token: k.cpmm.creator_lp_token,
                token_0_vault: k.cpmm.token_0_vault,
                token_1_vault: k.cpmm.token_1_vault,
                fee_nft_account: lock.fee_nft_account,
                locked_liquidity: lock.locked_liquidity,
                lock_lp_vault: lock.lock_lp_vault,
                nft_metadata: lock.nft_metadata,
                rent: solana_sdk::sysvar::rent::ID,
                system_program: system_program::ID,
                token_program: SPL_TOKEN,
                associated_token_program: ATA_PROGRAM,
                metadata_program: parabull::raydium::METADATA_PROGRAM_ID,
            }
            .to_account_metas(None),
            data: parabull::instruction::LockMigratedLp {}.data(),
        }
    }

    pub fn top_up_ix(&self, payer: &Pubkey, mint: &Pubkey, amount: u64) -> Instruction {
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::TopUpDexEscrow {
                payer: *payer,
                global: global_pda(),
                mint: *mint,
                bonding_curve: curve_pda(mint),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: parabull::instruction::TopUpDexEscrow { amount }.data(),
        }
    }

    pub fn release_ix(&self, mint: &Pubkey) -> Instruction {
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::ReleaseDexEscrow {
                global: global_pda(),
                mint: *mint,
                bonding_curve: curve_pda(mint),
                treasury: self.treasury,
            }
            .to_account_metas(None),
            data: parabull::instruction::ReleaseDexEscrow {}.data(),
        }
    }

    pub fn sweep_ix(&self, mint: &Pubkey) -> Instruction {
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::SweepFees {
                global: global_pda(),
                mint: *mint,
                bonding_curve: curve_pda(mint),
                buyback_vault: pda(&[SEED_BUYBACK_VAULT]),
                holder_vault: pda(&[SEED_HOLDER_VAULT]),
                treasury: self.treasury,
            }
            .to_account_metas(None),
            data: parabull::instruction::SweepFees {}.data(),
        }
    }

    /// Generic SPL/Token-2022 balance for any token account address.
    pub async fn token_amount_at(&mut self, key: &Pubkey) -> Option<u64> {
        self.account(key).await.map(|acc| StateWithExtensions::<SplTokenAccount>::unpack(&acc.data).unwrap().base.amount)
    }
}

impl Env {
    pub fn update_params_ix(&self, signer: &Pubkey, update: parabull::state::GlobalUpdate) -> Instruction {
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::AdminOnly { admin: *signer, global: global_pda() }.to_account_metas(None),
            data: parabull::instruction::UpdateGlobalParams { update }.data(),
        }
    }

    pub fn propose_admin_ix(&self, signer: &Pubkey, new_admin: Pubkey) -> Instruction {
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::AdminOnly { admin: *signer, global: global_pda() }.to_account_metas(None),
            data: parabull::instruction::ProposeAdmin { new_admin }.data(),
        }
    }

    pub fn accept_admin_ix(&self, signer: &Pubkey) -> Instruction {
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::AcceptAdmin { pending_admin: *signer, global: global_pda() }.to_account_metas(None),
            data: parabull::instruction::AcceptAdmin {}.data(),
        }
    }

    /// `pool` is the pool recorded on the curve at migration.
    pub fn collect_lp_fees_ix(&self, crank: &Pubkey, mint: &Pubkey, pool: &Pubkey, fee_nft_mint: &Pubkey, fee_lp_amount: u64) -> Instruction {
        let order = parabull::raydium::sort_pool_mints(mint, &WSOL_MINT).unwrap();
        let p = parabull::raydium::cpmm_pool_accounts(&raydium_mock::CPMM_ID, pool, &order, &migration_authority(mint));
        let vault = fee_key_vault();
        let lock = parabull::raydium::lock_accounts(&raydium_mock::LOCK_ID, &raydium_mock::LOCK_AUTH, fee_nft_mint, &vault, &p.lp_mint);
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::CollectLpFees {
                crank: *crank,
                global: global_pda(),
                mint: *mint,
                bonding_curve: curve_pda(mint),
                fee_key_vault: vault,
                fee_vault_token_account: ata(&vault, mint),
                fee_vault_wsol_account: anchor_spl::associated_token::get_associated_token_address_with_program_id(&vault, &WSOL_MINT, &SPL_TOKEN),
                wsol_mint: WSOL_MINT,
                buyback_vault: pda(&[SEED_BUYBACK_VAULT]),
                holder_vault: pda(&[SEED_HOLDER_VAULT]),
                treasury: self.treasury,
                lp_lock_program: raydium_mock::LOCK_ID,
                lp_lock_authority: raydium_mock::LOCK_AUTH,
                fee_nft_account: lock.fee_nft_account,
                locked_liquidity: lock.locked_liquidity,
                cpmm_program: raydium_mock::CPMM_ID,
                cpmm_authority: p.authority,
                pool_state: *pool,
                lp_mint: p.lp_mint,
                token_0_vault: p.token_0_vault,
                token_1_vault: p.token_1_vault,
                lock_lp_vault: lock.lock_lp_vault,
                token_program: SPL_TOKEN,
                token_2022_program: TOKEN_2022,
                memo_program: parabull::raydium::MEMO_PROGRAM_ID,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: parabull::instruction::CollectLpFees { fee_lp_amount }.data(),
        }
    }

    /// Launch, buy out the curve, run all three graduation steps.
    /// Returns (mint, curve, fee NFT mint).
    pub async fn graduate_and_lock(&mut self) -> (Pubkey, Pubkey, Pubkey) {
        let creator = self.funded_user().await;
        let mint = self.launch_token(&creator, 1, "Pepe Coin", "PEPE").await;
        let curve = curve_pda(&mint);
        let c: BondingCurve = self.anchor(&curve).await;
        self.warp_to(c.trading_open_slot).await;
        let whale = self.user_with(100 * SOL).await;
        self.buy(&whale, &mint, u64::MAX, u64::MAX).await.unwrap();
        self.seed_cpmm_pool_accounts(&mint);
        let crank = self.crank.insecure_clone();
        let ixs = [self.prepare_migration_ix(&crank.pubkey(), &mint), self.migrate_raydium_ix(&crank.pubkey(), &mint)];
        self.send(&ixs, &[&crank]).await.unwrap();
        let nft = Keypair::new();
        let ix = self.lock_lp_ix(&crank.pubkey(), &mint, &nft.pubkey());
        self.send(&[ix], &[&crank, &nft]).await.unwrap();
        (mint, curve, nft.pubkey())
    }
}

// ---- Pause / buyback / holder-reward helpers ------------------------------------

/// Token account with a balance (WSOL accounts get matching native lamports).
pub fn packed_token_account_with(mint: Pubkey, owner: Pubkey, program: Pubkey, amount: u64) -> Account {
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token::spl_token::state::Account as TA;
    let mut acc = packed_token_account(mint, owner, program);
    let mut t = TA::unpack_from_slice(&acc.data).unwrap();
    t.amount = amount;
    t.pack_into_slice(&mut acc.data);
    if mint == WSOL_MINT {
        acc.lamports += amount;
    }
    acc
}

pub fn packed_mint_with_supply(decimals: u8, program: Pubkey, supply: u64) -> Account {
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token::spl_token::state::Mint as M;
    let mut acc = packed_mint(None, decimals, program);
    let mut m = M::unpack_from_slice(&acc.data).unwrap();
    m.supply = supply;
    m.pack_into_slice(&mut acc.data);
    acc
}

pub fn buyback_authority() -> Pubkey {
    pda(&[SEED_BUYBACK_AUTHORITY])
}

pub struct ParabullPool {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub wsol_vault: Pubkey,
    pub parabull_vault: Pubkey,
}

impl Env {
    /// Create a Token-2022 $PARABULL mint and a seeded WSOL/$PARABULL CPMM pool
    /// (mock), and point Global at them via `update_global_params`.
    pub async fn setup_parabull_pool(&mut self, wsol_liquidity: u64, parabull_liquidity: u64) -> ParabullPool {
        let mint = Pubkey::new_unique();
        self.ctx.set_account(&mint, &packed_mint_with_supply(6, TOKEN_2022, parabull_liquidity).into());
        let order = parabull::raydium::sort_pool_mints(&mint, &WSOL_MINT).unwrap();
        let k = parabull::raydium::cpmm_accounts(&raydium_mock::CPMM_ID, &AMM_CONFIG, &order, &Pubkey::default());
        let (wsol_vault, parabull_vault) = if order.mint_is_token_0 { (k.token_1_vault, k.token_0_vault) } else { (k.token_0_vault, k.token_1_vault) };
        self.ctx.set_account(&wsol_vault, &packed_token_account_with(WSOL_MINT, k.authority, SPL_TOKEN, wsol_liquidity).into());
        self.ctx.set_account(&parabull_vault, &packed_token_account_with(mint, k.authority, TOKEN_2022, parabull_liquidity).into());
        let mut pool_data = vec![0; 64];
        pool_data[..8].copy_from_slice(raydium_mock::POOL_MARKER);
        let owned = |data: Vec<u8>| Account { lamports: SOL, data, owner: raydium_mock::CPMM_ID, executable: false, rent_epoch: 0 };
        self.ctx.set_account(&k.pool_state, &owned(pool_data).into());
        self.ctx.set_account(&k.observation_state, &owned(vec![0; 8]).into());

        let admin = self.admin.insecure_clone();
        let update = parabull::state::GlobalUpdate { parabull_mint: Some(mint), parabull_pool: Some(k.pool_state), ..Default::default() };
        let ix = self.update_params_ix(&admin.pubkey(), update);
        self.send(&[ix], &[&admin]).await.unwrap();
        ParabullPool { mint, pool: k.pool_state, wsol_vault, parabull_vault }
    }

    /// Add lamports to a program-owned vault (simulates swept fees).
    pub async fn fund_account(&mut self, key: &Pubkey, lamports: u64) {
        let mut acc = self.account(key).await.unwrap();
        acc.lamports += lamports;
        self.ctx.set_account(key, &acc.into());
    }

    pub fn set_paused_ix(&self, signer: &Pubkey, paused: bool) -> Instruction {
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::AdminOnly { admin: *signer, global: global_pda() }.to_account_metas(None),
            data: parabull::instruction::SetPaused { paused }.data(),
        }
    }

    pub fn prepare_buyback_ix(&self, crank: &Pubkey, amount: u64) -> Instruction {
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::PrepareBuyback {
                crank: *crank,
                global: global_pda(),
                buyback_vault: pda(&[SEED_BUYBACK_VAULT]),
                buyback_authority: buyback_authority(),
            }
            .to_account_metas(None),
            data: parabull::instruction::PrepareBuyback { amount }.data(),
        }
    }

    pub fn buyback_and_burn_ix(&self, crank: &Pubkey, p: &ParabullPool, min_amount_out: u64) -> Instruction {
        let order = parabull::raydium::sort_pool_mints(&p.mint, &WSOL_MINT).unwrap();
        let k = parabull::raydium::cpmm_pool_accounts(&raydium_mock::CPMM_ID, &p.pool, &order, &buyback_authority());
        let auth = buyback_authority();
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::BuybackAndBurn {
                crank: *crank,
                global: global_pda(),
                buyback_vault: pda(&[SEED_BUYBACK_VAULT]),
                buyback_authority: auth,
                parabull_mint: p.mint,
                parabull_token_program: TOKEN_2022,
                authority_parabull_account: ata(&auth, &p.mint),
                wsol_mint: WSOL_MINT,
                authority_wsol_account: anchor_spl::associated_token::get_associated_token_address_with_program_id(&auth, &WSOL_MINT, &SPL_TOKEN),
                cpmm_program: raydium_mock::CPMM_ID,
                cpmm_authority: k.authority,
                amm_config: AMM_CONFIG,
                pool_state: p.pool,
                wsol_vault: p.wsol_vault,
                parabull_vault: p.parabull_vault,
                observation_state: k.observation_state,
                token_program: SPL_TOKEN,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: parabull::instruction::BuybackAndBurn { min_amount_out }.data(),
        }
    }

    pub fn reward_epoch_pda(epoch: u64) -> Pubkey {
        pda(&[SEED_REWARD_EPOCH, &epoch.to_le_bytes()])
    }

    pub async fn publish_epoch_ix(&mut self, crank: &Pubkey, root: [u8; 32], total: u64, num_leaves: u32) -> Instruction {
        let v: parabull::state::HolderRewardVault = self.anchor(&pda(&[SEED_HOLDER_VAULT])).await;
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::PublishRewardEpoch {
                crank: *crank,
                global: global_pda(),
                holder_vault: pda(&[SEED_HOLDER_VAULT]),
                reward_epoch: Self::reward_epoch_pda(v.next_epoch),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: parabull::instruction::PublishRewardEpoch { merkle_root: root, total_lamports: total, num_leaves, snapshot_slot: 123 }.data(),
        }
    }

    pub fn claim_ix(&self, epoch: u64, claimant: &Pubkey, index: u32, amount: u64, proof: Vec<[u8; 32]>) -> Instruction {
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::ClaimHolderReward {
                holder_vault: pda(&[SEED_HOLDER_VAULT]),
                reward_epoch: Self::reward_epoch_pda(epoch),
                claimant: *claimant,
            }
            .to_account_metas(None),
            data: parabull::instruction::ClaimHolderReward { epoch, index, amount, proof }.data(),
        }
    }

    pub async fn mint_supply(&mut self, mint: &Pubkey) -> u64 {
        let acc = self.account(mint).await.unwrap();
        StateWithExtensions::<SplMint>::unpack(&acc.data).unwrap().base.supply
    }
}

impl Env {
    pub fn expire_epoch_ix(&self, authority: &Pubkey, epoch_index: u64) -> Instruction {
        Instruction {
            program_id: parabull::ID,
            accounts: parabull::accounts::ExpireRewardEpoch {
                authority: *authority,
                global: global_pda(),
                holder_vault: pda(&[SEED_HOLDER_VAULT]),
                reward_epoch: Self::reward_epoch_pda(epoch_index),
            }
            .to_account_metas(None),
            data: parabull::instruction::ExpireRewardEpoch { epoch_index }.data(),
        }
    }
}

pub fn tweet_registry_pda(tweet_id: u64) -> Pubkey {
    let hash = parabull::launch::tweet_id_hash(tweet_id).unwrap();
    pda(&[SEED_TWEET_REGISTRY, &hash])
}

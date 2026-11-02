//! Shared solana-program-test harness. Parabull runs as a native processor
//! against the real SPL Token-2022 and ATA programs bundled with program-test.
#![allow(dead_code, unused_imports)]

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
    pub launch: Keypair,
    pub treasury: Pubkey,
}

impl Env {
    pub async fn new() -> Self {
        Self::with_global(|_| {}).await
    }

    /// Start a test validator with a pre-initialised `Global`, customised by `tweak`.
    pub async fn with_global(tweak: impl FnOnce(&mut Global)) -> Self {
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
        let mut global = global;
        tweak(&mut global);
        let mut data = Vec::with_capacity(8 + Global::INIT_SPACE);
        global.try_serialize(&mut data).unwrap();
        data.resize(8 + Global::INIT_SPACE, 0);
        pt.add_account(global_key, Account { lamports: SOL, data, owner: parabull::ID, executable: false, rent_epoch: 0 });
        pt.add_account(launch.pubkey(), Account { lamports: 10 * SOL, ..Account::default() });
        pt.add_account(treasury, Account { lamports: SOL, ..Account::default() });

        let ctx = pt.start_with_context().await;
        Env { ctx, launch, treasury }
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

    pub fn request_ix(&self, payer: &Pubkey, nonce: u64, name: &str, symbol: &str, uri: &str) -> Instruction {
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

    pub async fn request(&mut self, user: &Keypair, nonce: u64, name: &str, symbol: &str, uri: &str) -> Result<(), BanksClientError> {
        let ix = self.request_ix(&user.pubkey(), nonce, name, symbol, uri);
        self.send(&[ix], &[user]).await
    }

    /// Backend create with a fresh mint keypair. Returns the mint on success.
    pub async fn create(&mut self, user: &Pubkey, nonce: u64, name: &str, symbol: &str, uri: &str) -> Result<Pubkey, BanksClientError> {
        let mint = Keypair::new();
        let launch = self.launch.insecure_clone();
        let ix = self.create_ix(&launch.pubkey(), user, nonce, &mint.pubkey(), name, symbol, uri);
        self.send(&[ix], &[&launch, &mint]).await.map(|_| mint.pubkey())
    }
}

pub fn assert_custom(res: Result<impl std::fmt::Debug, BanksClientError>, expected: ParabullError) {
    let code = err_code(expected);
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


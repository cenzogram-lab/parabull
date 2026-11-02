//! Raydium CPMM + Burn & Earn (LP lock) interface, hand-built so Parabull does
//! not depend on Raydium's crates (which pin other Anchor versions).
//!
//! Sources (read 2026-11-02):
//! - CPMM `initialize` accounts/seeds: raydium-io/raydium-cp-swap
//!   `programs/cp-swap/src/instructions/initialize.rs`, `states/pool.rs`,
//!   `states/oracle.rs`, `lib.rs` (`AUTH_SEED`).
//! - Lock program `lock_cp_liquidity` accounts: @raydium-io/raydium-sdk-v2
//!   `src/raydium/cpmm/instruction.ts` (`cpmmLockPositionInstruction`,
//!   `makeCpmmLockInstruction`) and `pda.ts` (`getCpLockPda`).
//! Discriminators equal Anchor's `sha256("global:<name>")[..8]` (unit-tested).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::pubkey;
use anchor_spl::associated_token::get_associated_token_address_with_program_id as ata;

use crate::error::ParabullError;

pub const CPMM_PROGRAM_MAINNET: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
pub const LP_LOCK_PROGRAM_MAINNET: Pubkey = pubkey!("LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE");
pub const LP_LOCK_AUTHORITY_MAINNET: Pubkey = pubkey!("3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH");
/// CPMM `create_pool_fee_reveiver` (mainnet). CPMM enforces this address itself.
pub const CPMM_CREATE_POOL_FEE_RECEIVER_MAINNET: Pubkey = pubkey!("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
pub const METADATA_PROGRAM_ID: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
pub const WSOL_MINT: Pubkey = anchor_spl::token::spl_token::native_mint::ID;

pub const CPMM_AUTH_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
pub const CPMM_POOL_SEED: &[u8] = b"pool";
pub const CPMM_LP_MINT_SEED: &[u8] = b"pool_lp_mint";
pub const CPMM_VAULT_SEED: &[u8] = b"pool_vault";
pub const CPMM_OBSERVATION_SEED: &[u8] = b"observation";
pub const LOCK_LIQUIDITY_SEED: &[u8] = b"locked_liquidity";

pub const IX_CPMM_INITIALIZE: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];
pub const IX_LOCK_CP_LIQUIDITY: [u8; 8] = [216, 157, 29, 78, 38, 51, 31, 26];
/// Burn & Earn `collect_cp_fees(fee_lp_amount: u64)`. The SDK calls this
/// `collectCpFee`; the on-chain name was confirmed via the discriminator.
pub const IX_LOCK_COLLECT_CP_FEES: [u8; 8] = [8, 30, 51, 199, 209, 184, 247, 133];
pub const IX_CPMM_SWAP_BASE_INPUT: [u8; 8] = [143, 190, 90, 218, 196, 30, 51, 222];
pub const MEMO_PROGRAM_ID: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const TOKEN_PROGRAM: Pubkey = anchor_spl::token::ID;
const TOKEN_2022_PROGRAM: Pubkey = anchor_spl::token_2022::ID;
const ATA_PROGRAM: Pubkey = anchor_spl::associated_token::ID;
const SYSTEM_PROGRAM: Pubkey = anchor_lang::system_program::ID;
const RENT_SYSVAR: Pubkey = anchor_lang::solana_program::sysvar::rent::ID;

// ---------------------------------------------------------------------------
// Pure migration rules
// ---------------------------------------------------------------------------

/// CPMM requires `token_0_mint < token_1_mint` (byte order of the pubkeys).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolOrder {
    pub token_0: Pubkey,
    pub token_1: Pubkey,
    /// True when the launched token is `token_0` (WSOL is `token_1`).
    pub mint_is_token_0: bool,
}

pub fn sort_pool_mints(mint: &Pubkey, wsol: &Pubkey) -> Result<PoolOrder> {
    require_keys_neq!(*mint, *wsol, ParabullError::InvalidMigrationAccount);
    Ok(if mint < wsol {
        PoolOrder { token_0: *mint, token_1: *wsol, mint_is_token_0: true }
    } else {
        PoolOrder { token_0: *wsol, token_1: *mint, mint_is_token_0: false }
    })
}

impl PoolOrder {
    /// `(init_amount_0, init_amount_1)` for the given token and SOL amounts.
    pub fn amounts(&self, token_amount: u64, sol_amount: u64) -> (u64, u64) {
        if self.mint_is_token_0 {
            (token_amount, sol_amount)
        } else {
            (sol_amount, token_amount)
        }
    }

    /// Token program of `token_0` / `token_1`: launched mints are Token-2022, WSOL is SPL Token.
    pub fn programs(&self) -> (Pubkey, Pubkey) {
        if self.mint_is_token_0 {
            (TOKEN_2022_PROGRAM, TOKEN_PROGRAM)
        } else {
            (TOKEN_PROGRAM, TOKEN_2022_PROGRAM)
        }
    }
}

/// Split the curve's real SOL at migration: everything except the reserve
/// seeds the pool. Fails if the curve didn't raise more than the reserve.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MigrationSplit {
    pub sol_to_pool: u64,
    pub reserve: u64,
}

pub fn migration_split(real_sol_reserves: u64, reserve: u64) -> Result<MigrationSplit> {
    let sol_to_pool = real_sol_reserves.checked_sub(reserve).ok_or(ParabullError::InsufficientMigrationSol)?;
    require!(sol_to_pool > 0, ParabullError::InsufficientMigrationSol);
    Ok(MigrationSplit { sol_to_pool, reserve })
}

/// Opening pool price must not undercut the curve's final price by more than
/// `max_discount_bps` (guards a misconfigured reserve). Compares
/// `sol_to_pool / tokens` against `virtual_sol / virtual_token`.
pub fn pool_price_within(sol_to_pool: u64, tokens: u64, virtual_sol: u64, virtual_token: u64, max_discount_bps: u64) -> bool {
    // sol/tokens >= (1 - d) * vs/vt  <=>  sol * vt * 10_000 >= (10_000 - d) * vs * tokens
    let lhs = u128::from(sol_to_pool) * u128::from(virtual_token) * 10_000;
    let rhs = u128::from(10_000u64.saturating_sub(max_discount_bps)) * u128::from(virtual_sol) * u128::from(tokens);
    lhs >= rhs
}

// ---------------------------------------------------------------------------
// Address derivation
// ---------------------------------------------------------------------------

/// Every account `initialize` touches, derived from (program, config, mints, creator).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CpmmAccounts {
    pub authority: Pubkey,
    pub pool_state: Pubkey,
    pub lp_mint: Pubkey,
    pub token_0_vault: Pubkey,
    pub token_1_vault: Pubkey,
    pub observation_state: Pubkey,
    pub creator_lp_token: Pubkey,
}

pub fn cpmm_accounts(program: &Pubkey, amm_config: &Pubkey, order: &PoolOrder, creator: &Pubkey) -> CpmmAccounts {
    let pda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, program).0;
    let pool_state = pda(&[CPMM_POOL_SEED, amm_config.as_ref(), order.token_0.as_ref(), order.token_1.as_ref()]);
    let lp_mint = pda(&[CPMM_LP_MINT_SEED, pool_state.as_ref()]);
    CpmmAccounts {
        authority: pda(&[CPMM_AUTH_SEED]),
        pool_state,
        lp_mint,
        token_0_vault: pda(&[CPMM_VAULT_SEED, pool_state.as_ref(), order.token_0.as_ref()]),
        token_1_vault: pda(&[CPMM_VAULT_SEED, pool_state.as_ref(), order.token_1.as_ref()]),
        observation_state: pda(&[CPMM_OBSERVATION_SEED, pool_state.as_ref()]),
        // CPMM's LP mint is always classic SPL Token.
        creator_lp_token: ata(creator, &lp_mint, &TOKEN_PROGRAM),
    }
}

/// Accounts of an *existing* pool, derived from its address (not from the
/// AmmConfig), so post-graduation instructions keep working if
/// `Global.cpmm_amm_config` is changed later.
pub fn cpmm_pool_accounts(program: &Pubkey, pool_state: &Pubkey, order: &PoolOrder, creator: &Pubkey) -> CpmmAccounts {
    let pda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, program).0;
    let lp_mint = pda(&[CPMM_LP_MINT_SEED, pool_state.as_ref()]);
    CpmmAccounts {
        authority: pda(&[CPMM_AUTH_SEED]),
        pool_state: *pool_state,
        lp_mint,
        token_0_vault: pda(&[CPMM_VAULT_SEED, pool_state.as_ref(), order.token_0.as_ref()]),
        token_1_vault: pda(&[CPMM_VAULT_SEED, pool_state.as_ref(), order.token_1.as_ref()]),
        observation_state: pda(&[CPMM_OBSERVATION_SEED, pool_state.as_ref()]),
        creator_lp_token: ata(creator, &lp_mint, &TOKEN_PROGRAM),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockAccounts {
    pub locked_liquidity: Pubkey,
    pub fee_nft_account: Pubkey,
    pub lock_lp_vault: Pubkey,
    pub nft_metadata: Pubkey,
}

pub fn lock_accounts(lock_program: &Pubkey, lock_authority: &Pubkey, fee_nft_mint: &Pubkey, fee_nft_owner: &Pubkey, lp_mint: &Pubkey) -> LockAccounts {
    LockAccounts {
        locked_liquidity: Pubkey::find_program_address(&[LOCK_LIQUIDITY_SEED, fee_nft_mint.as_ref()], lock_program).0,
        fee_nft_account: ata(fee_nft_owner, fee_nft_mint, &TOKEN_PROGRAM),
        lock_lp_vault: ata(lock_authority, lp_mint, &TOKEN_PROGRAM),
        nft_metadata: Pubkey::find_program_address(
            &[b"metadata", METADATA_PROGRAM_ID.as_ref(), fee_nft_mint.as_ref()],
            &METADATA_PROGRAM_ID,
        )
        .0,
    }
}

// ---------------------------------------------------------------------------
// Instruction builders (account order is part of the external ABI)
// ---------------------------------------------------------------------------

pub struct CpmmInitialize {
    pub program: Pubkey,
    pub creator: Pubkey,
    pub amm_config: Pubkey,
    pub order: PoolOrder,
    pub accounts: CpmmAccounts,
    pub creator_token_0: Pubkey,
    pub creator_token_1: Pubkey,
    pub create_pool_fee: Pubkey,
    pub init_amount_0: u64,
    pub init_amount_1: u64,
    pub open_time: u64,
}

impl CpmmInitialize {
    pub fn instruction(&self) -> Instruction {
        let a = &self.accounts;
        let (token_0_program, token_1_program) = self.order.programs();
        let mut data = IX_CPMM_INITIALIZE.to_vec();
        data.extend_from_slice(&self.init_amount_0.to_le_bytes());
        data.extend_from_slice(&self.init_amount_1.to_le_bytes());
        data.extend_from_slice(&self.open_time.to_le_bytes());
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(self.creator, true),
                AccountMeta::new_readonly(self.amm_config, false),
                AccountMeta::new_readonly(a.authority, false),
                AccountMeta::new(a.pool_state, false),
                AccountMeta::new_readonly(self.order.token_0, false),
                AccountMeta::new_readonly(self.order.token_1, false),
                AccountMeta::new(a.lp_mint, false),
                AccountMeta::new(self.creator_token_0, false),
                AccountMeta::new(self.creator_token_1, false),
                AccountMeta::new(a.creator_lp_token, false),
                AccountMeta::new(a.token_0_vault, false),
                AccountMeta::new(a.token_1_vault, false),
                AccountMeta::new(self.create_pool_fee, false),
                AccountMeta::new(a.observation_state, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(token_0_program, false),
                AccountMeta::new_readonly(token_1_program, false),
                AccountMeta::new_readonly(ATA_PROGRAM, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
                AccountMeta::new_readonly(RENT_SYSVAR, false),
            ],
            data,
        }
    }
}

pub struct LockCpLiquidity {
    pub program: Pubkey,
    pub authority: Pubkey,
    pub payer: Pubkey,
    pub liquidity_owner: Pubkey,
    pub fee_nft_owner: Pubkey,
    pub fee_nft_mint: Pubkey,
    pub pool_state: Pubkey,
    pub lp_mint: Pubkey,
    pub liquidity_owner_lp: Pubkey,
    pub token_0_vault: Pubkey,
    pub token_1_vault: Pubkey,
    pub accounts: LockAccounts,
    pub lp_amount: u64,
    pub with_metadata: bool,
}

impl LockCpLiquidity {
    pub fn instruction(&self) -> Instruction {
        let a = &self.accounts;
        let mut data = IX_LOCK_CP_LIQUIDITY.to_vec();
        data.extend_from_slice(&self.lp_amount.to_le_bytes());
        data.push(u8::from(self.with_metadata));
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new_readonly(self.authority, false),
                AccountMeta::new(self.payer, true),
                AccountMeta::new_readonly(self.liquidity_owner, true),
                AccountMeta::new_readonly(self.fee_nft_owner, false),
                AccountMeta::new(self.fee_nft_mint, true),
                AccountMeta::new(a.fee_nft_account, false),
                AccountMeta::new_readonly(self.pool_state, false),
                AccountMeta::new(a.locked_liquidity, false),
                AccountMeta::new_readonly(self.lp_mint, false),
                AccountMeta::new(self.liquidity_owner_lp, false),
                AccountMeta::new(a.lock_lp_vault, false),
                AccountMeta::new(self.token_0_vault, false),
                AccountMeta::new(self.token_1_vault, false),
                AccountMeta::new(a.nft_metadata, false),
                AccountMeta::new_readonly(RENT_SYSVAR, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(ATA_PROGRAM, false),
                AccountMeta::new_readonly(METADATA_PROGRAM_ID, false),
            ],
            data,
        }
    }
}

/// CPMM `swap_base_input(amount_in, minimum_amount_out)`. Account order from
/// raydium-cp-swap `instructions/swap_base_input.rs` (matches the SDK).
pub struct CpmmSwapBaseInput {
    pub program: Pubkey,
    pub payer: Pubkey,
    pub authority: Pubkey,
    pub amm_config: Pubkey,
    pub pool_state: Pubkey,
    pub input_token_account: Pubkey,
    pub output_token_account: Pubkey,
    pub input_vault: Pubkey,
    pub output_vault: Pubkey,
    pub input_token_program: Pubkey,
    pub output_token_program: Pubkey,
    pub input_token_mint: Pubkey,
    pub output_token_mint: Pubkey,
    pub observation_state: Pubkey,
    pub amount_in: u64,
    pub minimum_amount_out: u64,
}

impl CpmmSwapBaseInput {
    pub fn instruction(&self) -> Instruction {
        let mut data = IX_CPMM_SWAP_BASE_INPUT.to_vec();
        data.extend_from_slice(&self.amount_in.to_le_bytes());
        data.extend_from_slice(&self.minimum_amount_out.to_le_bytes());
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new_readonly(self.payer, true),
                AccountMeta::new_readonly(self.authority, false),
                AccountMeta::new_readonly(self.amm_config, false),
                AccountMeta::new(self.pool_state, false),
                AccountMeta::new(self.input_token_account, false),
                AccountMeta::new(self.output_token_account, false),
                AccountMeta::new(self.input_vault, false),
                AccountMeta::new(self.output_vault, false),
                AccountMeta::new_readonly(self.input_token_program, false),
                AccountMeta::new_readonly(self.output_token_program, false),
                AccountMeta::new_readonly(self.input_token_mint, false),
                AccountMeta::new_readonly(self.output_token_mint, false),
                AccountMeta::new(self.observation_state, false),
            ],
            data,
        }
    }
}

/// Burn & Earn `collect_cp_fees`: withdraws the fee share of the locked LP
/// from the pool and pays both tokens to the recipient accounts. Account
/// order from raydium-sdk-v2 `collectCpFeeInstruction`.
pub struct CollectCpFees {
    pub program: Pubkey,
    pub authority: Pubkey,
    pub fee_nft_owner: Pubkey,
    pub fee_nft_account: Pubkey,
    pub locked_liquidity: Pubkey,
    pub cpmm_program: Pubkey,
    pub cpmm_authority: Pubkey,
    pub pool_state: Pubkey,
    pub lp_mint: Pubkey,
    pub recipient_token_0: Pubkey,
    pub recipient_token_1: Pubkey,
    pub token_0_vault: Pubkey,
    pub token_1_vault: Pubkey,
    pub token_0_mint: Pubkey,
    pub token_1_mint: Pubkey,
    pub lock_lp_vault: Pubkey,
    pub fee_lp_amount: u64,
}

impl CollectCpFees {
    pub fn instruction(&self) -> Instruction {
        let mut data = IX_LOCK_COLLECT_CP_FEES.to_vec();
        data.extend_from_slice(&self.fee_lp_amount.to_le_bytes());
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new_readonly(self.authority, false),
                AccountMeta::new_readonly(self.fee_nft_owner, true),
                AccountMeta::new(self.fee_nft_account, false),
                AccountMeta::new(self.locked_liquidity, false),
                AccountMeta::new_readonly(self.cpmm_program, false),
                AccountMeta::new_readonly(self.cpmm_authority, false),
                AccountMeta::new(self.pool_state, false),
                AccountMeta::new(self.lp_mint, false),
                AccountMeta::new(self.recipient_token_0, false),
                AccountMeta::new(self.recipient_token_1, false),
                AccountMeta::new(self.token_0_vault, false),
                AccountMeta::new(self.token_1_vault, false),
                AccountMeta::new_readonly(self.token_0_mint, false),
                AccountMeta::new_readonly(self.token_1_mint, false),
                AccountMeta::new(self.lock_lp_vault, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(TOKEN_2022_PROGRAM, false),
                AccountMeta::new_readonly(MEMO_PROGRAM_ID, false),
            ],
            data,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::hash::hash;

    #[test]
    fn discriminators_match_anchor_global_namespace() {
        assert_eq!(hash(b"global:initialize").to_bytes()[..8], IX_CPMM_INITIALIZE);
        assert_eq!(hash(b"global:lock_cp_liquidity").to_bytes()[..8], IX_LOCK_CP_LIQUIDITY);
        assert_eq!(hash(b"global:collect_cp_fees").to_bytes()[..8], IX_LOCK_COLLECT_CP_FEES);
        assert_eq!(hash(b"global:swap_base_input").to_bytes()[..8], IX_CPMM_SWAP_BASE_INPUT);
    }

    #[test]
    fn pool_derivation_from_address_matches_config_derivation() {
        let config = Pubkey::new_unique();
        let creator = Pubkey::new_unique();
        let order = sort_pool_mints(&Pubkey::new_unique(), &WSOL_MINT).unwrap();
        let from_config = cpmm_accounts(&CPMM_PROGRAM_MAINNET, &config, &order, &creator);
        let from_pool = cpmm_pool_accounts(&CPMM_PROGRAM_MAINNET, &from_config.pool_state, &order, &creator);
        assert_eq!(from_config, from_pool);
    }

    #[test]
    fn collect_ix_layout() {
        let ix = CollectCpFees {
            program: LP_LOCK_PROGRAM_MAINNET,
            authority: LP_LOCK_AUTHORITY_MAINNET,
            fee_nft_owner: Pubkey::new_unique(),
            fee_nft_account: Pubkey::new_unique(),
            locked_liquidity: Pubkey::new_unique(),
            cpmm_program: CPMM_PROGRAM_MAINNET,
            cpmm_authority: Pubkey::new_unique(),
            pool_state: Pubkey::new_unique(),
            lp_mint: Pubkey::new_unique(),
            recipient_token_0: Pubkey::new_unique(),
            recipient_token_1: Pubkey::new_unique(),
            token_0_vault: Pubkey::new_unique(),
            token_1_vault: Pubkey::new_unique(),
            token_0_mint: Pubkey::new_unique(),
            token_1_mint: Pubkey::new_unique(),
            lock_lp_vault: Pubkey::new_unique(),
            fee_lp_amount: 77,
        }
        .instruction();
        assert_eq!(ix.accounts.len(), 18);
        assert_eq!(ix.data, [IX_LOCK_COLLECT_CP_FEES.as_slice(), &77u64.to_le_bytes()].concat());
        let signers: Vec<_> = ix.accounts.iter().enumerate().filter(|(_, m)| m.is_signer).map(|(i, _)| i).collect();
        assert_eq!(signers, vec![1], "only the fee-key NFT owner signs");
        assert_eq!(ix.accounts[17].pubkey, MEMO_PROGRAM_ID);
    }

    #[test]
    fn mint_ordering_is_strict_byte_order() {
        let low = Pubkey::new_from_array([0u8; 32]);
        let high = Pubkey::new_from_array([0xff; 32]);
        let o = sort_pool_mints(&low, &WSOL_MINT).unwrap();
        assert!(o.mint_is_token_0 && o.token_0 == low && o.token_1 == WSOL_MINT);
        assert_eq!(o.amounts(7, 9), (7, 9));
        assert_eq!(o.programs(), (TOKEN_2022_PROGRAM, TOKEN_PROGRAM));

        let o = sort_pool_mints(&high, &WSOL_MINT).unwrap();
        assert!(!o.mint_is_token_0 && o.token_0 == WSOL_MINT && o.token_1 == high);
        assert_eq!(o.amounts(7, 9), (9, 7));
        assert_eq!(o.programs(), (TOKEN_PROGRAM, TOKEN_2022_PROGRAM));

        for _ in 0..1_000 {
            let m = Pubkey::new_unique();
            let o = sort_pool_mints(&m, &WSOL_MINT).unwrap();
            assert!(o.token_0 < o.token_1, "CPMM constraint token_0 < token_1");
        }
        assert!(sort_pool_mints(&WSOL_MINT, &WSOL_MINT).is_err());
    }

    #[test]
    fn migration_split_holds_back_reserve() {
        let s = migration_split(85_005_359_057, 250_000_000).unwrap();
        assert_eq!(s, MigrationSplit { sol_to_pool: 84_755_359_057, reserve: 250_000_000 });
        assert!(migration_split(250_000_000, 250_000_000).is_err());
        assert!(migration_split(1, 250_000_000).is_err());
    }

    #[test]
    fn opening_price_continuity_with_default_curve() {
        use crate::constants::*;
        // Full default curve: final virtual reserves and the tokens left for the pool.
        let vt = DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES - DEFAULT_INITIAL_REAL_TOKEN_RESERVES;
        let real_sol = 85_005_359_057u64;
        let vs = DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES + real_sol;
        let tokens = DEFAULT_TOKEN_TOTAL_SUPPLY - DEFAULT_INITIAL_REAL_TOKEN_RESERVES;
        let s = migration_split(real_sol, DEFAULT_MIGRATION_RESERVE_LAMPORTS).unwrap();
        // The default shape opens the pool within 1% of the curve's last price.
        assert!(pool_price_within(s.sol_to_pool, tokens, vs, vt, 100));
        // But a reserve that eats half the SOL would be rejected at 10%.
        assert!(!pool_price_within(real_sol / 2, tokens, vs, vt, 1_000));
    }

    #[test]
    fn cpmm_addresses_follow_documented_seeds() {
        let program = CPMM_PROGRAM_MAINNET;
        let config = Pubkey::new_unique();
        let creator = Pubkey::new_unique();
        let order = sort_pool_mints(&Pubkey::new_unique(), &WSOL_MINT).unwrap();
        let a = cpmm_accounts(&program, &config, &order, &creator);
        let (pool, _) = Pubkey::find_program_address(&[b"pool", config.as_ref(), order.token_0.as_ref(), order.token_1.as_ref()], &program);
        assert_eq!(a.pool_state, pool);
        assert_eq!(a.lp_mint, Pubkey::find_program_address(&[b"pool_lp_mint", pool.as_ref()], &program).0);
        assert_eq!(a.token_0_vault, Pubkey::find_program_address(&[b"pool_vault", pool.as_ref(), order.token_0.as_ref()], &program).0);
        assert_eq!(a.observation_state, Pubkey::find_program_address(&[b"observation", pool.as_ref()], &program).0);
        assert_eq!(a.creator_lp_token, ata(&creator, &a.lp_mint, &TOKEN_PROGRAM));
    }

    #[test]
    fn initialize_ix_layout() {
        let order = sort_pool_mints(&Pubkey::new_unique(), &WSOL_MINT).unwrap();
        let creator = Pubkey::new_unique();
        let config = Pubkey::new_unique();
        let accounts = cpmm_accounts(&CPMM_PROGRAM_MAINNET, &config, &order, &creator);
        let ix = CpmmInitialize {
            program: CPMM_PROGRAM_MAINNET,
            creator,
            amm_config: config,
            order,
            accounts,
            creator_token_0: Pubkey::new_unique(),
            creator_token_1: Pubkey::new_unique(),
            create_pool_fee: CPMM_CREATE_POOL_FEE_RECEIVER_MAINNET,
            init_amount_0: 1,
            init_amount_1: 2,
            open_time: 0,
        }
        .instruction();
        assert_eq!(ix.accounts.len(), 20);
        assert_eq!(ix.data.len(), 8 + 24);
        assert_eq!(&ix.data[8..16], &1u64.to_le_bytes());
        assert_eq!(&ix.data[16..24], &2u64.to_le_bytes());
        let signers: Vec<_> = ix.accounts.iter().filter(|m| m.is_signer).map(|m| m.pubkey).collect();
        assert_eq!(signers, vec![creator], "only the creator signs; pool_state is a PDA");
        assert_eq!(ix.accounts[3].pubkey, accounts.pool_state);
        assert_eq!(ix.accounts[19].pubkey, RENT_SYSVAR);
    }

    #[test]
    fn lock_ix_layout() {
        let lp_mint = Pubkey::new_unique();
        let nft = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let la = lock_accounts(&LP_LOCK_PROGRAM_MAINNET, &LP_LOCK_AUTHORITY_MAINNET, &nft, &owner, &lp_mint);
        let ix = LockCpLiquidity {
            program: LP_LOCK_PROGRAM_MAINNET,
            authority: LP_LOCK_AUTHORITY_MAINNET,
            payer: Pubkey::new_unique(),
            liquidity_owner: Pubkey::new_unique(),
            fee_nft_owner: owner,
            fee_nft_mint: nft,
            pool_state: Pubkey::new_unique(),
            lp_mint,
            liquidity_owner_lp: Pubkey::new_unique(),
            token_0_vault: Pubkey::new_unique(),
            token_1_vault: Pubkey::new_unique(),
            accounts: la,
            lp_amount: 42,
            with_metadata: true,
        }
        .instruction();
        assert_eq!(ix.accounts.len(), 19);
        assert_eq!(ix.data, [IX_LOCK_CP_LIQUIDITY.as_slice(), &42u64.to_le_bytes(), &[1]].concat());
        let signers: Vec<_> = ix.accounts.iter().enumerate().filter(|(_, m)| m.is_signer).map(|(i, _)| i).collect();
        assert_eq!(signers, vec![1, 2, 4], "payer, liquidity owner, fee NFT mint");
        assert_eq!(la.fee_nft_account, ata(&owner, &nft, &TOKEN_PROGRAM));
        assert_eq!(la.lock_lp_vault, ata(&LP_LOCK_AUTHORITY_MAINNET, &lp_mint, &TOKEN_PROGRAM));
    }
}

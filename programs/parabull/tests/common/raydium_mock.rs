//! Native mocks of Raydium CPMM `initialize` and Burn & Earn `lock_cp_liquidity`,
//! registered at the real mainnet program IDs.
//!
//! They re-derive every address from Raydium's documented seeds (written out
//! literally here, independent of `parabull::raydium`), assert account order,
//! discriminators and signer/payer requirements, then perform the observable
//! effects via CPI using the signer privileges Parabull passes down:
//! - CPMM: pull both sides of liquidity from the creator's token accounts into
//!   the vaults, create the creator's LP ATA (creator pays), mint LP, charge the
//!   0.15 SOL pool fee, and stamp the pool account.
//! - Lock: move all LP into the lock vault, create the fee-key NFT mint + ATA
//!   for the NFT owner (payer pays), create the locked-liquidity record.
//! Any wrong account, missing signature or unfunded payer panics -> tx fails.

use anchor_lang::solana_program::account_info::AccountInfo;
use anchor_lang::solana_program::entrypoint::ProgramResult;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::solana_program::pubkey::Pubkey;
use anchor_lang::solana_program::rent::Rent;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::solana_program::sysvar::Sysvar;
use anchor_spl::associated_token::get_associated_token_address_with_program_id as ata_of;
use anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account;
use anchor_spl::token::spl_token;
use anchor_spl::token_2022::spl_token_2022;

pub const CPMM_ID: Pubkey = parabull::raydium::CPMM_PROGRAM_MAINNET;
pub const LOCK_ID: Pubkey = parabull::raydium::LP_LOCK_PROGRAM_MAINNET;
pub const LOCK_AUTH: Pubkey = parabull::raydium::LP_LOCK_AUTHORITY_MAINNET;
pub const POOL_FEE_RECEIVER: Pubkey = parabull::raydium::CPMM_CREATE_POOL_FEE_RECEIVER_MAINNET;
pub const MOCK_CREATE_POOL_FEE: u64 = 150_000_000;
pub const POOL_MARKER: &[u8; 8] = b"MOCKPOOL";
pub const LOCK_MARKER: &[u8; 8] = b"MOCKLOCK";
/// Mock-private CPMM instruction used by the lock mock to pay out fees
/// (the real lock program withdraws through CPMM in the same way).
pub const MOCK_WITHDRAW: [u8; 8] = *b"mockwdrw";
const METAPLEX: Pubkey = parabull::raydium::METADATA_PROGRAM_ID;
const SYSTEM: Pubkey = anchor_lang::system_program::ID;

fn token_account(ai: &AccountInfo) -> spl_token_2022::state::Account {
    spl_token_2022::state::Account::unpack_from_slice(&ai.data.borrow()[..spl_token_2022::state::Account::LEN]).expect("token account")
}

fn decimals(mint: &AccountInfo) -> u8 {
    spl_token_2022::state::Mint::unpack_from_slice(&mint.data.borrow()[..spl_token_2022::state::Mint::LEN]).expect("mint").decimals
}

fn u64_at(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}

pub fn mock_cpmm(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    assert_eq!(*program_id, CPMM_ID);
    if data[..8] == MOCK_WITHDRAW {
        return mock_cpmm_withdraw(program_id, accounts, data);
    }
    if data[..8] == [143, 190, 90, 218, 196, 30, 51, 222] {
        return mock_cpmm_swap_base_input(program_id, accounts, data);
    }
    assert_eq!(data.len(), 32, "cpmm: data = disc + 3 x u64");
    assert_eq!(&data[..8], &[175, 175, 109, 31, 13, 152, 155, 237], "cpmm: initialize discriminator");
    let (a0, a1, _open_time) = (u64_at(data, 8), u64_at(data, 16), u64_at(data, 24));
    assert!(accounts.len() >= 20, "cpmm: 20 accounts");
    let [creator, amm_config, authority, pool_state, mint0, mint1, lp_mint, ct0, ct1, clp, v0, v1, fee, obs, token_program, tp0, tp1, ata_prog, system, rent] =
        &accounts[..20]
    else {
        unreachable!()
    };

    assert!(creator.is_signer, "cpmm: creator must sign");
    assert!(creator.is_writable, "cpmm: creator must be writable (it pays)");
    assert_eq!(*creator.owner, SYSTEM, "cpmm: creator must be system-owned to pay");
    assert_eq!(*amm_config.owner, CPMM_ID, "cpmm: amm_config owned by CPMM");
    assert!(mint0.key < mint1.key, "cpmm: token_0 < token_1");
    let pda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, program_id);
    let (auth_key, auth_bump) = pda(&[b"vault_and_lp_mint_auth_seed"]);
    assert_eq!(*authority.key, auth_key, "cpmm: authority PDA");
    // raydium-cp-swap `create_pool`: the account must be unused (system-owned); it is the canonical PDA, or any
    // address whose keypair signs. Every other pool account is seeded from the pool's own address.
    let (canonical, pool_bump) = pda(&[b"pool", amm_config.key.as_ref(), mint0.key.as_ref(), mint1.key.as_ref()]);
    assert_eq!(*pool_state.owner, SYSTEM, "cpmm: pool_state already exists (NotApproved)");
    if *pool_state.key != canonical {
        assert!(pool_state.is_signer, "cpmm: a non-canonical pool_state must sign");
    }
    let pool = *pool_state.key;
    assert_eq!(*lp_mint.key, pda(&[b"pool_lp_mint", pool.as_ref()]).0, "cpmm: lp mint PDA");
    assert_eq!(*v0.key, pda(&[b"pool_vault", pool.as_ref(), mint0.key.as_ref()]).0, "cpmm: vault 0");
    assert_eq!(*v1.key, pda(&[b"pool_vault", pool.as_ref(), mint1.key.as_ref()]).0, "cpmm: vault 1");
    assert_eq!(*obs.key, pda(&[b"observation", pool.as_ref()]).0, "cpmm: observation");
    assert_eq!(*clp.key, ata_of(creator.key, lp_mint.key, &spl_token::ID), "cpmm: creator LP ATA");
    assert_eq!(*fee.key, POOL_FEE_RECEIVER, "cpmm: create_pool_fee receiver");
    assert_eq!(*token_program.key, spl_token::ID, "cpmm: LP token program is SPL Token");
    assert_eq!(tp0.key, mint0.owner, "cpmm: token_0_program");
    assert_eq!(tp1.key, mint1.owner, "cpmm: token_1_program");
    assert_eq!(*ata_prog.key, anchor_spl::associated_token::ID);
    assert_eq!(*system.key, SYSTEM);
    assert_eq!(*rent.key, anchor_lang::solana_program::sysvar::rent::ID);
    for (src, mint, amount) in [(ct0, mint0, a0), (ct1, mint1, a1)] {
        let t = token_account(src);
        assert_eq!(t.mint, *mint.key, "cpmm: creator token account mint");
        assert_eq!(t.owner, *creator.key, "cpmm: creator token account owner");
        assert!(t.amount >= amount && amount > 0, "cpmm: creator holds the init amount");
    }

    // Liquidity in: creator's signature propagates from Parabull's invoke_signed.
    for (src, mint, vault, prog, amount) in [(ct0, mint0, v0, tp0, a0), (ct1, mint1, v1, tp1, a1)] {
        let ix = spl_token_2022::instruction::transfer_checked(prog.key, src.key, mint.key, vault.key, creator.key, &[], amount, decimals(mint))?;
        invoke(&ix, &[src.clone(), mint.clone(), vault.clone(), creator.clone(), prog.clone()])?;
    }

    // Creator's LP ATA (creator pays rent), then mint LP = sqrt(a0*a1) - 100 locked.
    let ix = create_associated_token_account(creator.key, creator.key, lp_mint.key, &spl_token::ID);
    invoke(&ix, &[creator.clone(), clp.clone(), creator.clone(), lp_mint.clone(), system.clone(), token_program.clone(), ata_prog.clone()])?;
    let lp = ((u128::from(a0) * u128::from(a1)) as f64).sqrt() as u64 - 100;
    let ix = spl_token::instruction::mint_to(&spl_token::ID, lp_mint.key, clp.key, authority.key, &[], lp)?;
    invoke_signed(&ix, &[lp_mint.clone(), clp.clone(), authority.clone(), token_program.clone()], &[&[b"vault_and_lp_mint_auth_seed", &[auth_bump]]])?;

    // Pool creation fee from the creator.
    invoke(&system_instruction::transfer(creator.key, fee.key, MOCK_CREATE_POOL_FEE), &[creator.clone(), fee.clone(), system.clone()])?;

    // The pool account, created and paid for by the creator (PDA: CPMM signs with its seeds; keypair: it signed).
    let space = 64;
    let ix = system_instruction::create_account(creator.key, pool_state.key, Rent::get()?.minimum_balance(space), space as u64, program_id);
    let seeds: &[&[u8]] = &[b"pool", amm_config.key.as_ref(), mint0.key.as_ref(), mint1.key.as_ref(), &[pool_bump]];
    if *pool_state.key == canonical {
        invoke_signed(&ix, &[creator.clone(), pool_state.clone(), system.clone()], &[seeds])?;
    } else {
        invoke(&ix, &[creator.clone(), pool_state.clone(), system.clone()])?;
    }

    let mut d = pool_state.data.borrow_mut();
    d[..8].copy_from_slice(POOL_MARKER);
    d[8..16].copy_from_slice(&a0.to_le_bytes());
    d[16..24].copy_from_slice(&a1.to_le_bytes());
    d[24..32].copy_from_slice(&lp.to_le_bytes());
    Ok(())
}

pub fn mock_lock(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    assert_eq!(*program_id, LOCK_ID);
    if data[..8] == [8, 30, 51, 199, 209, 184, 247, 133] {
        return mock_collect_cp_fees(program_id, accounts, data);
    }
    assert_eq!(data.len(), 17, "lock: disc + u64 + bool");
    assert_eq!(&data[..8], &[216, 157, 29, 78, 38, 51, 31, 26], "lock: lock_cp_liquidity discriminator");
    let lp_amount = u64_at(data, 8);
    assert_eq!(data[16], 1, "lock: with_metadata");
    assert_eq!(accounts.len(), 19, "lock: 19 accounts");
    let [auth, payer, liq_owner, nft_owner, nft_mint, nft_account, pool, locked, lp_mint, owner_lp, lock_vault, v0, v1, metadata, rent_sysvar, system, token_program, ata_prog, metadata_prog] =
        &accounts[..19]
    else {
        unreachable!()
    };

    assert_eq!(*auth.key, LOCK_AUTH, "lock: authority");
    assert!(payer.is_signer && payer.is_writable, "lock: payer signs, writable");
    assert_eq!(*payer.owner, SYSTEM, "lock: payer must be system-owned");
    assert!(liq_owner.is_signer, "lock: liquidity owner signs");
    assert!(nft_mint.is_signer && nft_mint.is_writable, "lock: fee NFT mint keypair signs");
    assert!(!nft_owner.is_signer, "lock: NFT owner does not need to sign");
    assert_eq!(*nft_account.key, ata_of(nft_owner.key, nft_mint.key, &spl_token::ID), "lock: NFT ATA");
    let (locked_key, locked_bump) = Pubkey::find_program_address(&[b"locked_liquidity", nft_mint.key.as_ref()], program_id);
    assert_eq!(*locked.key, locked_key, "lock: locked_liquidity PDA");
    assert_eq!(*lock_vault.key, ata_of(auth.key, lp_mint.key, &spl_token::ID), "lock: LP vault");
    let md = Pubkey::find_program_address(&[b"metadata", METAPLEX.as_ref(), nft_mint.key.as_ref()], &METAPLEX).0;
    assert_eq!(*metadata.key, md, "lock: NFT metadata PDA");
    assert_eq!(*metadata_prog.key, METAPLEX);
    assert_eq!(*rent_sysvar.key, anchor_lang::solana_program::sysvar::rent::ID);
    assert_eq!(*system.key, SYSTEM);
    assert_eq!(*token_program.key, spl_token::ID);
    assert_eq!(*ata_prog.key, anchor_spl::associated_token::ID);
    assert!(pool.data.borrow().starts_with(POOL_MARKER), "lock: pool must exist (created by CPMM)");
    assert!(v0.is_writable && v1.is_writable);
    let src = token_account(owner_lp);
    assert_eq!(src.mint, *lp_mint.key);
    assert_eq!(src.owner, *liq_owner.key, "lock: LP owned by liquidity owner");
    assert_eq!(src.amount, lp_amount, "lock: locking the full LP balance");

    // All LP into the lock vault (liquidity owner's signature propagates).
    let ix = spl_token::instruction::transfer_checked(&spl_token::ID, owner_lp.key, lp_mint.key, lock_vault.key, liq_owner.key, &[], lp_amount, 9)?;
    invoke(&ix, &[owner_lp.clone(), lp_mint.clone(), lock_vault.clone(), liq_owner.clone(), token_program.clone()])?;

    // Locked-liquidity record (payer funds it).
    let rent = Rent::get()?;
    let seeds: &[&[u8]] = &[b"locked_liquidity", nft_mint.key.as_ref(), &[locked_bump]];
    let ix = system_instruction::create_account(payer.key, locked.key, rent.minimum_balance(48), 48, program_id);
    invoke_signed(&ix, &[payer.clone(), locked.clone(), system.clone()], &[seeds])?;

    // Fee-key NFT: payer funds the mint and the owner's ATA; mint authority is the record PDA.
    let ix = system_instruction::create_account(payer.key, nft_mint.key, rent.minimum_balance(82), 82, &spl_token::ID);
    invoke(&ix, &[payer.clone(), nft_mint.clone(), system.clone()])?;
    let ix = spl_token::instruction::initialize_mint2(&spl_token::ID, nft_mint.key, locked.key, None, 0)?;
    invoke(&ix, &[nft_mint.clone(), token_program.clone()])?;
    let ix = create_associated_token_account(payer.key, nft_owner.key, nft_mint.key, &spl_token::ID);
    invoke(&ix, &[payer.clone(), nft_account.clone(), nft_owner.clone(), nft_mint.clone(), system.clone(), token_program.clone(), ata_prog.clone()])?;
    let ix = spl_token::instruction::mint_to(&spl_token::ID, nft_mint.key, nft_account.key, locked.key, &[], 1)?;
    invoke_signed(&ix, &[nft_mint.clone(), nft_account.clone(), locked.clone(), token_program.clone()], &[seeds])?;

    let mut d = locked.data.borrow_mut();
    d[..8].copy_from_slice(LOCK_MARKER);
    d[8..16].copy_from_slice(&lp_amount.to_le_bytes());
    d[16..48].copy_from_slice(pool.key.as_ref());
    Ok(())
}

/// Accounts: [cpmm_authority, vault0, vault1, mint0, mint1, dst0, dst1, prog0, prog1]; data: tag + a0 + a1.
fn mock_cpmm_withdraw(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [auth, v0, v1, mint0, mint1, d0, d1, p0, p1] = &accounts[..9] else { unreachable!() };
    let (auth_key, bump) = Pubkey::find_program_address(&[b"vault_and_lp_mint_auth_seed"], program_id);
    assert_eq!(*auth.key, auth_key);
    for (vault, mint, dst, prog, amount) in [(v0, mint0, d0, p0, u64_at(data, 8)), (v1, mint1, d1, p1, u64_at(data, 16))] {
        let ix = spl_token_2022::instruction::transfer_checked(prog.key, vault.key, mint.key, dst.key, auth.key, &[], amount, decimals(mint))?;
        invoke_signed(&ix, &[vault.clone(), mint.clone(), dst.clone(), auth.clone(), prog.clone()], &[&[b"vault_and_lp_mint_auth_seed", &[bump]]])?;
    }
    Ok(())
}

fn mock_collect_cp_fees(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    assert_eq!(data.len(), 16, "collect: disc + u64");
    let fee_lp = u64_at(data, 8);
    assert_eq!(accounts.len(), 18, "collect: 18 accounts");
    let [auth, nft_owner, nft_account, locked, cpmm_prog, cpmm_auth, pool, lp_mint, rec0, rec1, v0, v1, mint0, mint1, lock_vault, token_prog, token22_prog, memo] =
        &accounts[..18]
    else {
        unreachable!()
    };
    assert_eq!(*auth.key, LOCK_AUTH, "collect: authority");
    assert!(nft_owner.is_signer, "collect: fee-key NFT owner must sign");
    let nft = token_account(nft_account);
    assert_eq!((nft.owner, nft.amount), (*nft_owner.key, 1), "collect: signer holds the fee-key NFT");
    assert_eq!(*nft_account.key, ata_of(nft_owner.key, &nft.mint, &spl_token::ID), "collect: NFT ATA");
    let locked_key = Pubkey::find_program_address(&[b"locked_liquidity", nft.mint.as_ref()], program_id).0;
    assert_eq!(*locked.key, locked_key, "collect: locked_liquidity PDA for this NFT");
    let record = locked.data.borrow();
    assert!(record.starts_with(LOCK_MARKER));
    let locked_lp = u64_at(&record, 8);
    assert_eq!(&record[16..48], pool.key.as_ref(), "collect: lock belongs to this pool");
    drop(record);
    assert!(fee_lp > 0 && fee_lp <= locked_lp, "collect: fee_lp_amount within the locked LP");

    assert_eq!(*cpmm_prog.key, CPMM_ID);
    let cpda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &CPMM_ID).0;
    assert_eq!(*cpmm_auth.key, cpda(&[b"vault_and_lp_mint_auth_seed"]));
    assert!(mint0.key < mint1.key);
    assert_eq!(*lp_mint.key, cpda(&[b"pool_lp_mint", pool.key.as_ref()]));
    assert_eq!(*v0.key, cpda(&[b"pool_vault", pool.key.as_ref(), mint0.key.as_ref()]));
    assert_eq!(*v1.key, cpda(&[b"pool_vault", pool.key.as_ref(), mint1.key.as_ref()]));
    assert_eq!(*lock_vault.key, ata_of(auth.key, lp_mint.key, &spl_token::ID));
    assert_eq!(*token_prog.key, spl_token::ID);
    assert_eq!(*token22_prog.key, spl_token_2022::ID);
    assert_eq!(*memo.key, parabull::raydium::MEMO_PROGRAM_ID);
    for (rec, mint) in [(rec0, mint0), (rec1, mint1)] {
        let t = token_account(rec);
        assert_eq!(t.mint, *mint.key, "collect: recipient mint");
        assert_eq!(t.owner, *nft_owner.key, "collect: recipients owned by the NFT owner");
    }

    // Pay the fee share of each vault: amount_i = vault_i * fee_lp / lp_supply.
    let supply = spl_token::state::Mint::unpack_from_slice(&lp_mint.data.borrow()).unwrap().supply;
    let share = |v: &AccountInfo| (u128::from(token_account(v).amount) * u128::from(fee_lp) / u128::from(supply)) as u64;
    let (a0, a1) = (share(v0), share(v1));
    let prog_of = |m: &AccountInfo| if *m.owner == spl_token::ID { token_prog.clone() } else { token22_prog.clone() };
    let mut data = MOCK_WITHDRAW.to_vec();
    data.extend_from_slice(&a0.to_le_bytes());
    data.extend_from_slice(&a1.to_le_bytes());
    let metas = [cpmm_auth, v0, v1, mint0, mint1, rec0, rec1]
        .iter()
        .map(|ai| anchor_lang::solana_program::instruction::AccountMeta { pubkey: *ai.key, is_signer: false, is_writable: ai.is_writable })
        .chain([
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*prog_of(mint0).key, false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*prog_of(mint1).key, false),
        ])
        .collect();
    let ix = anchor_lang::solana_program::instruction::Instruction { program_id: CPMM_ID, accounts: metas, data };
    invoke(&ix, &[cpmm_auth.clone(), v0.clone(), v1.clone(), mint0.clone(), mint1.clone(), rec0.clone(), rec1.clone(), prog_of(mint0), prog_of(mint1), cpmm_prog.clone()])?;
    Ok(())
}

/// Real CPMM's `ExceededSlippage` is returned as a custom error; the mock uses this code.
pub const MOCK_SLIPPAGE_ERROR: u32 = 6005;

/// `swap_base_input`: constant product without fees, `out = r_out * in / (r_in + in)`.
fn mock_cpmm_swap_base_input(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    assert_eq!(data.len(), 24, "swap: disc + 2 x u64");
    let (amount_in, min_out) = (u64_at(data, 8), u64_at(data, 16));
    assert_eq!(accounts.len(), 13, "swap: 13 accounts");
    let [payer, authority, amm_config, pool, user_in, user_out, vault_in, vault_out, prog_in, prog_out, mint_in, mint_out, obs] = &accounts[..13] else {
        unreachable!()
    };
    assert!(payer.is_signer, "swap: payer signs");
    let pda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, program_id);
    let (auth_key, bump) = pda(&[b"vault_and_lp_mint_auth_seed"]);
    assert_eq!(*authority.key, auth_key, "swap: authority");
    assert_eq!(*amm_config.owner, CPMM_ID, "swap: amm_config");
    assert!(pool.data.borrow().starts_with(POOL_MARKER), "swap: pool exists");
    assert_eq!(*vault_in.key, pda(&[b"pool_vault", pool.key.as_ref(), mint_in.key.as_ref()]).0, "swap: input vault");
    assert_eq!(*vault_out.key, pda(&[b"pool_vault", pool.key.as_ref(), mint_out.key.as_ref()]).0, "swap: output vault");
    assert_eq!(*obs.key, pda(&[b"observation", pool.key.as_ref()]).0, "swap: observation");
    assert_eq!(prog_in.key, mint_in.owner, "swap: input token program");
    assert_eq!(prog_out.key, mint_out.owner, "swap: output token program");
    for (acct, mint) in [(user_in, mint_in), (user_out, mint_out)] {
        let t = token_account(acct);
        assert_eq!((t.mint, t.owner), (*mint.key, *payer.key), "swap: user accounts owned by payer");
    }
    let (r_in, r_out) = (token_account(vault_in).amount, token_account(vault_out).amount);
    let out = (u128::from(r_out) * u128::from(amount_in) / (u128::from(r_in) + u128::from(amount_in))) as u64;
    if out < min_out {
        return Err(anchor_lang::solana_program::program_error::ProgramError::Custom(MOCK_SLIPPAGE_ERROR));
    }
    let ix = spl_token_2022::instruction::transfer_checked(prog_in.key, user_in.key, mint_in.key, vault_in.key, payer.key, &[], amount_in, decimals(mint_in))?;
    invoke(&ix, &[user_in.clone(), mint_in.clone(), vault_in.clone(), payer.clone(), prog_in.clone()])?;
    let ix = spl_token_2022::instruction::transfer_checked(prog_out.key, vault_out.key, mint_out.key, user_out.key, authority.key, &[], out, decimals(mint_out))?;
    invoke_signed(&ix, &[vault_out.clone(), mint_out.clone(), user_out.clone(), authority.clone(), prog_out.clone()], &[&[b"vault_and_lp_mint_auth_seed", &[bump]]])?;
    Ok(())
}

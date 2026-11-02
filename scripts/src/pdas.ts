/** PDA seeds mirror programs/parabull/src/constants.rs and raydium.rs. */
import { PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { METADATA_PROGRAM_ID } from "./config";

const enc = (s: string) => Buffer.from(s, "utf8");
const u64le = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export class Pdas {
  constructor(readonly programId: PublicKey) {}
  private find(seeds: Buffer[]) {
    return PublicKey.findProgramAddressSync(seeds, this.programId)[0];
  }
  global = () => this.find([enc("global")]);
  bondingCurve = (mint: PublicKey) => this.find([enc("bonding-curve"), mint.toBuffer()]);
  mintAuthority = () => this.find([enc("mint-authority")]);
  ticket = (payer: PublicKey, nonce: bigint | number) => this.find([enc("ticket"), payer.toBuffer(), u64le(nonce)]);
  tickerRegistry = (ticker: string) => this.find([enc("registry"), enc(ticker)]);
  nameRegistry = (nameHash: Buffer) => this.find([enc("name"), nameHash]);
  buybackVault = () => this.find([enc("buyback-vault")]);
  holderVault = () => this.find([enc("holder-vault")]);
  rewardEpoch = (epoch: bigint | number) => this.find([enc("reward-epoch"), u64le(epoch)]);
  migrationAuthority = (mint: PublicKey) => this.find([enc("migration-authority"), mint.toBuffer()]);
  feeKeyVault = () => this.find([enc("fee-key-vault")]);
  buybackAuthority = () => this.find([enc("buyback-authority")]);
  /** Program's ProgramData account (upgradeable loader). */
  programData = () =>
    PublicKey.findProgramAddressSync([this.programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
}

/** Launched mints are Token-2022; WSOL is SPL Token. CPMM requires token_0 < token_1. */
export function sortPoolMints(mint: PublicKey) {
  const mintIsToken0 = Buffer.compare(mint.toBuffer(), NATIVE_MINT.toBuffer()) < 0;
  return {
    token0: mintIsToken0 ? mint : NATIVE_MINT,
    token1: mintIsToken0 ? NATIVE_MINT : mint,
    mintIsToken0,
    program0: mintIsToken0 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    program1: mintIsToken0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
  };
}

const cpmmPda = (program: PublicKey, seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];

/** Same derivation as `raydium::cpmm_accounts` (pool from config + mints). */
export function cpmmAccounts(cpmmProgram: PublicKey, ammConfig: PublicKey, mint: PublicKey, creator: PublicKey) {
  const o = sortPoolMints(mint);
  const pool = cpmmPda(cpmmProgram, [enc("pool"), ammConfig.toBuffer(), o.token0.toBuffer(), o.token1.toBuffer()]);
  return { ...cpmmPoolAccounts(cpmmProgram, pool, mint, creator), order: o };
}

/** Same derivation as `raydium::cpmm_pool_accounts` (from an existing pool address). */
export function cpmmPoolAccounts(cpmmProgram: PublicKey, pool: PublicKey, mint: PublicKey, creator: PublicKey) {
  const o = sortPoolMints(mint);
  const lpMint = cpmmPda(cpmmProgram, [enc("pool_lp_mint"), pool.toBuffer()]);
  return {
    order: o,
    authority: cpmmPda(cpmmProgram, [enc("vault_and_lp_mint_auth_seed")]),
    poolState: pool,
    lpMint,
    token0Vault: cpmmPda(cpmmProgram, [enc("pool_vault"), pool.toBuffer(), o.token0.toBuffer()]),
    token1Vault: cpmmPda(cpmmProgram, [enc("pool_vault"), pool.toBuffer(), o.token1.toBuffer()]),
    observationState: cpmmPda(cpmmProgram, [enc("observation"), pool.toBuffer()]),
    creatorLpToken: getAssociatedTokenAddressSync(lpMint, creator, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
  };
}

/** Same derivation as `raydium::lock_accounts`. */
export function lockAccounts(lockProgram: PublicKey, lockAuthority: PublicKey, feeNftMint: PublicKey, feeNftOwner: PublicKey, lpMint: PublicKey) {
  return {
    lockedLiquidity: PublicKey.findProgramAddressSync([enc("locked_liquidity"), feeNftMint.toBuffer()], lockProgram)[0],
    feeNftAccount: getAssociatedTokenAddressSync(feeNftMint, feeNftOwner, true, TOKEN_PROGRAM_ID),
    lockLpVault: getAssociatedTokenAddressSync(lpMint, lockAuthority, true, TOKEN_PROGRAM_ID),
    nftMetadata: PublicKey.findProgramAddressSync([enc("metadata"), METADATA_PROGRAM_ID.toBuffer(), feeNftMint.toBuffer()], METADATA_PROGRAM_ID)[0],
  };
}

export const ata2022 = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
export const ataSpl = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);

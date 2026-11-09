/**
 * Graduation of a completed curve: prepare_migration -> migrate_raydium ->
 * lock_migrated_lp, as separate transactions. Each step resumes from the
 * curve's `migration_stage`, so a failed run can simply be repeated. Used by
 * the crank and by the smoke test's GRADUATE=1 path.
 */
import { AccountInfo, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { METADATA_PROGRAM_ID, RaydiumAddresses } from "./config";
import { ata2022, ataSpl, cpmmAccounts, cpmmPoolAccounts, lockAccounts } from "./pdas";
import { connect, send } from "./program";

export const STAGE = { None: 0, Prepared: 1, PoolCreated: 2, LpLocked: 3 } as const;

/**
 * Where migrate_raydium creates the pool. The canonical CPMM pool PDA while it's unused (system-owned, even if
 * someone sent it lamports); once anyone has created it (a front-run), a fresh keypair that signs the transaction,
 * which CPMM accepts and nobody else can pre-empt. The program enforces the same rule
 * (programs/parabull/src/raydium.rs `check_pool_address`).
 */
export function chooseMigrationPool(canonical: PublicKey, canonicalInfo: Pick<AccountInfo<Buffer>, "owner"> | null, generate: () => Keypair = Keypair.generate): { pool: PublicKey; fresh: Keypair | null } {
  if (!canonicalInfo || canonicalInfo.owner.equals(SystemProgram.programId)) return { pool: canonical, fresh: null };
  const fresh = generate();
  return { pool: fresh.publicKey, fresh };
}

/** Marks `key` as a signer of `ix` (Anchor's IDL lists the pool as a plain account; a fresh-address pool signs). */
export function markSigner(ix: TransactionInstruction, key: PublicKey): TransactionInstruction {
  for (const k of ix.keys) if (k.pubkey.equals(key)) k.isSigner = true;
  return ix;
}

export type GraduationCtx = Pick<ReturnType<typeof connect>, "connection" | "program" | "pdas"> & {
  crank: Keypair;
  ray: Pick<RaydiumAddresses, "poolFeeReceiver">;
};

export async function graduate(x: GraduationCtx, mint: PublicKey, curve: PublicKey, stage: number, log: (m: string) => void = console.log) {
  const { program, pdas, crank, ray, connection } = x;
  const g = await program.account.global.fetch(pdas.global());
  const auth = pdas.migrationAuthority(mint);

  if (stage === STAGE.None) {
    const ix = await program.methods
      .prepareMigration()
      .accountsStrict({
        crank: crank.publicKey,
        global: pdas.global(),
        mint,
        bondingCurve: curve,
        curveTokenAccount: ata2022(mint, curve),
        migrationAuthority: auth,
        authorityTokenAccount: ata2022(mint, auth),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    log(`prepare_migration ${mint.toBase58()}: ${await send(connection, [ix], [crank])}`);
    stage = STAGE.Prepared;
  }

  if (stage === STAGE.Prepared) {
    const canonical = cpmmAccounts(g.cpmmProgram, g.cpmmAmmConfig, mint, auth);
    const { pool, fresh } = chooseMigrationPool(canonical.poolState, await connection.getAccountInfo(canonical.poolState, "confirmed"));
    if (fresh) log(`canonical pool ${canonical.poolState.toBase58()} already exists (front-run): migrating into fresh-address pool ${pool.toBase58()}`);
    const k = fresh ? cpmmPoolAccounts(g.cpmmProgram, pool, mint, auth) : canonical;
    const ix = await program.methods
      .migrateRaydium()
      .accountsStrict({
        crank: crank.publicKey,
        global: pdas.global(),
        mint,
        bondingCurve: curve,
        migrationAuthority: auth,
        authorityTokenAccount: ata2022(mint, auth),
        authorityWsolAccount: ataSpl(NATIVE_MINT, auth),
        wsolMint: NATIVE_MINT,
        cpmmProgram: g.cpmmProgram,
        ammConfig: g.cpmmAmmConfig,
        cpmmAuthority: k.authority,
        poolState: k.poolState,
        canonicalPoolState: canonical.poolState,
        lpMint: k.lpMint,
        creatorLpToken: k.creatorLpToken,
        token0Vault: k.token0Vault,
        token1Vault: k.token1Vault,
        createPoolFee: ray.poolFeeReceiver,
        observationState: k.observationState,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
    if (fresh) markSigner(ix, fresh.publicKey);
    log(`migrate_raydium ${mint.toBase58()} -> pool ${k.poolState.toBase58()}: ${await send(connection, [ix], fresh ? [crank, fresh] : [crank], 600_000)}`);
    stage = STAGE.PoolCreated;
  }

  if (stage === STAGE.PoolCreated) {
    const c = await program.account.bondingCurve.fetch(curve);
    const k = cpmmPoolAccounts(g.cpmmProgram, c.raydiumPool, mint, auth);
    const nft = Keypair.generate();
    const l = lockAccounts(g.lpLockProgram, g.lpLockAuthority, nft.publicKey, pdas.feeKeyVault(), k.lpMint);
    const ix = await program.methods
      .lockMigratedLp()
      .accountsStrict({
        crank: crank.publicKey,
        global: pdas.global(),
        mint,
        bondingCurve: curve,
        migrationAuthority: auth,
        feeKeyVault: pdas.feeKeyVault(),
        feeNftMint: nft.publicKey,
        treasury: g.treasury,
        lpLockProgram: g.lpLockProgram,
        lpLockAuthority: g.lpLockAuthority,
        poolState: c.raydiumPool,
        lpMint: k.lpMint,
        creatorLpToken: k.creatorLpToken,
        token0Vault: k.token0Vault,
        token1Vault: k.token1Vault,
        feeNftAccount: l.feeNftAccount,
        lockedLiquidity: l.lockedLiquidity,
        lockLpVault: l.lockLpVault,
        nftMetadata: l.nftMetadata,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        metadataProgram: METADATA_PROGRAM_ID,
      })
      .instruction();
    log(`lock_migrated_lp ${mint.toBase58()} (fee NFT ${nft.publicKey.toBase58()}): ${await send(connection, [ix], [crank, nft], 600_000)}`);
  }
}

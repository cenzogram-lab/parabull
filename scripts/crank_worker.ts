/**
 * Reference crank. Each pass:
 *  1. graduation: prepare_migration -> migrate_raydium -> lock_migrated_lp
 *     (separate transactions; each step is resumable from the curve's stage)
 *  2. release_dex_escrow for funded escrows (permissionless)
 *  3. sweep_fees above a threshold (permissionless)
 *  4. collect_lp_fees for locked pools (fee amount from Raydium's lock API,
 *     capped by the on-chain locked LP; OVERRIDE_LP_FEE_AMOUNT for testing)
 *  5. prepare_buyback + buyback_and_burn (one transaction) with a quoted floor
 *  6. expire_reward_epoch past each epoch's deadline
 *  7. optional: refresh the $299 DexScreener target (admin key) with --sol-usd
 *  8. optional: snapshot $PARABULL holders and publish a reward epoch with
 *     --publish-rewards (see src/snapshot.ts)
 *
 *   CLUSTER=devnet npm run crank -- --once [--sol-usd 152.3] [--publish-rewards]
 * Env: CRANK_KEYPAIR, ADMIN_KEYPAIR, SWEEP_MIN_LAMPORTS, BUYBACK_MIN_LAMPORTS,
 * BUYBACK_SLIPPAGE_BPS, POLL_MS, LP_FEE_MIN, OVERRIDE_LP_FEE_AMOUNT, and the
 * SNAPSHOT_* variables read by src/snapshot.ts.
 */
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { MEMO_PROGRAM_ID, cluster, raydium, roles } from "./src/config";
import { fetchLpFeeAmount } from "./src/lpFees";
import { runSnapshot } from "./src/snapshot";
import { STAGE, graduate as graduateCurve } from "./src/graduation";
import { applySlippage, cpmmQuoteOut } from "./src/curve";
import { ata2022, ataSpl, cpmmPoolAccounts, lockAccounts } from "./src/pdas";
import { ParabullProgram, big, bn, connect, isDefault, send } from "./src/program";
import { dexTargetLamports } from "./deploy_and_init";

const SWEEP_MIN = BigInt(process.env.SWEEP_MIN_LAMPORTS ?? "50000000"); // 0.05 SOL
const BUYBACK_MIN = BigInt(process.env.BUYBACK_MIN_LAMPORTS ?? "500000000"); // 0.5 SOL
const BUYBACK_SLIPPAGE_BPS = BigInt(process.env.BUYBACK_SLIPPAGE_BPS ?? "100");

type Ctx = ReturnType<typeof connect> & { crank: Keypair; admin: Keypair; ray: ReturnType<typeof raydium> };

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

const LP_FEE_MIN = BigInt(process.env.LP_FEE_MIN ?? "1");

/**
 * Claimable LP for one Burn & Earn position, keyed by its fee-key NFT (Raydium
 * tracks fees per lock position, not per pool). Uses Raydium's lock-position
 * API (src/lpFees.ts) and caps the result at the LP actually locked for
 * this pool. Our locks are the only ones on Parabull-migrated pools, so the
 * lock vault's balance is our locked LP. Returns null to skip the pool this
 * pass: no fees, API down or rate limited, or a value that isn't plausible.
 */
async function getLpFeeAmount(x: Ctx, lpMint: PublicKey, lockLpVault: PublicKey, feeNftMint: PublicKey): Promise<bigint | null> {
  const amount = await fetchLpFeeAmount(feeNftMint, { cluster: cluster(), log: (m) => log(m) });
  if (amount === null || amount < LP_FEE_MIN) return null;
  const locked = await x.connection.getTokenAccountBalance(lockLpVault).then((r) => BigInt(r.value.amount)).catch(() => null);
  if (locked === null) {
    log(`lock vault ${lockLpVault.toBase58()} (lp ${lpMint.toBase58()}) unreadable; skipping`);
    return null;
  }
  if (amount >= locked) {
    log(`claimable ${amount} >= locked ${locked} for NFT ${feeNftMint.toBase58()}; implausible, skipping`);
    return null;
  }
  return amount;
}

async function collectLpFees(x: Ctx, mint: PublicKey, curve: PublicKey) {
  const { program, pdas, crank, connection } = x;
  const c = await program.account.bondingCurve.fetch(curve);
  const g = await program.account.global.fetch(pdas.global());
  const k = cpmmPoolAccounts(g.cpmmProgram, c.raydiumPool, mint, pdas.migrationAuthority(mint));
  const l = lockAccounts(g.lpLockProgram, g.lpLockAuthority, c.feeNftMint, pdas.feeKeyVault(), k.lpMint);
  const amount = await getLpFeeAmount(x, k.lpMint, l.lockLpVault, c.feeNftMint);
  if (!amount) return;
  const ix = await program.methods
    .collectLpFees(bn(amount))
    .accountsStrict({
      crank: crank.publicKey,
      global: pdas.global(),
      mint,
      bondingCurve: curve,
      feeKeyVault: pdas.feeKeyVault(),
      feeVaultTokenAccount: ata2022(mint, pdas.feeKeyVault()),
      feeVaultWsolAccount: ataSpl(NATIVE_MINT, pdas.feeKeyVault()),
      wsolMint: NATIVE_MINT,
      buybackVault: pdas.buybackVault(),
      holderVault: pdas.holderVault(),
      treasury: g.treasury,
      lpLockProgram: g.lpLockProgram,
      lpLockAuthority: g.lpLockAuthority,
      feeNftAccount: l.feeNftAccount,
      lockedLiquidity: l.lockedLiquidity,
      cpmmProgram: g.cpmmProgram,
      cpmmAuthority: k.authority,
      poolState: c.raydiumPool,
      lpMint: k.lpMint,
      token0Vault: k.token0Vault,
      token1Vault: k.token1Vault,
      lockLpVault: l.lockLpVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  log(`collect_lp_fees ${mint.toBase58()}: ${await send(connection, [ix], [crank], 600_000)}`);
}

async function buyback(x: Ctx) {
  const { program, pdas, crank, connection } = x;
  const g = await program.account.global.fetch(pdas.global());
  if (isDefault(g.parabullPool)) return;
  const vault = pdas.buybackVault();
  const info = await connection.getAccountInfo(vault);
  if (!info) return;
  const rent = BigInt(await connection.getMinimumBalanceForRentExemption(info.data.length));
  const spendable = BigInt(info.lamports) - rent;
  if (spendable < BUYBACK_MIN) return;

  const mintInfo = await connection.getAccountInfo(g.parabullMint);
  if (!mintInfo) throw new Error("$PARABULL mint not found");
  const pbProgram = mintInfo.owner;
  const auth = pdas.buybackAuthority();
  const k = cpmmPoolAccounts(g.cpmmProgram, g.parabullPool, g.parabullMint, auth);
  const [wsolVault, pbVault] = k.order.mintIsToken0 ? [k.token1Vault, k.token0Vault] : [k.token0Vault, k.token1Vault];
  const pool = await connection.getAccountInfo(g.parabullPool);
  if (!pool) throw new Error("$PARABULL pool not found");
  const ammConfig = new PublicKey(pool.data.subarray(8, 40)); // PoolState.amm_config
  const cfg = await connection.getAccountInfo(ammConfig);
  const tradeFeeRate = cfg!.data.readBigUInt64LE(12); // AmmConfig.trade_fee_rate (/1e6)

  const rIn = BigInt((await connection.getTokenAccountBalance(wsolVault)).value.amount);
  const rOut = BigInt((await connection.getTokenAccountBalance(pbVault)).value.amount);
  const expected = cpmmQuoteOut(spendable, rIn, rOut, tradeFeeRate);
  const minOut = applySlippage(expected, BUYBACK_SLIPPAGE_BPS, false);
  if (minOut === 0n) return;

  const prep = await program.methods
    .prepareBuyback(bn(spendable))
    .accountsStrict({ crank: crank.publicKey, global: pdas.global(), buybackVault: vault, buybackAuthority: auth })
    .instruction();
  const burn = await program.methods
    .buybackAndBurn(bn(minOut))
    .accountsStrict({
      crank: crank.publicKey,
      global: pdas.global(),
      buybackVault: vault,
      buybackAuthority: auth,
      parabullMint: g.parabullMint,
      parabullTokenProgram: pbProgram,
      authorityParabullAccount: pbProgram.equals(TOKEN_2022_PROGRAM_ID) ? ata2022(g.parabullMint, auth) : ataSpl(g.parabullMint, auth),
      wsolMint: NATIVE_MINT,
      authorityWsolAccount: ataSpl(NATIVE_MINT, auth),
      cpmmProgram: g.cpmmProgram,
      cpmmAuthority: k.authority,
      ammConfig,
      poolState: g.parabullPool,
      wsolVault,
      parabullVault: pbVault,
      observationState: k.observationState,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  log(`buyback ${spendable} lamports, min_out ${minOut}: ${await send(connection, [prep, burn], [crank], 600_000)}`);
}

async function expireEpochs(x: Ctx) {
  const { program, pdas, crank } = x;
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const { publicKey, account: e } of await program.account.rewardEpoch.all()) {
    if (e.expired || now <= big(e.expiresAt)) continue;
    const sig = await program.methods
      .expireRewardEpoch(e.epoch)
      .accountsStrict({ authority: crank.publicKey, global: pdas.global(), holderVault: pdas.holderVault(), rewardEpoch: publicKey })
      .signers([crank])
      .rpc();
    log(`expired reward epoch ${e.epoch}: ${sig}`);
  }
}

async function refreshDexTarget(x: Ctx, solUsd: number) {
  const { program, pdas, admin } = x;
  const target = dexTargetLamports(solUsd);
  const g = await program.account.global.fetch(pdas.global());
  if (big(g.dexTargetLamports) === target) return;
  const sig = await program.methods
    .updateGlobalParams({
      dexTargetLamports: bn(target),
      buybackBps: null,
      holderBps: null,
      migrationReserveLamports: null,
      tradingOpenDelaySlots: null,
      cpmmProgram: null,
      cpmmAmmConfig: null,
      lpLockProgram: null,
      lpLockAuthority: null,
      parabullMint: null,
      parabullPool: null,
      rewardClaimWindowSeconds: null,
    })
    .accountsStrict({ admin: admin.publicKey, global: pdas.global() })
    .signers([admin])
    .rpc();
  log(`dex target -> ${target} lamports ($299 @ $${solUsd}): ${sig}`);
}

async function pass(x: Ctx, solUsd?: number, publishRewards = false) {
  const { program, pdas } = x;
  const g = await program.account.global.fetch(pdas.global());
  if (solUsd) await refreshDexTarget(x, solUsd).catch((e) => log("dex target update failed:", e));

  for (const { publicKey: curve, account: c } of await program.account.bondingCurve.all()) {
    const mint = c.mint;
    const step = async (name: string, f: () => Promise<unknown>) => f().catch((e) => log(`${name} ${mint.toBase58()} failed:`, e?.message ?? e));
    if (c.complete && c.migrationStage < STAGE.LpLocked) await step("graduate", () => graduateCurve(x, mint, curve, c.migrationStage, log));
    if (!c.escrowReleased && !g.dexTargetLamports.isZero() && c.escrowAccrued.gte(g.dexTargetLamports)) {
      await step("release_dex_escrow", () =>
        program.methods.releaseDexEscrow().accountsStrict({ global: pdas.global(), mint, bondingCurve: curve, treasury: g.treasury }).rpc(),
      );
    }
    const sweepable = big(c.buybackAccrued) + big(c.holderAccrued) + big(c.treasuryAccrued);
    if (sweepable >= SWEEP_MIN) {
      await step("sweep_fees", () =>
        program.methods
          .sweepFees()
          .accountsStrict({ global: pdas.global(), mint, bondingCurve: curve, buybackVault: pdas.buybackVault(), holderVault: pdas.holderVault(), treasury: g.treasury })
          .rpc(),
      );
    }
    if (c.migrationStage === STAGE.LpLocked) await step("collect_lp_fees", () => collectLpFees(x, mint, curve));
  }
  if (!g.paused) await buyback(x).catch((e) => log("buyback failed:", e?.message ?? e));
  await expireEpochs(x).catch((e) => log("expire epochs failed:", e?.message ?? e));
  if (publishRewards && !g.paused) {
    await runSnapshot({ publish: true, log }).catch((e) => log("reward snapshot failed:", e?.message ?? e));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const i = args.indexOf("--sol-usd");
  const solUsd = i >= 0 ? Number(args[i + 1]) : undefined;
  const publishRewards = args.includes("--publish-rewards");
  const { crank, admin } = roles();
  const x: Ctx = { ...connect(crank), crank, admin, ray: raydium() };
  log(`crank ${crank.publicKey.toBase58()} on program ${x.program.programId.toBase58()}`);
  do {
    await pass(x, solUsd, publishRewards);
    if (!once) await new Promise((r) => setTimeout(r, Number(process.env.POLL_MS ?? "15000")));
  } while (!once);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

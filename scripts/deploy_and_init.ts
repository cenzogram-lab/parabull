/**
 * Point at a deployed Parabull program and initialise `Global` (+ fee vaults).
 *
 *   anchor build && anchor deploy --provider.cluster devnet      # deploy first
 *   CLUSTER=devnet npm run deploy:init                            # then this
 *
 * Fails closed before sending anything if:
 *  - the program isn't deployed or its upgrade authority isn't ADMIN_KEYPAIR
 *    (`initialize` requires the upgrade authority);
 *  - any Raydium program isn't executable, or the AmmConfig isn't owned by
 *    the configured CPMM program (catches mainnet/devnet address mix-ups).
 * Idempotent: if Global exists, prints it and exits.
 *
 * Env: CLUSTER, RPC_URL, ADMIN_KEYPAIR, LAUNCH_AUTHORITY_KEYPAIR, CRANK_KEYPAIR,
 * TREASURY, PARABULL_MINT (devnet: created if unset), RAYDIUM_* overrides,
 * SOL_USD (to derive the $299 DexScreener target; default 150).
 *
 * Curve (src/curveParams.ts resolveCurve):
 *   CURVE_PRESET=small [CURVE_TARGET_SOL=2]   devnet test curve graduating at ~2 SOL
 *   INITIAL_VIRTUAL_TOKEN_RESERVES, INITIAL_VIRTUAL_SOL_RESERVES,
 *   INITIAL_REAL_TOKEN_RESERVES, TOKEN_TOTAL_SUPPLY   explicit values (all four)
 *   MIGRATION_RESERVE_LAMPORTS                 default 0.25 SOL
 */
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createMint } from "@solana/spl-token";
import { DEXSCREENER_LISTING_USD, LAMPORTS_PER_SOL, ammConfigPda, cluster, raydium, roles } from "./src/config";
import { bn, connect } from "./src/program";
import { MIGRATION_RENT_ALLOWANCE_LAMPORTS, graduationPreview, resolveCurve } from "./src/curveParams";

const DEFAULTS = {
  launchFeeLamports: 200_000_000n,
  ticketDepositLamports: 230_000_000n,
  ticketTtlSeconds: 10 * 60,
  platformFeeBps: 100,
  buybackBps: 5_000,
  holderBps: 4_000,
  tradingOpenDelaySlots: 2,
  registryLockSeconds: 3 * 24 * 60 * 60,
  rewardClaimWindowSeconds: 30 * 24 * 60 * 60,
};

export function dexTargetLamports(solUsd: number): bigint {
  return BigInt(Math.ceil((DEXSCREENER_LISTING_USD / solUsd) * LAMPORTS_PER_SOL));
}

async function main() {
  const { admin, launchAuthority, crank, treasury } = roles();
  const { connection, program, pdas } = connect(admin);
  const ray = raydium();
  console.log(`cluster ${cluster()} | program ${program.programId.toBase58()} | admin ${admin.publicKey.toBase58()}`);

  // ---- Preflight (fail closed) ----
  const prog = await connection.getAccountInfo(program.programId);
  if (!prog?.executable) throw new Error("Parabull program not deployed at the IDL address. Run `anchor deploy` (and `anchor keys sync` first).");
  const pd = await connection.getAccountInfo(pdas.programData());
  if (!pd) throw new Error("ProgramData not found (program must be upgradeable)");
  // UpgradeableLoaderState::ProgramData: u32 tag, u64 slot, Option<Pubkey> authority.
  const hasAuth = pd.data[12] === 1;
  const upgradeAuth = hasAuth ? new PublicKey(pd.data.subarray(13, 45)) : null;
  if (!upgradeAuth?.equals(admin.publicKey)) throw new Error(`upgrade authority is ${upgradeAuth?.toBase58() ?? "none"}, expected ADMIN_KEYPAIR`);

  for (const [label, key] of [["CPMM program", ray.cpmmProgram], ["Burn & Earn program", ray.lockProgram]] as const) {
    const acc = await connection.getAccountInfo(key);
    if (!acc?.executable) throw new Error(`${label} ${key.toBase58()} is not an executable program on ${cluster()}`);
  }
  const cfg = await connection.getAccountInfo(ray.ammConfig);
  if (!cfg?.owner.equals(ray.cpmmProgram)) {
    throw new Error(`AmmConfig ${ray.ammConfig.toBase58()} is owned by ${cfg?.owner.toBase58() ?? "nobody"}, not CPMM ${ray.cpmmProgram.toBase58()}`);
  }
  // AmmConfig layout: disc(8) bump(1) disable_create_pool(1) index u16 LE(2) trade_fee_rate u64 ... create_pool_fee u64 @36.
  const index = cfg.data.readUInt16LE(10);
  if (!ammConfigPda(ray.cpmmProgram, index).equals(ray.ammConfig)) {
    throw new Error(`AmmConfig ${ray.ammConfig.toBase58()} does not re-derive from its stored index ${index}`);
  }
  if (cfg.data[9] !== 0) throw new Error(`AmmConfig index ${index} has pool creation disabled`);
  const createPoolFee = cfg.data.readBigUInt64LE(36);
  console.log(`AmmConfig ok: index ${index}, trade_fee_rate=${cfg.data.readBigUInt64LE(12)} / 1e6, create_pool_fee=${createPoolFee} lamports`);

  // Curve + migration reserve must work with this cluster's Raydium fees.
  const curve = resolveCurve(process.env, cluster());
  const preview = graduationPreview(curve.params, curve.migrationReserveLamports);
  console.log(
    `curve ${curve.label}: graduates at ${Number(preview.raiseLamports) / 1e9} SOL raised, ` +
      `${Number(preview.marketCapLamports) / 1e9} SOL market cap; pool gets ${Number(preview.solToPool) / 1e9} SOL`,
  );
  if (!preview.priceCheckPasses) throw new Error("curve would fail the on-chain 5% opening-price check at migration");
  if (curve.migrationReserveLamports < createPoolFee + MIGRATION_RENT_ALLOWANCE_LAMPORTS) {
    throw new Error(`MIGRATION_RESERVE_LAMPORTS ${curve.migrationReserveLamports} < create_pool_fee ${createPoolFee} + rent allowance ${MIGRATION_RENT_ALLOWANCE_LAMPORTS}`);
  }

  const globalKey = pdas.global();
  if (await connection.getAccountInfo(globalKey)) {
    const g = await program.account.global.fetch(globalKey);
    console.log("Global already initialised:", JSON.stringify(g, (_, v) => (v instanceof PublicKey ? v.toBase58() : v?.toString?.() ?? v), 2));
    return;
  }

  let parabullMint = process.env.PARABULL_MINT ? new PublicKey(process.env.PARABULL_MINT) : null;
  if (!parabullMint) {
    if (cluster() === "mainnet-beta") throw new Error("set PARABULL_MINT on mainnet");
    parabullMint = await createMint(connection, admin, admin.publicKey, null, 6, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    console.log(`created test $PARABULL mint (Token-2022): ${parabullMint.toBase58()}`);
  }

  const solUsd = Number(process.env.SOL_USD ?? "150");
  const params = {
    launchAuthority: launchAuthority.publicKey,
    crankAuthority: crank.publicKey,
    treasury,
    parabullMint,
    launchFeeLamports: bn(DEFAULTS.launchFeeLamports),
    ticketDepositLamports: bn(DEFAULTS.ticketDepositLamports),
    ticketTtlSeconds: bn(DEFAULTS.ticketTtlSeconds),
    platformFeeBps: DEFAULTS.platformFeeBps,
    buybackBps: DEFAULTS.buybackBps,
    holderBps: DEFAULTS.holderBps,
    dexTargetLamports: bn(dexTargetLamports(solUsd)),
    tradingOpenDelaySlots: bn(DEFAULTS.tradingOpenDelaySlots),
    registryLockSeconds: bn(DEFAULTS.registryLockSeconds),
    initialVirtualTokenReserves: bn(curve.params.initialVirtualTokenReserves),
    initialVirtualSolReserves: bn(curve.params.initialVirtualSolReserves),
    initialRealTokenReserves: bn(curve.params.initialRealTokenReserves),
    tokenTotalSupply: bn(curve.params.tokenTotalSupply),
    cpmmProgram: ray.cpmmProgram,
    cpmmAmmConfig: ray.ammConfig,
    lpLockProgram: ray.lockProgram,
    lpLockAuthority: ray.lockAuthority,
    migrationReserveLamports: bn(curve.migrationReserveLamports),
    parabullPool: PublicKey.default, // set later via update_global_params once the pool exists
    rewardClaimWindowSeconds: bn(DEFAULTS.rewardClaimWindowSeconds),
  };

  const sig = await program.methods
    .initialize(params)
    .accountsStrict({
      admin: admin.publicKey,
      global: globalKey,
      buybackVault: pdas.buybackVault(),
      holderVault: pdas.holderVault(),
      program: program.programId,
      programData: pdas.programData(),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`initialised Global ${globalKey.toBase58()} (dex target ${params.dexTargetLamports} lamports @ $${solUsd}/SOL): ${sig}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

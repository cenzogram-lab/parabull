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
 */
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createMint } from "@solana/spl-token";
import { DEXSCREENER_LISTING_USD, LAMPORTS_PER_SOL, cluster, raydium, roles } from "./src/config";
import { bn, connect } from "./src/program";

const DEFAULTS = {
  launchFeeLamports: 200_000_000n,
  ticketDepositLamports: 230_000_000n,
  ticketTtlSeconds: 10 * 60,
  platformFeeBps: 100,
  buybackBps: 5_000,
  holderBps: 4_000,
  tradingOpenDelaySlots: 2,
  registryLockSeconds: 3 * 24 * 60 * 60,
  initialVirtualTokenReserves: 1_073_000_000_000_000n,
  initialVirtualSolReserves: 30_000_000_000n,
  initialRealTokenReserves: 793_100_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  migrationReserveLamports: 250_000_000n,
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
  if (!ray.ammConfig) throw new Error("set RAYDIUM_AMM_CONFIG");
  const cfg = await connection.getAccountInfo(ray.ammConfig);
  if (!cfg?.owner.equals(ray.cpmmProgram)) {
    throw new Error(`AmmConfig ${ray.ammConfig.toBase58()} is owned by ${cfg?.owner.toBase58() ?? "nobody"}, not CPMM ${ray.cpmmProgram.toBase58()}`);
  }
  console.log(`AmmConfig ok: trade_fee_rate=${cfg.data.readBigUInt64LE(12)} / 1e6, create_pool_fee=${cfg.data.readBigUInt64LE(36)} lamports`);

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
    initialVirtualTokenReserves: bn(DEFAULTS.initialVirtualTokenReserves),
    initialVirtualSolReserves: bn(DEFAULTS.initialVirtualSolReserves),
    initialRealTokenReserves: bn(DEFAULTS.initialRealTokenReserves),
    tokenTotalSupply: bn(DEFAULTS.tokenTotalSupply),
    cpmmProgram: ray.cpmmProgram,
    cpmmAmmConfig: ray.ammConfig,
    lpLockProgram: ray.lockProgram,
    lpLockAuthority: ray.lockAuthority,
    migrationReserveLamports: bn(DEFAULTS.migrationReserveLamports),
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

/**
 * Devnet smoke test of the launch + trading path:
 *   request_launch (user pays the ticket) -> create (launch authority + fresh
 *   mint keypair) -> a buy inside the slot delay (expect TradingNotOpenYet) ->
 *   wait for trading_open_slot -> buy -> sell, with slippage from src/curve.ts.
 *
 *   CLUSTER=devnet npm run smoke
 *   CLUSTER=devnet npm run smoke -- --no-create   # the launch worker creates it
 *   CLUSTER=devnet GRADUATE=1 npm run smoke       # then buy out + graduate
 *
 * --no-create: stop after request_launch and wait for the ticket to close.
 *   Run `npm run worker` alongside (with SKIP_METADATA_FETCH=1, or SMOKE_URI
 *   pointing at real metadata JSON with a reachable image). Reports the
 *   worker's delay on the on-chain clock; fails if the worker refunded.
 * GRADUATE=1: after the trades, buy every remaining token (completing the
 *   curve), run prepare_migration -> migrate_raydium -> lock_migrated_lp as
 *   the crank would, and check the pool and the LP lock. Needs a small curve
 *   (deploy:init with CURVE_PRESET=small); refused on mainnet-beta.
 *
 * Env: ADMIN_KEYPAIR (funds the test user and pays fees), LAUNCH_AUTHORITY_KEYPAIR,
 * CRANK_KEYPAIR, TWEET (optional announcement tweet URL or status ID; locked
 * for 3 days), SMOKE_URI, GRADUATE, GRADUATE_MAX_SOL (default 5).
 */
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { cluster, raydium, roles } from "./src/config";
import { applySlippage, quoteBuyExactTokens, quoteSell } from "./src/curve";
import { STAGE, graduate } from "./src/graduation";
import { canonicalTicker, nameHash, parseTweetId, tweetIdHash } from "./src/launch";
import { Pdas, ata2022, cpmmPoolAccounts, lockAccounts } from "./src/pdas";
import { anchorErrorName, big, bn, connect, isDefault, send } from "./src/program";
import { graduationBuy, smokeOptions, workerLaunchedMint } from "./src/smoke";

const SLIPPAGE_BPS = 200n;
const TOKENS = 10_000_000_000_000n; // 10M tokens (6 decimals)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tradeAccountsFor(pdas: Pdas, mint: PublicKey, buyer: PublicKey) {
  const curve = pdas.bondingCurve(mint);
  return {
    user: buyer,
    global: pdas.global(),
    mint,
    bondingCurve: curve,
    curveTokenAccount: ata2022(mint, curve),
    userTokenAccount: ata2022(mint, buyer),
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

async function main() {
  const opts = smokeOptions(process.argv.slice(2), process.env, cluster());
  const { admin, launchAuthority, crank } = roles();
  const x = connect(admin);
  const { connection, program, pdas } = x;
  const global = await program.account.global.fetch(pdas.global());
  const feeBps = BigInt(global.platformFeeBps);
  const fund = async (to: PublicKey, lamports: bigint) =>
    sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: to, lamports })), [admin]);

  // A throwaway user funded by the admin (devnet faucets are rate-limited).
  const user = Keypair.generate();
  await fund(user.publicKey, BigInt(1.5 * LAMPORTS_PER_SOL));

  // ---- 1. request_launch ----
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[^A-Z0-9]/g, "X");
  const symbol = canonicalTicker(`PB${suffix}`);
  const name = `Parabull Smoke ${suffix}`;
  const uri = process.env.SMOKE_URI ?? "https://example.com/parabull-smoke.json";
  const nonce = BigInt(Date.now());
  const ticket = pdas.ticket(user.publicKey, nonce);
  const tweetId = process.env.TWEET ? parseTweetId(process.env.TWEET) : null;
  const requestSig = await program.methods
    .requestLaunch(bn(nonce), name, symbol, uri, tweetId === null ? null : bn(tweetId))
    .accountsStrict({ payer: user.publicKey, global: pdas.global(), ticket, systemProgram: SystemProgram.programId })
    .signers([user])
    .rpc();
  console.log(`ticket ${ticket.toBase58()} for $${symbol}`);

  // ---- 2. create: here, or by the launch worker with --no-create ----
  let mint: PublicKey;
  if (opts.create) {
    const mintKp = Keypair.generate();
    const curve = pdas.bondingCurve(mintKp.publicKey);
    const createIx = await program.methods
      .create(name, symbol, uri)
      .accountsStrict({
        launchAuthority: launchAuthority.publicKey,
        global: pdas.global(),
        ticket,
        payer: user.publicKey,
        treasury: global.treasury,
        mint: mintKp.publicKey,
        mintAuthority: pdas.mintAuthority(),
        bondingCurve: curve,
        curveTokenAccount: ata2022(mintKp.publicKey, curve),
        tickerRegistry: pdas.tickerRegistry(symbol),
        nameRegistry: pdas.nameRegistry(nameHash(name)),
        tweetRegistry: tweetId === null ? null : pdas.tweetRegistry(tweetIdHash(tweetId)),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    await send(connection, [createIx], [admin, launchAuthority, mintKp].filter((k, i, a) => a.findIndex((y) => y.publicKey.equals(k.publicKey)) === i));
    mint = mintKp.publicKey;
  } else {
    mint = await waitForWorker(x, ticket, symbol, requestSig);
  }
  const curve = pdas.bondingCurve(mint);
  let c = await program.account.bondingCurve.fetch(curve);
  console.log(`created mint ${mint.toBase58()} at slot ${c.createdSlot}, trading opens at ${c.tradingOpenSlot}`);

  const tradeAccounts = (buyer: PublicKey) => tradeAccountsFor(pdas, mint, buyer);
  const reserves = () => ({ virtualToken: big(c.virtualTokenReserves), virtualSol: big(c.virtualSolReserves), realToken: big(c.realTokenReserves), realSol: big(c.realSolReserves) });

  // ---- 3. buy inside the slot delay: expected to be rejected ----
  if ((await connection.getSlot("confirmed")) < big(c.tradingOpenSlot)) {
    try {
      await program.methods.buy(bn(TOKENS), bn(10n ** 12n)).accountsStrict(tradeAccounts(user.publicKey)).signers([user]).rpc();
      console.log("WARNING: early buy landed (slot advanced past the delay before it executed)");
    } catch (e) {
      console.log(`early buy rejected as expected: ${anchorErrorName(e) ?? e}`);
    }
  }

  // ---- 4. wait for the open slot, then buy and sell ----
  while ((await connection.getSlot("confirmed")) < big(c.tradingOpenSlot)) await sleep(400);
  c = await program.account.bondingCurve.fetch(curve);
  const q = quoteBuyExactTokens(reserves(), TOKENS, feeBps);
  const maxCost = applySlippage(q.total, SLIPPAGE_BPS, true);
  await program.methods.buy(bn(TOKENS), bn(maxCost)).accountsStrict(tradeAccounts(user.publicKey)).signers([user]).rpc();
  console.log(`bought ${q.tokensOut} for ~${q.total} lamports (max ${maxCost})`);

  c = await program.account.bondingCurve.fetch(curve);
  const sellAmt = TOKENS / 2n;
  const s = quoteSell(reserves(), sellAmt, feeBps);
  const minOut = applySlippage(s.solNet, SLIPPAGE_BPS, false);
  await program.methods.sell(bn(sellAmt), bn(minOut)).accountsStrict(tradeAccounts(user.publicKey)).signers([user]).rpc();
  console.log(`sold ${sellAmt} for ~${s.solNet} lamports (min ${minOut})`);

  c = await program.account.bondingCurve.fetch(curve);
  console.log("curve after trades:", {
    realSol: c.realSolReserves.toString(),
    escrow: c.escrowAccrued.toString(),
    buyback: c.buybackAccrued.toString(),
    holder: c.holderAccrued.toString(),
    treasury: c.treasuryAccrued.toString(),
  });

  if (opts.graduate) await buyOutAndGraduate(x, crank, mint, curve, feeBps, opts.maxGraduateLamports, user, fund);
}

/** --no-create: wait for the worker to consume the ticket, then find its mint via the ticker registry. */
async function waitForWorker(x: ReturnType<typeof connect>, ticket: PublicKey, symbol: string, requestSig: string): Promise<PublicKey> {
  const { connection, program, pdas } = x;
  const t = await program.account.launchTicket.fetch(ticket);
  const deadline = Number(big(t.expiresAt)) * 1000 + 5_000; // ms, a little past the ticket's expiry
  const requestedAt = BigInt((await connection.getTransaction(requestSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))?.blockTime ?? 0);
  console.log(`waiting for the launch worker (ticket expires ${new Date(Number(big(t.expiresAt)) * 1000).toISOString()})`);
  while (await program.account.launchTicket.fetchNullable(ticket)) {
    if (Date.now() > deadline) throw new Error("ticket expired with no create: is `npm run worker` running against this cluster and program?");
    await sleep(1_000);
  }
  const r = await program.account.tickerRegistry.fetchNullable(pdas.tickerRegistry(symbol));
  const mint = workerLaunchedMint(r && { mint: r.mint, launchTimestamp: big(r.launchTimestamp) }, requestedAt);
  if (!mint) throw new Error("ticket closed without a launch: the worker refunded it (see its log; use SKIP_METADATA_FETCH=1 or a real SMOKE_URI)");
  const delay = Number(big(r!.launchTimestamp) - requestedAt);
  console.log(`worker created the coin ${delay}s after request_launch (on-chain clock; expect about 3-15s plus confirmation time)`);
  return mint;
}

/** GRADUATE=1: one buy for every remaining token, then the crank's graduation steps, then checks. */
async function buyOutAndGraduate(
  x: ReturnType<typeof connect>,
  crank: Keypair,
  mint: PublicKey,
  curve: PublicKey,
  feeBps: bigint,
  maxLamports: bigint,
  user: Keypair,
  fund: (to: PublicKey, lamports: bigint) => Promise<string>,
) {
  const { connection, program, pdas } = x;
  const tradeAccounts = (buyer: PublicKey) => tradeAccountsFor(pdas, mint, buyer);
  let c = await program.account.bondingCurve.fetch(curve);
  const r = { virtualToken: big(c.virtualTokenReserves), virtualSol: big(c.virtualSolReserves), realToken: big(c.realTokenReserves), realSol: big(c.realSolReserves) };
  const b = graduationBuy(r, feeBps, SLIPPAGE_BPS, maxLamports);
  const balance = BigInt(await connection.getBalance(user.publicKey, "confirmed"));
  const need = b.maxCost + 50_000_000n; // headroom for fees and rent
  if (balance < need) await fund(user.publicKey, need - balance);
  await program.methods.buy(bn(b.tokens), bn(b.maxCost)).accountsStrict(tradeAccounts(user.publicKey)).signers([user]).rpc();
  c = await program.account.bondingCurve.fetch(curve);
  if (!c.complete) throw new Error("buy-out landed but the curve isn't complete");
  console.log(`bought out the curve: ${b.tokens} tokens for ~${b.total} lamports; real SOL ${c.realSolReserves}`);

  try {
    await program.methods.buy(bn(1_000_000n), bn(10n ** 12n)).accountsStrict(tradeAccounts(user.publicKey)).signers([user]).rpc();
    throw new Error("a buy on a complete curve landed");
  } catch (e) {
    const name = anchorErrorName(e);
    if (name !== "CurveComplete") throw e;
    console.log("buy after completion rejected as expected: CurveComplete");
  }

  const crankX = { ...connect(crank), crank, ray: raydium() };
  await graduate(crankX, mint, curve, c.migrationStage, (m) => console.log(m));

  c = await program.account.bondingCurve.fetch(curve);
  const g = await program.account.global.fetch(pdas.global());
  if (c.migrationStage !== STAGE.LpLocked || !c.migrated) throw new Error(`graduation stopped at stage ${c.migrationStage}`);
  if (isDefault(c.raydiumPool) || isDefault(c.feeNftMint)) throw new Error("curve has no pool or fee NFT recorded");
  const pool = await connection.getAccountInfo(c.raydiumPool, "confirmed");
  if (!pool?.owner.equals(g.cpmmProgram)) throw new Error(`pool ${c.raydiumPool.toBase58()} isn't owned by the CPMM program`);
  const k = cpmmPoolAccounts(g.cpmmProgram, c.raydiumPool, mint, pdas.migrationAuthority(mint));
  const l = lockAccounts(g.lpLockProgram, g.lpLockAuthority, c.feeNftMint, pdas.feeKeyVault(), k.lpMint);
  const amount = (a: PublicKey) => connection.getTokenAccountBalance(a, "confirmed").then((v) => BigInt(v.value.amount)).catch(() => 0n);
  const [locked, unlocked, v0, v1] = await Promise.all([amount(l.lockLpVault), amount(k.creatorLpToken), amount(k.token0Vault), amount(k.token1Vault)]);
  if (locked === 0n) throw new Error("no LP in the Burn & Earn lock vault");
  if (unlocked !== 0n) throw new Error(`${unlocked} LP left unlocked in the migration authority's account`);
  console.log("graduated:", {
    pool: c.raydiumPool.toBase58(),
    lpMint: k.lpMint.toBase58(),
    lockedLp: locked.toString(),
    vault0: v0.toString(),
    vault1: v1.toString(),
    feeNft: c.feeNftMint.toBase58(),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

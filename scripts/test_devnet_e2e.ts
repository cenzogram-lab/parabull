/**
 * Devnet end-to-end lifecycle test: the pre-deployment check that the deployed
 * program, the launch worker and the curve math agree, exactly, on real
 * transactions.
 *
 *   1. request_launch: a throwaway wallet (funded by the admin) opens a ticket.
 *   2. Launch worker: `src/launchWorkerRunner.ts` (the code `npm run worker`
 *      runs) recovers the request, validates it, waits its CSPRNG 3-15 s and
 *      sends `create`.
 *   3. Buy: once trading opens, a buy spending 0.230 SOL (fee included).
 *   4. Partial sell: half the tokens back to the curve.
 *   5. Optional: services/parabull-indexer serves the coin, both trades and the
 *      wallet's remaining position (E2E_INDEXER_URL).
 *
 * Every step checks the on-chain result against the local quote, to the
 * lamport: balance changes from transaction metadata, curve reserves and fee
 * buckets, token balances, Token-2022 metadata and authorities, and the
 * emitted events. The first mismatch stops the run with exit code 1. At the end
 * the wallet's remaining SOL goes back to the admin (E2E_KEEP_FUNDS=1 keeps it).
 *
 *   CLUSTER=devnet npm run e2e:devnet
 *   CLUSTER=devnet E2E_INDEXER_URL=http://127.0.0.1:8790 npm run e2e:devnet
 *
 * Needs ADMIN_KEYPAIR, which funds the test wallet with about 0.5 SOL and
 * gets back what's left at the end. A run spends about 0.35 SOL: the 0.2 SOL
 * launch fee (to the treasury), about 0.12 SOL left in the curve by the unsold
 * half and the fees, rent and network fees. Also needs the launch authority's
 * key (LAUNCH_AUTHORITY_KEYPAIR, the admin by default on devnet).
 * Stop any running `npm run worker` against the same program first, or the two
 * race for the ticket (the test then fails with "closed").
 *
 * Env: E2E_BUY_SOL (0.230), E2E_SELL_BPS (5000), E2E_SLIPPAGE_BPS (200),
 * E2E_URI (real metadata JSON; the worker then fetches it and its image),
 * E2E_INDEXER_URL, E2E_KEEP_FUNDS=1. Refused on mainnet-beta.
 */
import { BorshCoder } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransactionResponse, sendAndConfirmTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount, getMint, getTokenMetadata } from "@solana/spl-token";
import { cluster, roles } from "./src/config";
import { Reserves, applySlippage, quoteSell } from "./src/curve";
import { Checks, CheckFailed, e2eOptions, eventsIn, field, fundingFor, lamportDelta, oneEvent, partialSellAmount, tokensForBudget, u64 } from "./src/e2e";
import { canonicalTicker, metadataCommitment, nameHash } from "./src/launch";
import { DELAY_MAX_MS, DELAY_MIN_MS } from "./src/launchWorker";
import { createLaunchWorker } from "./src/launchWorkerRunner";
import { ata2022 } from "./src/pdas";
import { big, bn, connect } from "./src/program";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sol = (l: bigint) => `${(Number(l) / 1e9).toFixed(9)} SOL`;
const step = (s: string) => console.log(`\n== ${s}`);

async function main() {
  const opts = e2eOptions(process.env, cluster());
  const { admin, launchAuthority } = roles();
  const { connection, program, pdas } = connect(admin);
  const coder = program.coder as BorshCoder;
  const c = new Checks((l) => console.log(l));
  const started = Date.now();

  /** A confirmed transaction with metadata (some RPCs need a moment after confirmation). */
  const txOf = async (sig: string): Promise<VersionedTransactionResponse> => {
    for (let i = 0; i < 20; i++) {
      const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx?.meta) return tx;
      await sleep(500);
    }
    throw new Error(`transaction ${sig} not found`);
  };
  const tokenBalance = (account: PublicKey) => getAccount(connection, account, "confirmed", TOKEN_2022_PROGRAM_ID).then((a) => a.amount);

  step(`preflight on ${cluster()} (program ${program.programId.toBase58()})`);
  const programAccount = await connection.getAccountInfo(program.programId, "confirmed");
  c.ok("program is deployed and executable", programAccount?.executable);
  const g = await program.account.global.fetchNullable(pdas.global());
  c.ok("Global is initialised", g, "run `npm run deploy:init` first");
  c.ok("program is not paused", !g!.paused);
  c.eq("platform fee is 1% (100 bps)", g!.platformFeeBps, 100);
  c.eq("LAUNCH_AUTHORITY_KEYPAIR is Global.launch_authority", launchAuthority.publicKey, g!.launchAuthority);
  const feeBps = BigInt(g!.platformFeeBps);
  const deposit = big(g!.ticketDepositLamports);
  const funding = fundingFor(deposit, opts.buyLamports, opts.slippageBps);
  const adminBalance = BigInt(await connection.getBalance(admin.publicKey, "confirmed"));
  c.ok(`admin can fund the test wallet (${sol(funding)})`, adminBalance > funding + 10_000_000n, `admin has ${sol(adminBalance)}`);

  const user = Keypair.generate();
  const ux = connect(user); // the test wallet pays its own transaction fees
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: funding })),
    [admin],
    { commitment: "confirmed" },
  );
  console.log(`test wallet ${user.publicKey.toBase58()} funded with ${sol(funding)}`);

  try {
    // ---------------------------------------------------------------- 1
    step("1. request_launch");
    const suffix = Date.now().toString(36).slice(-5).toUpperCase();
    const symbol = canonicalTicker(`E2E${suffix}`);
    const name = `Parabull E2E ${suffix}`;
    const uri = opts.uri ?? `https://example.com/parabull-e2e-${suffix.toLowerCase()}.json`;
    const nonce = BigInt(Date.now());
    const ticket = pdas.ticket(user.publicKey, nonce);
    const requestSig = await ux.program.methods
      .requestLaunch(bn(nonce), name, symbol, uri, null)
      .accountsStrict({ payer: user.publicKey, global: pdas.global(), ticket, systemProgram: SystemProgram.programId })
      .rpc();
    const requestTx = await txOf(requestSig);
    console.log(`ticket ${ticket.toBase58()} for $${symbol} (${requestSig})`);
    c.eq("wallet paid exactly the ticket deposit plus the network fee", -lamportDelta(requestTx, user.publicKey), deposit + BigInt(requestTx.meta!.fee));
    c.eq("ticket holds exactly the deposit", BigInt(await connection.getBalance(ticket, "confirmed")), deposit);
    const t = await program.account.launchTicket.fetch(ticket);
    c.eq("ticket payer", t.payer, user.publicKey);
    c.eq("ticket deposit", big(t.depositLamports), deposit);
    c.eq("ticket launch fee", big(t.launchFeeLamports), big(g!.launchFeeLamports));
    c.eq("ticket ttl", big(t.expiresAt) - big(t.createdAt), big(g!.ticketTtlSeconds));
    c.ok("ticket commits to the metadata", Buffer.from(t.metadataHash).equals(metadataCommitment(name, symbol, uri)));
    c.ok("ticket commits to the name lock", Buffer.from(t.nameHash).equals(nameHash(name)));
    const requested = oneEvent(eventsIn(requestTx.meta!.logMessages, program.programId, coder), "LaunchRequested");
    c.eq("LaunchRequested.ticket", field(requested, "ticket"), ticket);
    c.eq("LaunchRequested.payer", field(requested, "payer"), user.publicKey);
    c.eq("LaunchRequested.nonce", u64(field(requested, "nonce")), nonce);
    c.eq("LaunchRequested.ticker", field(requested, "ticker"), symbol);

    // ---------------------------------------------------------------- 2
    step("2. launch worker creates the bonding curve");
    const lx = connect(launchAuthority);
    const worker = createLaunchWorker({
      connection: lx.connection,
      program: lx.program,
      pdas: lx.pdas,
      launchAuthority,
      skipMetadataFetch: opts.uri === null,
      xBearerToken: process.env.X_BEARER_TOKEN,
      log: (...a) => console.log("  worker:", ...a),
    });
    const outcome = await worker.handle(ticket, requestSig);
    if (outcome.kind !== "created") throw new CheckFailed(`FAIL launch worker created the coin: got ${JSON.stringify({ ...outcome, ticket: ticket.toBase58() })}`);
    c.ok("launch worker created the coin", true);
    c.ok(`worker waited ${outcome.delayMs} ms, inside ${DELAY_MIN_MS}-${DELAY_MAX_MS} ms`, outcome.delayMs >= DELAY_MIN_MS && outcome.delayMs <= DELAY_MAX_MS);
    const mint = outcome.mint;
    const curve = pdas.bondingCurve(mint);
    const curveAta = ata2022(mint, curve);
    const createSig = outcome.signature ?? (await connection.getSignaturesForAddress(curve, { limit: 1000 }, "confirmed")).at(-1)!.signature;
    const createTx = await txOf(createSig);
    console.log(`mint ${mint.toBase58()} (${createSig})`);
    c.ok("ticket is closed", !(await connection.getAccountInfo(ticket, "confirmed")));
    let cv = await program.account.bondingCurve.fetch(curve);
    c.eq("curve creator is the ticket payer", cv.creator, user.publicKey);
    c.eq("curve mint", cv.mint, mint);
    c.eq("virtual token reserves start at Global's", big(cv.virtualTokenReserves), big(g!.initialVirtualTokenReserves));
    c.eq("virtual SOL reserves start at Global's", big(cv.virtualSolReserves), big(g!.initialVirtualSolReserves));
    c.eq("real token reserves start at Global's", big(cv.realTokenReserves), big(g!.initialRealTokenReserves));
    c.eq("real SOL reserves start at 0", big(cv.realSolReserves), 0n);
    c.eq("trading opens after the slot delay", big(cv.tradingOpenSlot) - big(cv.createdSlot), big(g!.tradingOpenDelaySlots));
    c.ok("curve is trading (not complete or migrated)", !cv.complete && !cv.migrated);
    const supply = big(g!.tokenTotalSupply);
    const m = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    c.eq("whole supply is minted", m.supply, supply);
    c.ok("mint authority is revoked", m.mintAuthority === null);
    c.ok("no freeze authority", m.freezeAuthority === null);
    c.eq("curve's token account holds the whole supply", await tokenBalance(curveAta), supply);
    const meta = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    c.eq("Token-2022 metadata name", meta?.name, name);
    c.eq("Token-2022 metadata symbol", meta?.symbol, symbol);
    c.eq("Token-2022 metadata uri", meta?.uri, uri);
    const reg = await program.account.tickerRegistry.fetch(pdas.tickerRegistry(symbol));
    c.eq("ticker registry points at the new mint", reg.mint, mint);
    const created = oneEvent(eventsIn(createTx.meta!.logMessages, program.programId, coder), "TokenCreated");
    c.eq("TokenCreated.mint", field(created, "mint"), mint);
    c.eq("TokenCreated.ticket", field(created, "ticket"), ticket);
    c.eq("TokenCreated.creator", field(created, "creator"), user.publicKey);
    const reimbursed = u64(field(created, "rentReimbursed"));
    const toTreasury = u64(field(created, "treasuryReceived"));
    c.eq("deposit is settled in full (rent back to the launch authority + the rest to the treasury)", reimbursed + toTreasury, deposit);
    c.ok("treasury receives at least the launch fee", toTreasury >= big(g!.launchFeeLamports));
    if (!g!.treasury.equals(launchAuthority.publicKey)) {
      c.eq("treasury balance rose by treasury_received", lamportDelta(createTx, g!.treasury), toTreasury);
    } else {
      console.log("  (treasury is the launch authority here, so its balance check is skipped)");
    }
    const delaySeconds = big(cv.launchTimestamp) - big(t.createdAt);
    console.log(`  on-chain clock: created ${delaySeconds}s after request_launch`);

    // ---------------------------------------------------------------- 3
    step(`3. buy for ${sol(opts.buyLamports)} (fee included)`);
    const openSlot = big(cv.tradingOpenSlot);
    const deadline = Date.now() + 120_000;
    while (BigInt(await connection.getSlot("confirmed")) < openSlot) {
      if (Date.now() > deadline) throw new Error(`trading didn't open by slot ${openSlot} within 2 minutes`);
      await sleep(400);
    }
    cv = await program.account.bondingCurve.fetch(curve);
    const reserves = (): Reserves => ({
      virtualToken: big(cv.virtualTokenReserves),
      virtualSol: big(cv.virtualSolReserves),
      realToken: big(cv.realTokenReserves),
      realSol: big(cv.realSolReserves),
    });
    const buckets = () => ({ escrow: big(cv.escrowAccrued), buyback: big(cv.buybackAccrued), holder: big(cv.holderAccrued), treasury: big(cv.treasuryAccrued) });
    const trade = {
      user: user.publicKey,
      global: pdas.global(),
      mint,
      bondingCurve: curve,
      curveTokenAccount: curveAta,
      userTokenAccount: ata2022(mint, user.publicKey),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };

    const r0 = reserves();
    const b0 = buckets();
    const q = tokensForBudget(r0, opts.buyLamports, feeBps);
    const maxCost = applySlippage(q.total, opts.slippageBps, true);
    console.log(`  quote: ${q.tokensOut} token units for ${sol(q.solCost)} + ${sol(q.fee)} fee = ${sol(q.total)} (ceiling ${sol(maxCost)})`);
    c.ok("quote spends the whole budget (to within 0.00001 SOL) and no more", q.total <= opts.buyLamports && opts.buyLamports - q.total <= 10_000n);
    const buySig = await ux.program.methods.buy(bn(q.tokensOut), bn(maxCost)).accountsStrict(trade).rpc();
    const buyTx = await txOf(buySig);
    console.log(`  buy ${buySig}`);
    cv = await program.account.bondingCurve.fetch(curve);
    const r1 = reserves();
    const b1 = buckets();
    const ataRent = lamportDelta(buyTx, trade.userTokenAccount);
    c.eq("wallet paid cost + fee + its token account's rent + the network fee", -lamportDelta(buyTx, user.publicKey), q.total + ataRent + BigInt(buyTx.meta!.fee));
    c.eq("curve account received cost + fee", lamportDelta(buyTx, curve), q.total);
    c.eq("wallet holds the tokens bought", await tokenBalance(trade.userTokenAccount), q.tokensOut);
    c.eq("curve's token account paid them out", await tokenBalance(curveAta), supply - q.tokensOut);
    c.eq("virtual token reserves after the buy", r1.virtualToken, r0.virtualToken - q.tokensOut);
    c.eq("virtual SOL reserves after the buy", r1.virtualSol, r0.virtualSol + q.solCost);
    c.eq("real token reserves after the buy", r1.realToken, r0.realToken - q.tokensOut);
    c.eq("real SOL reserves after the buy", r1.realSol, r0.realSol + q.solCost);
    const buyFeeIn = b1.escrow + b1.buyback + b1.holder + b1.treasury - (b0.escrow + b0.buyback + b0.holder + b0.treasury);
    c.eq("fee buckets grew by exactly the 1% fee", buyFeeIn, q.fee);
    c.ok("curve still trading after the buy", !cv.complete);
    const buyEv = oneEvent(eventsIn(buyTx.meta!.logMessages, program.programId, coder), "TradeEvent");
    c.eq("TradeEvent(buy).isBuy", field(buyEv, "isBuy"), true);
    c.eq("TradeEvent(buy).user", field(buyEv, "user"), user.publicKey);
    c.eq("TradeEvent(buy).tokenAmount", u64(field(buyEv, "tokenAmount")), q.tokensOut);
    c.eq("TradeEvent(buy).solAmount (cost before fee)", u64(field(buyEv, "solAmount")), q.solCost);
    c.eq("TradeEvent(buy).fee", u64(field(buyEv, "fee")), q.fee);
    c.eq("TradeEvent(buy) fee split matches the buckets", [b1.escrow - b0.escrow, b1.buyback - b0.buyback, b1.holder - b0.holder, b1.treasury - b0.treasury].join(), ["feeToEscrow", "feeToBuyback", "feeToHolders", "feeToTreasury"].map((k) => u64(field(buyEv, k))).join());
    c.eq("TradeEvent(buy) reserves match the curve", u64(field(buyEv, "realSolReserves")), r1.realSol);

    // ---------------------------------------------------------------- 4
    const sellAmt = partialSellAmount(q.tokensOut, opts.sellBps);
    step(`4. partial sell of ${sellAmt} of ${q.tokensOut} token units`);
    const s = quoteSell(r1, sellAmt, feeBps);
    const minOut = applySlippage(s.solNet, opts.slippageBps, false);
    console.log(`  quote: ${sol(s.solGross)} - ${sol(s.fee)} fee = ${sol(s.solNet)} (floor ${sol(minOut)})`);
    const sellSig = await ux.program.methods.sell(bn(sellAmt), bn(minOut)).accountsStrict(trade).rpc();
    const sellTx = await txOf(sellSig);
    console.log(`  sell ${sellSig}`);
    cv = await program.account.bondingCurve.fetch(curve);
    const r2 = reserves();
    const b2 = buckets();
    c.eq("wallet received the net payout less the network fee", lamportDelta(sellTx, user.publicKey), s.solNet - BigInt(sellTx.meta!.fee));
    c.eq("curve account paid out only the net", lamportDelta(sellTx, curve), -s.solNet);
    const held = await tokenBalance(trade.userTokenAccount);
    c.eq("wallet keeps the unsold tokens", held, q.tokensOut - sellAmt);
    c.ok("the sell was partial", held > 0n && held < q.tokensOut);
    c.eq("curve's token account took the tokens back", await tokenBalance(curveAta), supply - q.tokensOut + sellAmt);
    c.eq("virtual token reserves after the sell", r2.virtualToken, r1.virtualToken + sellAmt);
    c.eq("virtual SOL reserves after the sell", r2.virtualSol, r1.virtualSol - s.solGross);
    c.eq("real token reserves after the sell", r2.realToken, r1.realToken + sellAmt);
    c.eq("real SOL reserves after the sell", r2.realSol, r1.realSol - s.solGross);
    const sellFeeIn = b2.escrow + b2.buyback + b2.holder + b2.treasury - (b1.escrow + b1.buyback + b1.holder + b1.treasury);
    c.eq("fee buckets grew by exactly the sell's 1% fee", sellFeeIn, s.fee);
    const sellEv = oneEvent(eventsIn(sellTx.meta!.logMessages, program.programId, coder), "TradeEvent");
    c.eq("TradeEvent(sell).isBuy", field(sellEv, "isBuy"), false);
    c.eq("TradeEvent(sell).tokenAmount", u64(field(sellEv, "tokenAmount")), sellAmt);
    c.eq("TradeEvent(sell).solAmount (gross)", u64(field(sellEv, "solAmount")), s.solGross);
    c.eq("TradeEvent(sell).fee", u64(field(sellEv, "fee")), s.fee);
    const curveLamports = BigInt(await connection.getBalance(curve, "confirmed"));
    const rent = BigInt(await connection.getMinimumBalanceForRentExemption((await connection.getAccountInfo(curve, "confirmed"))!.data.length));
    c.eq("curve lamports = rent + real SOL + fee buckets", curveLamports, rent + r2.realSol + b2.escrow + b2.buyback + b2.holder + b2.treasury);

    // ---------------------------------------------------------------- 5
    if (opts.indexerUrl) {
      step(`5. indexer at ${opts.indexerUrl}`);
      await checkIndexer(c, opts.indexerUrl, { mint, user: user.publicKey, buySig, sellSig, held, tokensOut: q.tokensOut, sellAmt });
    }

    console.log(`\nPASS: ${c.passed.length} checks in ${Math.round((Date.now() - started) / 1000)}s`);
    console.log(JSON.stringify({ cluster: cluster(), program: program.programId.toBase58(), ticket: ticket.toBase58(), mint: mint.toBase58(), symbol, wallet: user.publicKey.toBase58(), requestSig, createSig, buySig, sellSig, workerDelayMs: outcome.delayMs }));
  } finally {
    if (!opts.keepFunds) await returnFunds(connection, admin, user).catch((e) => console.log(`(couldn't return the test wallet's SOL: ${(e as Error).message})`));
  }
}

/** The indexer serves the coin, both trades and the wallet's remaining position (it polls, so allow a minute). */
async function checkIndexer(
  c: Checks,
  base: string,
  x: { mint: PublicKey; user: PublicKey; buySig: string; sellSig: string; held: bigint; tokensOut: bigint; sellAmt: bigint },
) {
  const get = async <T>(path: string): Promise<{ status: number; body: T | null }> => {
    const res = await fetch(base + path, { signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: (await res.json().catch(() => null)) as T | null };
  };
  type Trade = { signature: string; side: "buy" | "sell"; tokenAmount: string; user: string };
  const deadline = Date.now() + 60_000;
  let trades: Trade[] = [];
  for (;;) {
    const r = await get<{ trades: Trade[] }>(`/coins/${x.mint.toBase58()}/trades?limit=10`).catch(() => ({ status: 0, body: null }));
    trades = r.body?.trades ?? [];
    if (trades.some((t) => t.signature === x.sellSig) && trades.some((t) => t.signature === x.buySig)) break;
    if (Date.now() > deadline) break;
    await sleep(2_000);
  }
  const coin = await get<{ mint: string; status: string }>(`/coins/${x.mint.toBase58()}`);
  c.eq("indexer serves the coin", coin.status, 200);
  const buy = trades.find((t) => t.signature === x.buySig);
  const sell = trades.find((t) => t.signature === x.sellSig);
  c.ok("indexer has the buy", buy?.side === "buy" && BigInt(buy.tokenAmount) === x.tokensOut && buy.user === x.user.toBase58(), JSON.stringify(buy ?? null));
  c.ok("indexer has the sell", sell?.side === "sell" && BigInt(sell.tokenAmount) === x.sellAmt, JSON.stringify(sell ?? null));
  c.ok("indexer lists trades newest first", trades.findIndex((t) => t.signature === x.sellSig) < trades.findIndex((t) => t.signature === x.buySig));
  const p = await get<{ holdings: { mint: string; amount: string }[] }>(`/portfolio/${x.user.toBase58()}`);
  const h = p.body?.holdings.find((v) => v.mint === x.mint.toBase58());
  c.eq("indexer's portfolio shows the remaining position", h ? BigInt(h.amount) : -1n, x.held);
}

/** Send the test wallet's whole balance back to the admin (the admin pays the fee, so the wallet ends at 0). */
async function returnFunds(connection: ReturnType<typeof connect>["connection"], admin: Keypair, user: Keypair) {
  const lamports = await connection.getBalance(user.publicKey, "confirmed");
  if (lamports === 0) return;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: admin.publicKey, lamports }));
  tx.feePayer = admin.publicKey;
  await sendAndConfirmTransaction(connection, tx, [admin, user], { commitment: "confirmed" });
  console.log(`returned ${sol(BigInt(lamports))} to the admin`);
}

main().catch((e) => {
  console.error(e instanceof CheckFailed ? `\n${e.message}` : e);
  process.exit(1);
});

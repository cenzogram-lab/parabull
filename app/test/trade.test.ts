/**
 * The audit fixes' pure parts: the trade sender (priority fee, compute limit, error text, send-and-watch outcomes),
 * the re-quote guard, the fail-closed launch-lock check at cluster time, the launch attribution by payer, curve
 * progress as the indexer measures it, and the chat reconnect backoff.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { checkLocks, clockUnixTimestamp, launchedBy, lockBlocker, registryLock } from "../src/lib/launchLocks";
import { curveProgress, initialReserves, PROTOCOL } from "../src/lib/protocol";
import { applyBuy, quoteBuyWithSol, quoteSellTokens, requoteBuy, requoteSell } from "../src/lib/quote";
import { base58, computeUnitLimit, describeTxError, pickPriorityFee, priorityFeeLamports, sendAndConfirm, TxExpiredError, TxFailedError, TxUnconfirmedError, type ConfirmRpc } from "../src/lib/txSend";
import { progressOf } from "../src/mock/coins";
import idl from "../src/idl/parabull.json";

const IDL_ERRORS = (idl as { errors: { code: number; name: string; msg?: string }[] }).errors;

test("priority fee: the 75th percentile of recent fees, clamped; a fallback with no samples", () => {
  assert.equal(pickPriorityFee([]), 50_000);
  assert.equal(pickPriorityFee([0, 0, 0, 0]), 10_000, "an idle account still pays the floor");
  assert.equal(pickPriorityFee([100_000, 20_000, 300_000, 40_000]), 300_000);
  assert.equal(pickPriorityFee([90_000_000]), 2_000_000, "capped");
  assert.equal(pickPriorityFee([NaN, -5, 200_000]), 200_000, "bad samples ignored");
  assert.equal(priorityFeeLamports(200_000, 2_000_000), 400_000, "the cap costs at most 0.0004 SOL at 200k CU");
});

test("compute limit: the simulation's units plus 15% and 5k, within [50k, 1.4M]; 300k when unknown", () => {
  assert.equal(computeUnitLimit(100_000), 120_000);
  assert.equal(computeUnitLimit(1_000), 50_000);
  assert.equal(computeUnitLimit(2_000_000), 1_400_000);
  assert.equal(computeUnitLimit(undefined), 300_000);
  assert.equal(computeUnitLimit(0), 300_000);
});

test("transaction errors read as the program's own: logs first, then the IDL code", () => {
  const complete = IDL_ERRORS.find((e) => e.name === "CurveComplete")!;
  assert.ok(complete, "the IDL has CurveComplete");
  assert.equal(
    describeTxError({ InstructionError: [2, { Custom: 6026 }] }, ["Program log: AnchorError occurred. Error Code: SlippageExceeded. Error Number: 6026. Error Message: Slippage limit exceeded."], IDL_ERRORS),
    "Slippage limit exceeded (SlippageExceeded)",
  );
  assert.equal(describeTxError({ InstructionError: [2, { Custom: complete.code }] }, null, IDL_ERRORS), `${complete.msg ?? complete.name} (CurveComplete)`);
  assert.equal(describeTxError({ InstructionError: [0, { Custom: 1 }] }, [], IDL_ERRORS), "program error 1");
  assert.equal(describeTxError({ InstructionError: [0, "ComputationalBudgetExceeded"] }, [], IDL_ERRORS), "ComputationalBudgetExceeded");
});

/** A cluster that lands the transaction after `landAfterSends` sends, with blocks advancing one per status read. */
function fakeRpc(o: { landAfterSends?: number; err?: unknown; height?: number; statusThrows?: boolean; heightThrows?: boolean } = {}) {
  let sends = 0;
  let height = o.height ?? 100;
  const rpc: ConfirmRpc = {
    sendRaw: async () => (sends++, "sig1"),
    status: async () => {
      if (o.statusThrows) throw new Error("rpc down");
      height++;
      if (o.landAfterSends !== undefined && sends >= o.landAfterSends) return { err: o.err ?? null, confirmationStatus: "confirmed" };
      return null;
    },
    blockHeight: async () => {
      if (o.heightThrows) throw new Error("rpc down");
      return height;
    },
  };
  return { rpc, sends: () => sends };
}
const fast = (clock = { t: 0 }) => ({ pollMs: 1, rebroadcastMs: 0, sleep: async (ms: number) => void (clock.t += ms * 1000), now: () => clock.t });

test("send and watch: confirmed after rebroadcasts, never reported failed while it may land", async () => {
  const f = fakeRpc({ landAfterSends: 3 });
  assert.equal(await sendAndConfirm(f.rpc, new Uint8Array(1), "sig1", 1_000, fast()), "sig1");
  assert.ok(f.sends() >= 3, "rebroadcast until it landed");
});

test("send and watch: an on-chain error is a definite failure with the program's reason", async () => {
  const slip = IDL_ERRORS.find((e) => e.name === "SlippageExceeded")!.code;
  const f = fakeRpc({ landAfterSends: 1, err: { InstructionError: [2, { Custom: slip }] } });
  await assert.rejects(sendAndConfirm(f.rpc, new Uint8Array(1), "sig1", 1_000, { ...fast(), idlErrors: IDL_ERRORS }), (e: unknown) => e instanceof TxFailedError && e.signature === "sig1" && /SlippageExceeded/.test(e.message));
});

test("send and watch: past the blockhash's last valid height with no status, it expired (nothing spent)", async () => {
  const f = fakeRpc({ height: 100 });
  await assert.rejects(sendAndConfirm(f.rpc, new Uint8Array(1), "sig1", 110, fast()), (e: unknown) => e instanceof TxExpiredError && /Nothing was spent/.test((e as Error).message));
});

test("send and watch: when nothing can be read in time, it's unconfirmed, not failed", async () => {
  const f = fakeRpc({ statusThrows: true, heightThrows: true });
  await assert.rejects(sendAndConfirm(f.rpc, new Uint8Array(1), "sig1", 110, { ...fast(), maxWaitMs: 5_000 }), (e: unknown) => e instanceof TxUnconfirmedError && e.signature === "sig1");
});

test("send and watch: a send that errors is not a failure; the status decides (it may have been forwarded)", async () => {
  let statusReads = 0;
  const rpc: ConfirmRpc = {
    sendRaw: async () => {
      throw new Error("fetch failed");
    },
    status: async () => (++statusReads >= 2 ? { err: null, confirmationStatus: "confirmed" } : null),
    blockHeight: async () => 100,
  };
  assert.equal(await sendAndConfirm(rpc, new Uint8Array(1), "sigX", 1_000, fast()), "sigX");
});

test("send and watch: at expiry, a status that shows up on the second history check is still a landing", async () => {
  const history: boolean[] = [];
  let height = 100;
  const rpc: ConfirmRpc = {
    sendRaw: async () => "sigY",
    status: async (_s, h) => {
      history.push(!!h);
      // The status node lags: the transaction shows only on the second history search.
      return h && history.filter(Boolean).length >= 2 ? { err: null, confirmationStatus: "confirmed" } : null;
    },
    blockHeight: async () => (height += 50),
  };
  assert.equal(await sendAndConfirm(rpc, new Uint8Array(1), "sigY", 120, fast()), "sigY");
  assert.ok(history.includes(true), "the final checks search the whole history");
});

test("base58 matches web3.js for signatures and keys, leading zeros included", () => {
  for (const bytes of [Keypair.generate().publicKey.toBytes(), new Uint8Array(32), Uint8Array.from([0, 0, 7, ...new Uint8Array(29).fill(200)])]) {
    assert.equal(base58(bytes), new PublicKey(bytes).toBase58());
  }
});

test("re-quote: slippage is never applied twice; the shown limits are what gets sent at worst", () => {
  const r0 = initialReserves();
  const budget = 1_000_000_000n;
  const shown = quoteBuyWithSol(r0, budget, 100n, 200n)!;
  // A small buy landed first: within slippage, so it goes, but max_sol_cost stays within the shown worst price per token.
  const small = quoteBuyWithSol(r0, 15_000_000n, 100n, 0n)!;
  const r = requoteBuy(applyBuy(r0, small.tokens, small.solCost), budget, shown, 100n, 200n);
  assert.ok(r.ok);
  if (r.ok) assert.ok(r.quote.maxCost * shown.tokens <= shown.maxCost * r.quote.tokens, "price per token capped at the shown max");
  // The price already sits above the shown max per token: refused, even though fewer tokens alone was within 2%.
  const edge = quoteBuyWithSol(r0, 25_000_000_000n, 100n, 0n)!;
  const atEdge = requoteBuy(applyBuy(r0, edge.tokens, edge.solCost), budget, shown, 100n, 200n);
  assert.ok(!atEdge.ok);

  const held = 50_000_000_000_000n;
  const mid = applyBuy(r0, held * 4n, quoteBuyWithSol(r0, 30_000_000_000n, 100n, 0n)!.solCost);
  const shownSell = quoteSellTokens(mid, held, 100n, 200n)!;
  // Someone sold a little first: the fresh net is lower but above the shown minimum; min_sol_output stays the shown one.
  const nudged = { ...mid, virtualSol: mid.virtualSol - 5_000_000n, virtualToken: mid.virtualToken + 80_000_000_000n, realSol: mid.realSol - 5_000_000n, realToken: mid.realToken + 80_000_000_000n };
  const s2 = requoteSell(nudged, held, shownSell, 100n, 200n);
  assert.ok(s2.ok);
  if (s2.ok) assert.ok(s2.quote.minOut >= shownSell.minOut, `min_sol_output ${s2.quote.minOut} >= shown ${shownSell.minOut}`);
});

test("re-quote: a fresh curve within slippage is sent as freshly quoted; a move past it is refused", () => {
  const r0 = initialReserves();
  const budget = 1_000_000_000n;
  const shown = quoteBuyWithSol(r0, budget, 100n, 200n)!;
  const same = requoteBuy(r0, budget, shown, 100n, 200n);
  assert.ok(same.ok && same.quote.tokens === shown.tokens);
  // Someone bought 1% of the curve meanwhile: price up a little, still within 2%.
  const small = quoteBuyWithSol(r0, 20_000_000n, 100n, 0n)!;
  const nudged = applyBuy(r0, small.tokens, small.solCost);
  const ok = requoteBuy(nudged, budget, shown, 100n, 200n);
  assert.ok(ok.ok && ok.quote.tokens < shown.tokens && ok.quote.total <= budget, "fewer tokens, same budget");
  // A big buy landed first: the price moved far past 2%.
  const big = quoteBuyWithSol(r0, 10_000_000_000n, 100n, 0n)!;
  const moved = applyBuy(r0, big.tokens, big.solCost);
  const refused = requoteBuy(moved, budget, shown, 100n, 200n);
  assert.ok(!refused.ok && /slippage/.test(refused.reason));

  const held = 50_000_000_000_000n;
  const mid = applyBuy(r0, held * 4n, quoteBuyWithSol(r0, 30_000_000_000n, 100n, 0n)!.solCost);
  const shownSell = quoteSellTokens(mid, held, 100n, 200n)!;
  assert.ok(requoteSell(mid, held, shownSell, 100n, 200n).ok);
  const dumped = { ...mid, virtualSol: mid.virtualSol - 3_000_000_000n, virtualToken: mid.virtualToken + 60_000_000_000_000n, realSol: mid.realSol - 3_000_000_000n, realToken: mid.realToken + 60_000_000_000_000n };
  const r = requoteSell(dumped, held, shownSell, 100n, 200n);
  assert.ok(!r.ok, "a sale whose fresh proceeds fall under the shown minimum is refused");
});

test("launch locks: Clock sysvar time, the exact lock boundary, and failing closed", async () => {
  const clock = new Uint8Array(40);
  new DataView(clock.buffer).setBigInt64(32, 1_800_000_123n, true);
  assert.equal(clockUnixTimestamp(clock), 1_800_000_123);

  const mint = Keypair.generate().publicKey;
  const reg = (ts: number) => ({ mint, launchTimestamp: { toNumber: () => ts } });
  assert.equal(registryLock(null, 1_000, 259_200), "free");
  assert.equal(registryLock({ mint: PublicKey.default, launchTimestamp: { toNumber: () => 999 } }, 1_000, 259_200), "free");
  assert.equal(registryLock(reg(1_000), 1_000 + 259_199, 259_200), "locked");
  assert.equal(registryLock(reg(1_000), 1_000 + 259_200, 259_200), "free", "free exactly at launch + lock, as create.rs decides");

  const now = async () => 2_000_000;
  const all = await checkLocks({ now, ticker: async () => reg(2_000_000 - 10), name: async () => null, tweet: null }, 259_200);
  assert.deepEqual(all, { ticker: "locked", name: "free", tweet: "free" });
  assert.equal(lockBlocker(all, "3 days"), "This ticker is locked for 3 days");

  const failing = await checkLocks({ now, ticker: async () => null, name: async () => Promise.reject(new Error("429")), tweet: null }, 259_200);
  assert.deepEqual(failing, { ticker: "free", name: "unknown", tweet: "free" }, "an unreadable registry is unknown, never free");
  assert.match(lockBlocker(failing, "3 days")!, /Couldn't check/);

  const hung = await checkLocks({ now, ticker: () => new Promise(() => undefined), name: null, tweet: null }, 259_200, 20);
  assert.equal(hung.ticker, "unknown", "a read that hangs times out as unknown");

  const noClock = await checkLocks({ now: () => Promise.reject(new Error("down")), ticker: async () => null, name: async () => null, tweet: null }, 259_200);
  assert.deepEqual(noClock, { ticker: "unknown", name: "unknown", tweet: "free" }, "without cluster time nothing can be judged");
  assert.equal(lockBlocker({ ticker: "free", name: "free", tweet: "free" }, "3 days"), null);
});

test("launch attribution: the ticker's coin is ours only if its curve's creator is our payer", () => {
  const me = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const reg = { mint, launchTimestamp: { toNumber: () => 1_000 } };
  assert.ok(launchedBy(reg, me, me, 990)?.equals(mint));
  assert.equal(launchedBy(reg, other, me, 990), null, "another payer won the race for this ticker: our ticket was refunded");
  assert.equal(launchedBy(reg, null, me, 990), null);
  assert.equal(launchedBy(reg, me, me, 2_000), null, "an older launch of the ticker isn't ours");
  assert.equal(launchedBy(null, me, me, 990), null);
});

test("curve progress: tokens sold over the launch reserves (the indexer's measure); complete and migrated are 1", () => {
  const r0 = initialReserves();
  assert.equal(curveProgress(r0), 0);
  const half = { ...r0, realToken: PROTOCOL.initialRealToken / 2n };
  assert.equal(curveProgress(half), 0.5);
  // The indexer's progressOf (services/parabull-indexer src/model.ts) on the same numbers.
  const indexer = (initial: bigint, real: bigint) => Number(initial - real) / Number(initial);
  assert.equal(curveProgress(half), indexer(PROTOCOL.initialRealToken, half.realToken));
  const coin = { migrated: false, complete: false, reserves: half };
  assert.equal(progressOf(coin), 0.5);
  assert.equal(progressOf({ ...coin, progress: 0.42 }), 0.42, "chain mode: the indexer's own figure");
  assert.equal(progressOf({ ...coin, complete: true, reserves: { ...half, realSol: 0n } }), 1, "complete, even after prepare_migration emptied the SOL");
  assert.equal(progressOf({ ...coin, migrated: true }), 1);
});

test("chat reconnect: exponential steps capped at 30s, jittered between half and all of each step", async () => {
  const { reconnectDelay } = await import("../src/lib/chatClient");
  assert.deepEqual([0, 1, 2, 5, 9].map((a) => reconnectDelay(a, () => 0.999999)), [1000, 2000, 4000, 30000, 30000]);
  assert.deepEqual([0, 1, 2, 5, 9].map((a) => reconnectDelay(a, () => 0)), [500, 1000, 2000, 15000, 15000]);
  const draws = Array.from({ length: 200 }, () => reconnectDelay(3));
  assert.ok(draws.every((d) => d >= 4000 && d <= 8000));
  assert.ok(new Set(draws).size > 50, "clients spread out");
  assert.equal(reconnectDelay(1_000, () => 0.5), 22_500, "a huge attempt count stays capped");
});

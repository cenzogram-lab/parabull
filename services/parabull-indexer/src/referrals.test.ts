import assert from "node:assert/strict";
import { test } from "node:test";
import { refMemo } from "../../../app/src/lib/callouts";
import { Indexer } from "./indexer";
import { MEMO_PROGRAM_ID, memoLogLines, topLevelMemos } from "./memo";
import { MockChain, addressOf } from "./mockChain";
import { Referrals, type ReferralEvent } from "./referrals";
import { Rpc } from "./rpc";

const ALICE = addressOf("alice");
const BOB = addressOf("bob");
const CAROL = addressOf("carol");
const CALL = "AbCdEfGhJkLm";
const OTHER = "ZyXwVuTsRqPn";

async function setup() {
  const chain = new MockChain();
  await chain.initGlobal();
  const ticket = chain.requestLaunch(ALICE, "REF", 1n);
  const mint = addressOf("mint:REF");
  await chain.create(ticket, { mint, name: "Ref coin", symbol: "REF", uri: "" });
  const ix = new Indexer({ rpc: new Rpc("http://rpc.test", chain.fetch, 2_000), now: () => chain.time * 1000 });
  return { chain, ix, mint };
}

test("memos: only top-level Memo program lines count, exactly as logged", () => {
  const text = refMemo(CALL);
  assert.deepEqual(topLevelMemos(memoLogLines(text)), [text]);
  assert.deepEqual(memoLogLines(text)[1], `Program log: Memo (len 25): "parabull:ref:${CALL}"`);
  // A memo made inside another program's CPI belongs to that program.
  const inCpi = ["Program Other111 invoke [1]", `Program ${MEMO_PROGRAM_ID} invoke [2]`, memoLogLines(text)[1], `Program ${MEMO_PROGRAM_ID} success`, "Program Other111 success"];
  assert.deepEqual(topLevelMemos(inCpi), []);
  // Another program logging the same text isn't a memo.
  assert.deepEqual(topLevelMemos(["Program Other111 invoke [1]", memoLogLines(text)[1], "Program Other111 success"]), []);
  // A length that doesn't match the text, or Rust escapes JSON can't read, is skipped.
  assert.deepEqual(topLevelMemos([`Program ${MEMO_PROGRAM_ID} invoke [1]`, `Program log: Memo (len 3): "${text}"`, `Program ${MEMO_PROGRAM_ID} success`]), []);
  assert.deepEqual(topLevelMemos([`Program ${MEMO_PROGRAM_ID} invoke [1]`, 'Program log: Memo (len 4): "\\u{1f402}"', `Program ${MEMO_PROGRAM_ID} success`]), []);
  assert.deepEqual(topLevelMemos(memoLogLines('quote " and \\ slash')), ['quote " and \\ slash']);
});

test("referrals: a buy tagged with a callout's memo is recorded for it; sells, untagged buys and CPI memos aren't", async () => {
  const { chain, ix, mint } = await setup();
  const b1 = await chain.trade(mint, BOB, true, 10_000_000_000_000n, { memo: refMemo(CALL) });
  await chain.trade(mint, CAROL, true, 5_000_000_000_000n, { memo: refMemo(CALL) });
  await chain.trade(mint, BOB, true, 1_000_000_000_000n);
  await chain.trade(mint, BOB, false, 1_000_000_000_000n, { memo: refMemo(CALL) });
  await chain.trade(mint, CAROL, true, 1_000_000_000_000n, { memo: "gm" });
  await chain.trade(mint, CAROL, true, 1_000_000_000_000n, { extraLines: [`Program ${MEMO_PROGRAM_ID} invoke [2]`, memoLogLines(refMemo(OTHER))[1], `Program ${MEMO_PROGRAM_ID} success`] });
  await chain.trade(mint, ALICE, true, 2_000_000_000_000n, { memo: refMemo(OTHER), err: { InstructionError: [0, { Custom: 1 }] } });
  await ix.start();
  assert.equal(ix.referrals.size, 2);
  const tx = chain.txs.find((t) => t.signature === b1)!;
  const t = ix.store.trades(mint).find((x) => x.signature === b1)!;
  const agg = ix.referrals.forCallout(CALL);
  assert.equal(agg.buys, 2);
  assert.equal(agg.traders, 2);
  const bob = agg.byTrader.find((r) => r.wallet === BOB)!;
  assert.deepEqual(bob, { wallet: BOB, buys: 1, volumeLamports: t.solAmount.toString(), feeLamports: t.fee.toString() });
  assert.deepEqual(agg.byMint.map((m) => [m.mint, m.buys]), [[mint, 2]]);
  assert.equal(agg.firstAt, tx.blockTime);
  assert.equal(ix.referrals.forCallout(OTHER).buys, 0, "the CPI memo and the failed buy don't count");
  // The backfill read back to the program's first transaction: the ledger is complete.
  assert.equal(ix.referralsCoveredFrom(), null);
});

test("referrals: the websocket and the poller record a tagged buy once", async () => {
  const { chain, ix, mint } = await setup();
  await ix.start();
  const stop = ix.subscribe("ws://rpc.test", chain.WebSocket);
  await new Promise((r) => setTimeout(r, 5));
  await chain.trade(mint, BOB, true, 3_000_000_000_000n, { memo: refMemo(CALL) });
  await ix.pollTransactions();
  stop();
  assert.equal(ix.referrals.forCallout(CALL).buys, 1);
});

test("referrals: a window pages oldest first; a truncated backfill or eviction says from when it's complete", async () => {
  const { chain, ix, mint } = await setup();
  for (let i = 0; i < 6; i++) await chain.trade(mint, i % 2 ? BOB : CAROL, true, 1_000_000_000_000n, { memo: refMemo(CALL) });
  // A short backfill: only the newest 3 transactions.
  const short = new Indexer({ rpc: new Rpc("http://rpc.test", chain.fetch, 2_000), now: () => chain.time * 1000, backfillLimit: 3 });
  await short.start();
  assert.equal(short.referrals.size, 3);
  assert.equal(short.referralsCoveredFrom(), chain.txs[chain.txs.length - 3].blockTime);
  await ix.start();
  const all = ix.referrals.window(0, 2 ** 40, 0, 100).events;
  assert.equal(all.length, 6);
  assert.ok(all.every((e, i) => i === 0 || all[i - 1].timestamp <= e.timestamp));
  const p1 = ix.referrals.window(0, 2 ** 40, 0, 4);
  assert.deepEqual([p1.events.length, p1.next], [4, 4]);
  assert.deepEqual(ix.referrals.window(0, 2 ** 40, 4, 4).events.map((e) => e.signature), all.slice(4).map((e) => e.signature));
  assert.deepEqual(ix.referrals.window(all[2].timestamp, all[4].timestamp, 0, 100).events.map((e) => e.signature), [all[2].signature, all[3].signature]);

  // Out-of-order inserts (the websocket before the backfill) still come out in time order, and eviction drops the oldest.
  const ev = (ts: number, sig: string): ReferralEvent => ({ calloutId: CALL, signature: sig, index: 0, mint, trader: BOB, solLamports: 1n, feeLamports: 0n, tokenAmount: 1n, slot: ts, timestamp: ts });
  const r = new Referrals({ maxEvents: 3, maxCallouts: 10 });
  for (const [ts, sig] of [[50, "e"], [10, "a"], [30, "c"], [20, "b"]] as const) r.add(ev(ts, sig));
  assert.equal(r.add(ev(20, "b")), false, "a repeat is ignored");
  assert.deepEqual(r.window(0, 100, 0, 10).events.map((e) => e.signature), ["b", "c", "e"]);
  assert.equal(r.evictedThrough, 10);
});

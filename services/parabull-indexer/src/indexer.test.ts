import assert from "node:assert/strict";
import { test } from "node:test";
import { findProgramAddress } from "../../parabull-edge/src/solana";
import { Indexer, metadataFields } from "./indexer";
import { DEVNET_CPMM, INITIAL, MockChain, addressOf } from "./mockChain";
import { coinJson, priceSol, statusOf } from "./model";
import { Rpc } from "./rpc";

const ALICE = addressOf("alice");
const BOB = addressOf("bob");
const CAROL = addressOf("carol");
const MEDIA = "https://media.parabull.test";

async function setup(o: { metadataFetch?: typeof fetch; backfillLimit?: number } = {}) {
  const chain = new MockChain();
  await chain.initGlobal();
  const ix = new Indexer({
    rpc: new Rpc("http://rpc.test", chain.fetch, 2_000),
    now: () => chain.time * 1000,
    backfillLimit: o.backfillLimit ?? 1000,
    metadataOrigins: [MEDIA],
    fetchImpl: o.metadataFetch ?? (async () => new Response("{}", { status: 404 })),
  });
  return { chain, ix };
}
const count = (chain: MockChain, method: string) => chain.calls.filter((c) => c.method === method).length;

/** A launch all the way through: ticket, create, and the mint's address. */
async function launch(chain: MockChain, payer: string, symbol: string, n = 1n) {
  const ticket = chain.requestLaunch(payer, symbol, n);
  const mint = addressOf(`mint:${symbol}`);
  await chain.create(ticket, { mint, name: `${symbol} coin`, symbol, uri: `${MEDIA}/meta/${symbol}.json` });
  return { ticket, mint };
}

test("indexer: launch tickets go pending -> created (the coin appears), refunded, or closed without an event", async () => {
  const { chain, ix } = await setup();
  const t1 = chain.requestLaunch(ALICE, "BULL");
  const t2 = chain.requestLaunch(BOB, "BEAR");
  await ix.start();
  assert.equal(ix.store.tickets.get(t1)?.state, "pending");
  assert.equal(ix.store.tickets.get(t1)?.ticker, "BULL");
  assert.equal(ix.store.coins.size, 0);

  // The launch worker creates BULL; BEAR is refunded; a third ticket closes with no event the indexer saw.
  const mint = addressOf("mint:BULL");
  await chain.create(t1, { mint, name: "Bull Run", symbol: "BULL", uri: `${MEDIA}/meta/bull.json`, tweet: true });
  chain.refund(t2);
  const t3 = chain.requestLaunch(CAROL, "GONE");
  await ix.pollTransactions();
  await ix.syncTickets();
  chain.accounts.delete(t3);
  await ix.syncTickets();

  assert.deepEqual([ix.store.tickets.get(t1)?.state, ix.store.tickets.get(t1)?.mint], ["created", mint]);
  assert.equal(ix.store.tickets.get(t2)?.state, "refunded");
  assert.equal(ix.store.tickets.get(t3)?.state, "closed");
  const coin = ix.store.coins.get(mint)!;
  assert.deepEqual([coin.name, coin.symbol, coin.creator, coin.ticket, coin.tweetLocked], ["Bull Run", "BULL", ALICE, t1, true]);
  assert.equal(statusOf(coin, ix.nowSec()), "new");
  // A later snapshot (the ticket account is gone) never walks "created" back.
  await ix.syncTickets();
  assert.equal(ix.store.tickets.get(t1)?.state, "created");
});

test("indexer: trades move the coin and its 24h stats; failed transactions are skipped", async () => {
  const { chain, ix } = await setup();
  const { mint } = await launch(chain, ALICE, "BULL");
  await ix.start();
  await chain.trade(mint, BOB, true, 50_000_000_000_000n);
  await chain.trade(mint, CAROL, true, 20_000_000_000_000n);
  await chain.trade(mint, BOB, false, 10_000_000_000_000n);
  await chain.trade(mint, CAROL, true, 99_000_000_000_000n, { err: { InstructionError: [0, { Custom: 6001 }] } });
  await ix.pollTransactions();

  const trades = ix.store.trades(mint);
  assert.equal(trades.length, 3, "the failed buy isn't a trade");
  assert.deepEqual(trades.map((t) => [t.user === BOB ? "bob" : "carol", t.isBuy]), [["bob", false], ["carol", true], ["bob", true]], "newest first");
  const { data } = await chain.curve(mint);
  const coin = ix.store.coins.get(mint)!;
  assert.equal(coin.virtualSol, data.virtual_sol_reserves, "reserves follow the last trade");
  assert.equal(coin.realToken, data.real_token_reserves);
  const j = coinJson(coin, trades, ix.nowSec(), ix.store.fullHistory.has(mint));
  assert.equal(j.stats.buys24h, 2);
  assert.equal(j.stats.sells24h, 1);
  assert.equal(j.stats.traders24h, 2);
  assert.equal(BigInt(j.stats.volume24hLamports), trades.reduce((s, t) => s + t.solAmount, 0n));
  assert.ok(j.stats.change1h! > 0, "price up since launch");
  assert.equal(j.stats.spark.length, 24);
  assert.equal(j.priceSol, priceSol(data.virtual_token_reserves as bigint, data.virtual_sol_reserves as bigint));
  assert.ok(Math.abs(j.progress - 60_000_000_000_000 / Number(INITIAL.realToken)) < 1e-9);
  assert.equal(j.reserves.realToken, String(data.real_token_reserves), "u64 as strings");
});

test("indexer: graduation (complete -> migrated), priced from the Raydium pool; Raydium's own event is ignored", async () => {
  const { chain, ix } = await setup();
  const { mint } = await launch(chain, ALICE, "MOON");
  await ix.start();
  await chain.trade(mint, BOB, true, INITIAL.realToken * 2n); // buys out the curve
  await ix.pollTransactions();
  let coin = ix.store.coins.get(mint)!;
  assert.equal(coin.complete, true);
  assert.equal(statusOf(coin, ix.nowSec()), "graduating");
  assert.equal(coinJson(coin, ix.store.trades(mint), ix.nowSec(), true).progress, 1);
  assert.equal(ix.store.trades(mint)[0].tokenAmount, INITIAL.realToken, "the final buy fills only what was left");

  await chain.migrate(mint);
  await ix.pollTransactions();
  await ix.syncCurves();
  coin = ix.store.coins.get(mint)!;
  assert.equal(statusOf(coin, ix.nowSec()), "graduated");
  assert.ok(coin.raydiumPool);
  assert.equal(ix.store.trades(mint).length, 1, "the TradeEvent-shaped data Raydium logged inside its CPI isn't a trade");
  const solInPool = Number((await chain.curve(mint)).data.real_sol_reserves) === 0;
  assert.ok(solInPool);
  assert.ok(coin.poolPriceSol && coin.poolPriceSol > 0, "priced from the pool's vaults");
  const j = coinJson(coin, ix.store.trades(mint), ix.nowSec(), true);
  assert.equal(j.priceSol, coin.poolPriceSol);
});

test("indexer: logsSubscribe delivers at once; the poller then skips what the socket already applied", async () => {
  const { chain, ix } = await setup();
  await ix.start();
  const stop = ix.subscribe("ws://rpc.test", chain.WebSocket);
  await new Promise((r) => setTimeout(r, 5));
  const seen: string[] = [];
  ix.on("coin", (m: string) => seen.push(m));
  const { mint } = await launch(chain, ALICE, "FAST");
  await chain.trade(mint, BOB, true, 1_000_000_000_000n);
  assert.ok(ix.store.coins.has(mint), "the new coin is on the board before any poll");
  assert.equal(ix.store.trades(mint).length, 1);
  assert.ok(seen.includes(mint));
  const before = count(chain, "getTransaction");
  await ix.pollTransactions();
  assert.equal(count(chain, "getTransaction"), before, "nothing re-fetched");
  assert.equal(ix.store.trades(mint).length, 1, "no duplicate trade");
  stop();
});

test("indexer: backfill pages getSignaturesForAddress with `before`, applies oldest first, then polls with `until`", async () => {
  const { chain, ix } = await setup({ backfillLimit: 2_500 });
  const { mint } = await launch(chain, ALICE, "PAGE");
  for (let i = 0; i < 1_200; i++) await chain.trade(mint, i % 2 ? BOB : CAROL, true, 1_000_000_000n);
  await ix.start();
  const sigCalls = chain.calls.filter((c) => c.method === "getSignaturesForAddress");
  assert.equal(sigCalls.length, 2, "1,203 transactions: a page of 1,000 and the rest");
  assert.equal((sigCalls[1].params[1] as { before?: string }).before, (chain.handle("getSignaturesForAddress", [ix.programId, { limit: 1000 }]) as { signature: string }[])[999].signature);
  assert.equal(ix.store.trades(mint).length, 1_200);
  const { data } = await chain.curve(mint);
  assert.equal(ix.store.coins.get(mint)!.virtualSol, data.virtual_sol_reserves, "applied in order: the last trade's reserves win");
  assert.ok(ix.store.fullHistory.has(mint), "the backfill reached the coin's creation");

  await chain.trade(mint, BOB, false, 1_000_000_000n);
  await ix.pollTransactions();
  const last = chain.calls.filter((c) => c.method === "getSignaturesForAddress").at(-1)!;
  assert.equal((last.params[1] as { until?: string }).until, chain.txs[chain.txs.length - 2].signature);
  assert.equal(ix.store.trades(mint).length, 1_201);

  // A short backfill doesn't reach old coins: their history is marked incomplete.
  const short = await setup({ backfillLimit: 10 });
  const old = await launch(short.chain, ALICE, "OLD");
  for (let i = 0; i < 20; i++) await short.chain.trade(old.mint, BOB, true, 1_000_000_000n);
  await short.ix.start();
  assert.equal(short.ix.store.trades(old.mint).length, 10);
  assert.equal(short.ix.store.fullHistory.has(old.mint), false);
});

test("indexer: an RPC failure mid-poll moves nothing; the next poll catches up", async () => {
  const { chain, ix } = await setup();
  const { mint } = await launch(chain, ALICE, "FLAKY");
  await ix.start();
  const cursor = ix.newestSignature;
  await chain.trade(mint, BOB, true, 1_000_000_000n);
  chain.failing = "getTransaction";
  await assert.rejects(ix.pollTransactions());
  assert.equal(ix.newestSignature, cursor);
  chain.failing = null;
  await ix.pollTransactions();
  assert.equal(ix.store.trades(mint).length, 1);
});

test("indexer: a coin created since the last poll is found on demand (no 'Coin not found'); bogus mints are cached as missing", async () => {
  const { chain, ix } = await setup();
  await ix.start();
  const { mint } = await launch(chain, ALICE, "JUST"); // not polled, no websocket
  assert.equal(ix.store.coins.has(mint), false);
  const coin = await ix.coin(mint);
  assert.ok(coin);
  assert.deepEqual([coin.name, coin.symbol, coin.creator], ["JUST coin", "JUST", ALICE], "name and symbol from the mint's Token-2022 metadata");

  const bogus = addressOf("not-a-coin");
  const before = count(chain, "getMultipleAccounts");
  assert.equal(await ix.coin(bogus), null);
  assert.equal(await ix.coin(bogus), null);
  assert.equal(count(chain, "getMultipleAccounts"), before + 1, "the miss is remembered");
  // A non-Parabull account at the curve address doesn't count.
  const { address } = await findProgramAddress([new TextEncoder().encode("bonding-curve"), new Uint8Array(32)], ix.programId);
  chain.accounts.set(address, { data: new Uint8Array(200), owner: addressOf("other-program"), lamports: 1 });
  assert.equal(await ix.coin("11111111111111111111111111111111"), null);
});

test("indexer: holders, largest first with protocol accounts labelled; portfolio from token accounts", async () => {
  const { chain, ix } = await setup();
  const { mint } = await launch(chain, ALICE, "HOLD");
  await chain.trade(mint, BOB, true, 30_000_000_000_000n);
  await chain.trade(mint, ALICE, true, 10_000_000_000_000n);
  await chain.trade(mint, CAROL, true, 5_000_000_000_000n);
  await ix.start();
  const h = (await ix.holders(mint))!;
  assert.equal(h.count, 4);
  assert.deepEqual(h.holders.map((x) => x.label), ["bonding_curve", null, "creator", null]);
  assert.equal(h.holders[1].owner, BOB);
  assert.equal(h.holders[1].amount, "30000000000000");
  assert.ok(Math.abs(h.holders.reduce((s, x) => s + x.pct, 0) - 1) < 1e-12, "everything is somewhere");
  assert.equal(ix.store.coins.get(mint)!.holderCount, 3, "people, not the curve");
  // Counted on start for the board, before anyone opened the coin.
  const fresh = await setup();
  const other = await launch(fresh.chain, ALICE, "CNT");
  await fresh.chain.trade(other.mint, BOB, true, 1_000_000_000n);
  await fresh.ix.start();
  assert.equal(fresh.ix.store.coins.get(other.mint)!.holderCount, 1);
  const calls = count(chain, "getProgramAccounts");
  await ix.holders(mint);
  await Promise.all([ix.holders(mint), ix.holders(mint)]);
  assert.equal(count(chain, "getProgramAccounts"), calls, "cached");
  assert.equal(await ix.holders(addressOf("nope")), null);

  const p = await ix.portfolio(BOB);
  assert.equal(p.lamports, "5000000000");
  assert.deepEqual(p.holdings.map((x) => [x.mint, x.amount]), [[mint, "30000000000000"]]);
  const coin = ix.store.coins.get(mint)!;
  assert.ok(Math.abs(p.holdings[0].valueSol - 30_000_000 * priceSol(coin.virtualToken, coin.virtualSol)) < 1e-9);
  // A trade drops the cached portfolio.
  await chain.trade(mint, BOB, false, 30_000_000_000_000n);
  await ix.pollTransactions();
  assert.deepEqual((await ix.portfolio(BOB)).holdings, []);
});

test("indexer: metadata JSON only from allowed origins, no redirects, size-capped; fields sanitized", async () => {
  const asked: { url: string; redirect?: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    asked.push({ url, redirect: init?.redirect });
    if (url.endsWith("/big.json")) return new Response("x".repeat(70_000));
    return Response.json({ image: `${MEDIA}/img/a.png`, description: "  The bull  ", twitter: "@bullrun", website: "javascript:alert(1)", telegram: "https://t.me/bull" });
  }) as typeof fetch;
  const { chain, ix } = await setup({ metadataFetch: fetchImpl });
  const { mint } = await launch(chain, ALICE, "META");
  const t = chain.requestLaunch(BOB, "EVIL", 2n);
  await chain.create(t, { mint: addressOf("mint:EVIL"), name: "Evil", symbol: "EVIL", uri: "http://169.254.169.254/latest/meta-data" });
  const t2 = chain.requestLaunch(CAROL, "BIG", 3n);
  await chain.create(t2, { mint: addressOf("mint:BIG"), name: "Big", symbol: "BIG", uri: `${MEDIA}/big.json` });
  await ix.start();
  await ix.loadMetadataJson();
  const c = ix.store.coins.get(mint)!;
  assert.deepEqual([c.image, c.description, c.socials], [`${MEDIA}/img/a.png`, "The bull", { x: "https://x.com/bullrun", telegram: "https://t.me/bull" }]);
  assert.ok(asked.every((a) => a.url.startsWith(MEDIA) && a.redirect === "error"), "nothing fetched outside the allowed origin; redirects refused");
  assert.equal(ix.store.coins.get(addressOf("mint:BIG"))!.image, null, "oversized JSON ignored");
  assert.deepEqual(metadataFields({ image: "data:image/png;base64,AAA" }).image, null);
  assert.deepEqual(metadataFields(null), { image: null, description: null, socials: {} });
});

test("indexer: the program's Global is required (fails closed on an uninitialized cluster)", async () => {
  const chain = new MockChain();
  const ix = new Indexer({ rpc: new Rpc("http://rpc.test", chain.fetch, 2_000) });
  await assert.rejects(ix.start(), /Global account not found/);
  assert.equal(DEVNET_CPMM.length > 30, true);
});

test("indexer: an event for an unknown coin while the RPC is down doesn't crash the process (no unhandled rejection)", async () => {
  const { chain, ix } = await setup();
  await ix.start();
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { mint } = await launch(chain, ALICE, "LATE");
    await chain.trade(mint, BOB, true, 1_000_000_000n);
    await chain.migrate(mint);
    // The indexer sees the trade and migration (not the creation) while getMultipleAccounts fails.
    ix.store.markSeen(chain.txs[chain.txs.length - 3].signature);
    chain.failing = "getMultipleAccounts";
    for (const t of chain.txs.slice(-2)) ix.ingest(t.signature, t.logs);
    await new Promise((r) => setTimeout(r, 1_500));
    assert.deepEqual(unhandled, []);
    chain.failing = null;
    assert.ok(await ix.coin(mint), "found once the RPC is back");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("store: trades past a coin's cap are forgotten with their dedupe keys (memory stays bounded)", async () => {
  const { Store, MAX_TRADES_PER_COIN } = await import("./store");
  const s = new Store();
  const n = MAX_TRADES_PER_COIN + 250;
  for (let i = 0; i < n; i++)
    s.addTrade({ signature: `sig${i}`, index: 0, mint: "M", user: `u${i % 7}`, isBuy: true, tokenAmount: 1n, solAmount: 1n, fee: 0n, slot: i, timestamp: i, virtualToken: 1n, virtualSol: 1n, realToken: 1n, realSol: 1n });
  assert.equal(s.trades("M").length, MAX_TRADES_PER_COIN);
  assert.equal(s.tradeKeyCount, MAX_TRADES_PER_COIN, "keys for evicted trades are dropped");
  assert.equal(s.trades("M").at(-1)!.signature, "sig250", "the oldest go first");
});

test("indexer: replaying a ticket's LaunchRequested keeps its on-chain creation time", async () => {
  const { chain, ix } = await setup();
  const createdOnChain = chain.time; // request_launch's created_at
  const t = chain.requestLaunch(ALICE, "TIME");
  chain.time += 5_000; // the indexer starts much later and backfills the request
  await ix.start();
  assert.equal(ix.store.tickets.get(t)?.createdAt, createdOnChain);
});

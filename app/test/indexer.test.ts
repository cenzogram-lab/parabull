import assert from "node:assert/strict";
import { test } from "node:test";
import { connectSources } from "../src/lib/icHeaders";
import { positionsFrom, stageOf, toCoin, toHolders, toTrade, type CoinJson, type PortfolioJson, type TradeJson } from "../src/lib/indexer";

const MINT = "DrLUh4S9VS1rsJwPKexAmJsUhpZa89At8ea11ASTCUGn";
const USER = "7Z41mBaP2t5tbxJDRCGUdHC2Gw4dwbBgrmYzkFZq73cW";

const coinJson = (over: Partial<CoinJson> = {}): CoinJson => ({
  mint: MINT,
  curve: USER,
  creator: USER,
  ticket: null,
  name: "Bronze Bull",
  symbol: "BRONZE",
  uri: "",
  image: "https://media.parabull.test/img/a.png",
  description: "The bull",
  socials: { x: "https://x.com/bull" },
  createdAt: 1_762_560_000,
  createdSlot: "1",
  tradingOpenSlot: "5",
  status: "active",
  complete: false,
  migrated: false,
  escrowReleased: false,
  reserves: { virtualToken: "1073000000000000", virtualSol: "30000000000", realToken: "793100000000000", realSol: "0" },
  totalSupply: "1000000000000000",
  priceSol: 0.00000003,
  mcapSol: 30,
  athMcapSol: 40,
  progress: 0.4,
  escrowAccruedLamports: "2000000000",
  raydiumPool: null,
  tweetLocked: true,
  holders: 12,
  stats: { volume24hLamports: "5000000000", buyVolume24hLamports: "3000000000", sellVolume24hLamports: "2000000000", trades24h: 4, buys24h: 3, sells24h: 1, traders24h: 2, change1h: 0.3, change6h: null, change24h: -0.1, spark: Array(24).fill(0.00000003), lastTradeAt: 1 },
  ...over,
});

test("indexer client: coin JSON becomes the app's Coin in USD (u64 strings to bigint, unknown changes to 0)", () => {
  const c = toCoin(coinJson(), 200, 259_200);
  assert.equal(c.ticker, "BRONZE");
  assert.equal(c.reserves.virtualToken, 1_073_000_000_000_000n);
  assert.ok(Math.abs(c.mcapUsd - 6000) < 1e-9);
  assert.ok(Math.abs(c.athUsd - 8000) < 1e-9);
  assert.ok(Math.abs(c.vol24hUsd - 1000) < 1e-9);
  assert.ok(Math.abs(c.escrowUsd - 400) < 1e-9);
  assert.deepEqual([c.change1h, c.change6h, c.change24h, c.hot], [0.3, null, -0.1, true], "an unknown change stays unknown");
  assert.equal(c.locks.ticker, (1_762_560_000 + 259_200) * 1000);
  assert.equal(c.locks.tweet, c.locks.ticker);
  assert.equal(c.createdAt, 1_762_560_000_000);
  assert.equal(c.pool, undefined);
  // A non-https image (ipfs://, data:, http://) falls back to generated art.
  assert.match(toCoin(coinJson({ image: "http://evil.test/x.png" }), 200, 0).image, /^data:image\/svg\+xml/);
  const grad = toCoin(coinJson({ migrated: true, complete: true, raydiumPool: USER, status: "graduated" }), 200, 0);
  assert.equal(grad.stage, "graduated");
  assert.equal(grad.pool?.address, USER);
});

test("indexer client: stages (new, live, soon at 72% or complete, graduated)", () => {
  assert.equal(stageOf(coinJson({ status: "new", progress: 0.9 })), "new");
  assert.equal(stageOf(coinJson({ progress: 0.71 })), "live");
  assert.equal(stageOf(coinJson({ progress: 0.72 })), "soon");
  assert.equal(stageOf(coinJson({ status: "graduating", complete: true, progress: 1 })), "soon");
  assert.equal(stageOf(coinJson({ status: "graduated", migrated: true })), "graduated");
});

test("indexer client: trades (a buy's SOL includes the fee, a sell's is net) and holders (PnL unknown)", () => {
  const t: TradeJson = { signature: "sig", index: 0, mint: MINT, user: USER, side: "buy", tokenAmount: "35000000000", solAmount: "1000000000", fee: "10000000", slot: 9, timestamp: 1_762_560_100, priceSol: 0.00000004, mcapSol: 40 };
  const buy = toTrade(t, 200);
  assert.deepEqual([buy.id, buy.sol, buy.tokens, buy.ts, buy.trader], ["sig:0", 1.01, 35_000, 1_762_560_100_000, USER]);
  assert.ok(Math.abs(buy.mcapUsd - 8000) < 1e-9);
  assert.equal(toTrade({ ...t, side: "sell" }, 200).sol, 0.99);
  const rows = toHolders({ mint: MINT, totalSupply: "1000000000000000", count: 2, holders: [{ owner: USER, amount: "500000000000000", pct: 0.5, label: "bonding_curve" }, { owner: MINT, amount: "10000000", pct: 0.00001, label: null }] }, { priceUsd: 0.01 });
  assert.deepEqual(rows[0], { address: USER, label: "Bonding curve", pct: 0.5, tokens: 500_000_000, valueUsd: 5_000_000, pnlUsd: null });
  assert.equal(rows[1].label, undefined);
});

test("indexer client: positions from the portfolio, cost from the indexer's basis over the wallet's buys", () => {
  const p: PortfolioJson = {
    wallet: USER,
    lamports: "1",
    holdings: [
      { mint: MINT, amount: "2000000", valueSol: 3, costSol: 0.5, coin: coinJson() },
      { mint: USER, amount: "1000000", valueSol: 0.5, costSol: null, coin: coinJson({ mint: USER }) },
    ],
    trades: [
      { signature: "a", index: 0, mint: MINT, user: USER, side: "buy", tokenAmount: "4000000", solAmount: "990000000", fee: "10000000", slot: 1, timestamp: 1, priceSol: 0, mcapSol: 0 },
      { signature: "b", index: 0, mint: MINT, user: USER, side: "sell", tokenAmount: "2000000", solAmount: "500000000", fee: "5000000", slot: 2, timestamp: 2, priceSol: 0, mcapSol: 0 },
    ],
    next: null,
  };
  const pos = positionsFrom(p, 100);
  assert.equal(pos[MINT].tokens, 2_000_000n);
  assert.ok(Math.abs(pos[MINT].costUsd - 50) < 1e-9, "the indexer's basis (0.5 SOL), at $100");
  assert.ok(Math.abs(pos[USER].costUsd - 50) < 1e-9, "no indexed buys: today's value");
});

test("indexer client: the build's CSP lets the app reach the indexer and its stream", () => {
  const src = connectSources({ VITE_INDEXER_URL: "https://indexer.parabull.test" });
  assert.ok(src.includes("https://indexer.parabull.test") && src.includes("wss://indexer.parabull.test"));
  const local = connectSources({ VITE_INDEXER_URL: "http://127.0.0.1:8790" });
  assert.ok(local.includes("http://127.0.0.1:8790") && local.includes("ws://127.0.0.1:8790"));
  assert.ok(!connectSources({}).some((s) => s.includes("indexer")));
});

test("indexer client: the indexer's chart bars in USD; no trades yet is one flat bar at the current price", async () => {
  const { toCandles } = await import("../src/lib/indexer");
  assert.deepEqual(toCandles([{ time: 60, open: 1, high: 2, low: 0.5, close: 1.5, volumeSol: 3 }], 100, { priceUsd: 9 }, 60), [{ time: 60, open: 100, high: 200, low: 50, close: 150, volume: 300 }]);
  assert.deepEqual(toCandles([], 100, { priceUsd: 9 }, 60, 125_000), [{ time: 120, open: 9, high: 9, low: 9, close: 9, volume: 0 }]);
});

test("indexer client: unknown changes sort last and read as unknown", async () => {
  const { byChangeDesc, changeWords } = await import("../src/lib/format");
  assert.deepEqual([0.1, null, -0.5, 0.4, null].sort(byChangeDesc), [0.4, 0.1, -0.5, null, null]);
  assert.equal(changeWords(null, "24 hours"), "change in 24 hours unknown");
  assert.equal(changeWords(-0.125, "24 hours"), "down 12.5% in 24 hours");
});

test("chart: a collapsed range is widened (lightweight-charts' axis loop never ends on one), a real range is kept", async () => {
  const { minRange } = await import("../src/lib/chartRange");
  const flat = minRange({ priceRange: { minValue: 62_130, maxValue: 62_130.000001 } }, 0.02)!;
  assert.ok(Math.abs(flat.priceRange!.maxValue - flat.priceRange!.minValue - 62_130 * 0.02) < 1e-6);
  assert.deepEqual(minRange({ priceRange: { minValue: 0, maxValue: 0 } }, 0.02)!.priceRange, { minValue: -0.5, maxValue: 0.5 });
  const real = { priceRange: { minValue: 100, maxValue: 150 } };
  assert.equal(minRange(real, 0.02), real);
  assert.equal(minRange(null, 0.02), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { leafHash, verifyProof } from "../src/lib/merkle";
import { mcapSol } from "../src/lib/protocol";
import { fromHex } from "../src/lib/sha256";
import { generateCoins, progressOf, SOL_USD } from "../src/mock/coins";
import { candles, holders, tradeHistory } from "../src/mock/market";
import { DEMO_WALLET, rewardEpochs } from "../src/mock/protocol";
import { generateCallouts, generateTraders } from "../src/mock/social";

const NOW = 1_800_000_000_000;

test("demo data is deterministic", () => {
  const a = generateCoins(NOW);
  const b = generateCoins(NOW);
  assert.deepEqual(
    a.map((c) => [c.mint, c.mcapUsd, c.change24h]),
    b.map((c) => [c.mint, c.mcapUsd, c.change24h]),
  );
});

test("curve coins are priced by the program's own math", () => {
  for (const c of generateCoins(NOW)) {
    if (c.migrated) {
      assert.equal(progressOf(c), 1);
      continue;
    }
    assert.ok(Math.abs(c.mcapUsd - mcapSol(c.reserves) * SOL_USD) < 1e-6, c.ticker);
    assert.ok(progressOf(c) > 0 && progressOf(c) < 1, c.ticker);
    assert.ok(c.athUsd >= c.mcapUsd * 0.999, `${c.ticker} ath below mcap`);
  }
  const king = generateCoins(NOW).find((c) => c.ticker === "BRONZE")!;
  assert.ok(Math.abs(progressOf(king) - 0.962) < 0.002);
});

test("candles end at the current price; the top-holder list never exceeds supply", () => {
  for (const c of generateCoins(NOW).slice(0, 12)) {
    const cs = candles(c, "5m", NOW);
    assert.ok(Math.abs(cs[cs.length - 1].close / c.priceUsd - 1) < 1e-9, c.ticker);
    assert.ok(cs.every((k) => k.low <= Math.min(k.open, k.close) && k.high >= Math.max(k.open, k.close)));
    const hs = holders(c);
    const total = hs.reduce((n, h) => n + h.pct, 0);
    assert.ok(total <= 1.0001 && total > 0.5, `${c.ticker} top holders ${total}`);
    assert.equal(tradeHistory(c, 30, NOW).length, 30);
  }
});

test("demo reward epochs carry real, verifiable proofs for the claimant", () => {
  const me = DEMO_WALLET;
  const epochs = rewardEpochs(me, NOW);
  let mine = 0;
  for (const e of epochs) {
    assert.ok(e.numLeaves >= 380 && BigInt(e.totalLamports) > 0n && e.publishedAt <= NOW);
    if (!e.you) continue;
    mine++;
    const ok = verifyProof(e.you.proof.map(fromHex), fromHex(e.root), leafHash(e.you.index, me.toBytes(), BigInt(e.you.amount)));
    assert.ok(ok, `epoch ${e.epoch}`);
    // The proof binds the amount and the claimant.
    assert.ok(!verifyProof(e.you.proof.map(fromHex), fromHex(e.root), leafHash(e.you.index, me.toBytes(), BigInt(e.you.amount) + 1n)));
  }
  assert.ok(mine >= 6, `claimant appears in ${mine} epochs`);
});

test("social feeds reference real demo coins", () => {
  const coins = generateCoins(NOW);
  const mints = new Set(coins.map((c) => c.mint));
  for (const c of generateCallouts(coins, NOW)) assert.ok(mints.has(c.mint));
  assert.ok(generateTraders(coins).every((t) => t.pnl["1M"] > t.pnl["1D"]));
});

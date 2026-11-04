import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { quoteBuyExactTokens } from "../src/lib/curve";
import { age, compact, countdown, pct, price, usdCompact } from "../src/lib/format";
import { canonicalTicker, nameHashHex, normalizeName, parseTweetId, tweetIdHash } from "../src/lib/launchRules";
import { buildLevels, leafHash, proofFor, rootOf, verifyProof } from "../src/lib/merkle";
import { GRADUATION_RAISE_LAMPORTS, initialReserves, mcapSol, reservesAtSold } from "../src/lib/protocol";
import { quoteBuyWithSol, quoteSellTokens } from "../src/lib/quote";
import { Rng } from "../src/lib/rng";
import { sha256, toHex } from "../src/lib/sha256";

test("sha256 matches node:crypto across block boundaries", () => {
  const rng = new Rng("sha");
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const data = rng.bytes(n);
    assert.equal(toHex(sha256(data)), createHash("sha256").update(data).digest("hex"), `length ${n}`);
  }
});

test("name lock key matches the vectors pinned in state.rs / scripts", () => {
  const PEPECOIN = "cfab0255bde5c58424108384d65d8f8c26d669d50e9a025681c64f5530be395f";
  for (const n of ["Pepe Coin", "PepeCoin", "P.E.P.E-coin", "  pepe coin "]) assert.equal(nameHashHex(n), PEPECOIN, n);
  assert.equal(nameHashHex("🐸🐸"), "8e96e8715e0348cfd35b9fefecef9476eebae0863fd595acfbcd89241c6b4a68");
  assert.equal(nameHashHex("$$$"), "4935926371d1a35cec5c938bd7bd1ccb50bfe845c89e8f6ebfb0709c1b8bd22c");
  const n = normalizeName("P.E.P.E-coin");
  assert.ok(n.ok && n.value.key === "pepecoin" && !n.value.fallback);
  assert.equal(normalizeName("x".repeat(33)).ok, false);
  assert.equal(normalizeName("   ").ok, false);
});

test("ticker and tweet rules match the program", () => {
  assert.deepEqual(canonicalTicker("$pepe"), { ok: true, value: "PEPE" });
  assert.equal(canonicalTicker("TOOLONGTICKER").ok, false);
  assert.equal(canonicalTicker("PE PE").ok, false);
  assert.equal(toHex(tweetIdHash(1_850_000_000_000_000_000n)), "f756d823a024b7f7f6c87021678d1835720f0fba261f26d8bfdf5a0f31925206");
  const id = 1_850_000_000_000_000_000n;
  for (const u of [`https://x.com/a/status/${id}`, `https://twitter.com/a/status/${id}?s=20`, `https://mobile.twitter.com/a/statuses/${id}`, `${id}`]) {
    assert.deepEqual(parseTweetId(u), { ok: true, value: id }, u);
  }
  assert.equal(parseTweetId("0").ok, false);
  assert.equal(parseTweetId("https://x.com/a").ok, false);
});

test("merkle root matches the vector pinned in merkle.rs, and every proof verifies", () => {
  const leaves = [0, 1, 2, 3, 4].map((i) => leafHash(i, new Uint8Array(32).fill(i + 1), BigInt(1000 * (i + 1))));
  const levels = buildLevels(leaves);
  assert.equal(toHex(rootOf(levels)), "8e2f88cdcb92884d2f7366851fa96d7301a484d2407381bc1566a4c5de6f1e7a");
  leaves.forEach((l, i) => assert.ok(verifyProof(proofFor(levels, i), rootOf(levels), l)));
  const k = new PublicKey(new Uint8Array(32).fill(9)).toBytes();
  assert.ok(!verifyProof(proofFor(levels, 1), rootOf(levels), leafHash(1, k, 600n)));
});

test("default curve graduates at ~85 SOL and opens at ~28 SOL market cap", () => {
  assert.equal(GRADUATION_RAISE_LAMPORTS, 85_005_359_057n);
  assert.ok(Math.abs(mcapSol(initialReserves()) - 27.96) < 0.01);
  assert.ok(Math.abs(mcapSol(reservesAtSold(793_100_000_000_000n)) - 410.86) < 0.5);
});

test("buy-with-SOL never spends more than the budget and re-quotes exactly", () => {
  const rng = new Rng("quotes");
  for (let i = 0; i < 300; i++) {
    const r = reservesAtSold(BigInt(Math.floor(rng.range(0, 0.98) * 793.1e12)));
    const budget = BigInt(Math.floor(rng.logRange(1e6, 50e9)));
    const q = quoteBuyWithSol(r, budget, 100n, 200n);
    if (!q) continue;
    assert.ok(q.total <= budget, `total ${q.total} > budget ${budget}`);
    assert.deepEqual(quoteBuyExactTokens(r, q.tokens, 100n).total, q.total);
    assert.equal(q.maxCost, (q.total * 10_200n) / 10_000n);
    assert.ok(q.priceImpact >= 0);
    // Spending most of the budget: one more token's worth would not fit (or the curve is exhausted).
    assert.ok(q.completesCurve || q.total > (budget * 99n) / 100n, `under-spent: ${q.total} of ${budget}`);
  }
});

test("sell quotes subtract the fee and refuse more than the curve holds", () => {
  const r = reservesAtSold(400_000_000_000_000n);
  const q = quoteSellTokens(r, 10_000_000_000_000n, 100n, 100n);
  assert.ok(q && q.solNet === q.solGross - q.fee && q.minOut < q.solNet);
  assert.equal(quoteSellTokens(r, 10n ** 16n, 100n, 100n), null);
});

test("formatting", () => {
  assert.equal(compact(1284), "1,284");
  assert.equal(compact(12_900), "12.9K");
  assert.equal(compact(4_200_000), "4.2M");
  assert.equal(usdCompact(412_300), "$412.3K");
  assert.equal(usdCompact(20_230), "$20.23K");
  assert.equal(usdCompact(104_400_000), "$104.40M");
  assert.equal(price(0.0000912), "$0.0₄9120".replace("9120", "912"));
  assert.equal(price(0.003044), "$0.003044");
  assert.equal(pct(40.675), "+4,067.5%");
  assert.equal(pct(-0.185), "-18.5%");
  assert.equal(age(90_000), "1m");
  assert.equal(age(3 * 86_400_000), "3d");
  assert.equal(countdown(2 * 86_400_000 + 3_723_000), "2d 01:02:03");
});

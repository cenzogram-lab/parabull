import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalTicker, metadataCommitment, nameHash, parseTweetId, tweetIdHash } from "./launch";

test("ticker canonicalisation matches normalize_ticker", () => {
  assert.equal(canonicalTicker("  $pepe "), "PEPE");
  assert.throws(() => canonicalTicker("PE-PE"));
  assert.throws(() => canonicalTicker("РЕРЕ"));
});

test("name lock ignores case, spaces and symbols (vectors pinned in state.rs)", () => {
  const PEPECOIN = "cfab0255bde5c58424108384d65d8f8c26d669d50e9a025681c64f5530be395f";
  for (const n of ["Pepe Coin", "PepeCoin", "P.E.P.E-coin", "  pepe_COIN!! ", "PEPE   coin"]) {
    assert.equal(nameHash(n).toString("hex"), PEPECOIN, n);
  }
  assert.notDeepEqual(nameHash("pepe coins"), nameHash("pepe coin"));
  assert.equal(nameHash("🐸🐸").toString("hex"), "8e96e8715e0348cfd35b9fefecef9476eebae0863fd595acfbcd89241c6b4a68");
  assert.equal(nameHash("$$$").toString("hex"), "4935926371d1a35cec5c938bd7bd1ccb50bfe845c89e8f6ebfb0709c1b8bd22c");
  assert.throws(() => nameHash("   "));
});

test("metadata commitment matches state.rs (computed in Python)", () => {
  assert.equal(
    metadataCommitment("Pepe Coin", "PEPE", "https://arweave.net/pepe.json").toString("hex"),
    "598b8e6319c891e3fc368180564bbd19d787832fac8dc27d3ddcc72590050708",
  );
});

test("tweet hash matches the vector pinned in launch.rs (computed in Python)", () => {
  assert.equal(tweetIdHash(1_850_000_000_000_000_000n).toString("hex"), "f756d823a024b7f7f6c87021678d1835720f0fba261f26d8bfdf5a0f31925206");
  assert.throws(() => tweetIdHash(0n));
});

test("every URL form of one tweet gives the same ID (and so the same lock)", () => {
  const id = 1850000000000000000n;
  for (const u of [
    "1850000000000000000",
    "https://x.com/parabull/status/1850000000000000000",
    "https://twitter.com/parabull/status/1850000000000000000?s=20&t=abc",
    "https://mobile.twitter.com/someone/statuses/1850000000000000000",
    "https://x.com/i/web/status/1850000000000000000",
  ]) {
    assert.equal(parseTweetId(u), id, u);
  }
  assert.throws(() => parseTweetId("https://x.com/parabull"));
});

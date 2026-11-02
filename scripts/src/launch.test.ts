import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalTicker, nameHash, parseTweetId, tweetIdHash } from "./launch";

test("ticker canonicalisation matches normalize_ticker", () => {
  assert.equal(canonicalTicker("  $pepe "), "PEPE");
  assert.throws(() => canonicalTicker("PE-PE"));
  assert.throws(() => canonicalTicker("РЕРЕ"));
});

test("lookalike names hash identically", () => {
  assert.deepEqual(nameHash("Pepe  The\tFrog"), nameHash(" pepe the frog "));
  assert.notDeepEqual(nameHash("pepe the frog"), nameHash("pepe the frogs"));
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

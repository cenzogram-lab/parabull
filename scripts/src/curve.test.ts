import { test } from "node:test";
import assert from "node:assert/strict";
import { Reserves, buyCost, fee, quoteBuyExactTokens, tokensForSol } from "./curve";

// Default curve; expected values are the ones pinned in math.rs unit tests.
const fresh: Reserves = { virtualToken: 1_073_000_000_000_000n, virtualSol: 30_000_000_000n, realToken: 793_100_000_000_000n, realSol: 0n };

test("matches math.rs known values", () => {
  assert.equal(tokensForSol(fresh, 1_000_000_000n), 34_612_903_192_310n);
  assert.equal(buyCost(fresh, fresh.realToken), 85_005_359_057n);
  assert.equal(fee(1n, 100n), 1n);
  assert.equal(fee(1_000_000_000n, 100n), 10_000_000n);
});

test("over-ask partially fills to real reserves", () => {
  const q = quoteBuyExactTokens(fresh, 2n ** 64n - 1n, 100n);
  assert.equal(q.tokensOut, fresh.realToken);
  assert.equal(q.solCost, 85_005_359_057n);
});

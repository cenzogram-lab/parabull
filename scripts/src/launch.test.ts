import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalTicker, nameHash } from "./launch";

test("ticker canonicalisation matches normalize_ticker", () => {
  assert.equal(canonicalTicker("  $pepe "), "PEPE");
  assert.throws(() => canonicalTicker("PE-PE"));
  assert.throws(() => canonicalTicker("РЕРЕ"));
});

test("lookalike names hash identically", () => {
  assert.deepEqual(nameHash("Pepe  The\tFrog"), nameHash(" pepe the frog "));
  assert.notDeepEqual(nameHash("pepe the frog"), nameHash("pepe the frogs"));
});

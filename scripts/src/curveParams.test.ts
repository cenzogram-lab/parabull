import { test } from "node:test";
import assert from "node:assert/strict";
import { MAINNET_CURVE, graduationPreview, resolveCurve, smallCurve } from "./curveParams";

const SOL = 1_000_000_000n;

test("mainnet preview matches the program's numbers", () => {
  const g = graduationPreview(MAINNET_CURVE, 250_000_000n);
  assert.equal(g.raiseLamports, 85_005_359_057n);
  assert.equal(g.marketCapLamports / SOL, 410n);
  assert.ok(g.priceCheckPasses);
});

test("small devnet curve graduates at ~2 SOL and passes the 5% opening-price check", () => {
  const p = smallCurve(2n * SOL, 250_000_000n);
  // Pinned: the Rust runtime test migration_flow::small_devnet_curve_graduates uses these exact values.
  assert.deepEqual(p, {
    initialVirtualTokenReserves: 1_073_000_000_000_000n,
    initialVirtualSolReserves: 705_837_852n,
    initialRealTokenReserves: 793_100_000_000_000n,
    tokenTotalSupply: 974_125_259_823_200n,
  });
  const g = graduationPreview(p, 250_000_000n);
  // Values cross-checked independently in Python. The curve's +1 rounding puts the raise 2 lamports over.
  assert.equal(g.raiseLamports, 2_000_000_002n);
  assert.ok(g.priceCheckPasses);
  // Without the supply adjustment, the mainnet supply would fail the check.
  const naive = graduationPreview({ ...p, tokenTotalSupply: MAINNET_CURVE.tokenTotalSupply }, 250_000_000n);
  assert.equal(naive.priceCheckPasses, false);
});

test("rejects a target at or below the reserve", () => {
  assert.throws(() => smallCurve(250_000_000n, 250_000_000n));
});

test("resolveCurve: preset, explicit and guard rails", () => {
  assert.deepEqual(resolveCurve({}, "devnet").params, MAINNET_CURVE);
  const small = resolveCurve({ CURVE_PRESET: "small" }, "devnet");
  assert.deepEqual(small.params, smallCurve(2n * SOL, 250_000_000n));
  assert.equal(small.migrationReserveLamports, 250_000_000n);
  const five = resolveCurve({ CURVE_PRESET: "small", CURVE_TARGET_SOL: "5", MIGRATION_RESERVE_LAMPORTS: "300000000" }, "devnet");
  assert.equal(graduationPreview(five.params, five.migrationReserveLamports).raiseLamports / SOL, 5n);
  assert.throws(() => resolveCurve({ CURVE_PRESET: "small" }, "mainnet-beta"), /devnet/);
  assert.throws(() => resolveCurve({ CURVE_PRESET: "tiny" }, "devnet"));
  assert.throws(() => resolveCurve({ INITIAL_VIRTUAL_SOL_RESERVES: "1" }, "devnet"), /all of/);
  const explicit = resolveCurve(
    { INITIAL_VIRTUAL_TOKEN_RESERVES: "10", INITIAL_VIRTUAL_SOL_RESERVES: "20", INITIAL_REAL_TOKEN_RESERVES: "5", TOKEN_TOTAL_SUPPLY: "8" },
    "devnet",
  );
  assert.deepEqual(explicit.params, { initialVirtualTokenReserves: 10n, initialVirtualSolReserves: 20n, initialRealTokenReserves: 5n, tokenTotalSupply: 8n });
});

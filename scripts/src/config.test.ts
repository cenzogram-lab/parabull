import { test } from "node:test";
import assert from "node:assert/strict";
import { RAYDIUM, ammConfigPda } from "./config";

test("mainnet AmmConfig index 0 is the canonical 0.25% tier address", () => {
  assert.equal(RAYDIUM["mainnet-beta"].ammConfig.toBase58(), "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
});

test("devnet AmmConfig index 0 is derived under the devnet CPMM program", () => {
  assert.equal(RAYDIUM.devnet.ammConfig.toBase58(), "5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy");
});

test("index is big-endian in the seed (differs from LE for index 1)", () => {
  const p = RAYDIUM["mainnet-beta"].cpmmProgram;
  assert.notEqual(ammConfigPda(p, 1).toBase58(), ammConfigPda(p, 256).toBase58());
});

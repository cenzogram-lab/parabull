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

test("dex target: the listing price in lamports, never above the program's 25 SOL cap", async () => {
  const { dexTargetLamports } = await import("../deploy_and_init");
  const { MAX_DEX_TARGET_LAMPORTS } = await import("./config");
  assert.equal(dexTargetLamports(150), 1_993_333_334n);
  assert.equal(dexTargetLamports(11.96), 25_000_000_000n);
  assert.equal(dexTargetLamports(5), MAX_DEX_TARGET_LAMPORTS, "a crashed SOL price can't produce a target the program refuses");
});

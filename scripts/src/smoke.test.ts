import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { quoteBuyExactTokens } from "./curve";
import { MAINNET_CURVE, smallCurve } from "./curveParams";
import { graduationBuy, smokeOptions, workerLaunchedMint } from "./smoke";

test("smoke options", () => {
  assert.deepEqual(smokeOptions([], {}, "devnet"), { create: true, graduate: false, maxGraduateLamports: 5_000_000_000n });
  assert.deepEqual(smokeOptions(["--no-create"], { GRADUATE: "1", GRADUATE_MAX_SOL: "2.5" }, "devnet"), {
    create: false,
    graduate: true,
    maxGraduateLamports: 2_500_000_000n,
  });
  assert.throws(() => smokeOptions([], { GRADUATE: "1" }, "mainnet-beta"), /refused on mainnet-beta/);
  assert.throws(() => smokeOptions([], { GRADUATE_MAX_SOL: "-1" }, "devnet"), /positive/);
  // --no-create alone is fine on mainnet (it's how the real worker is exercised).
  assert.equal(smokeOptions(["--no-create"], {}, "mainnet-beta").create, false);
});

const fresh = (p: { initialVirtualTokenReserves: bigint; initialVirtualSolReserves: bigint; initialRealTokenReserves: bigint }) => ({
  virtualToken: p.initialVirtualTokenReserves,
  virtualSol: p.initialVirtualSolReserves,
  realToken: p.initialRealTokenReserves,
  realSol: 0n,
});

test("buy-out quote: the small curve fits the default cap, the mainnet curve doesn't", () => {
  const small = fresh(smallCurve(2_000_000_000n, 250_000_000n));
  const b = graduationBuy(small, 100n, 200n, 5_000_000_000n);
  assert.equal(b.tokens, small.realToken, "buys every remaining token");
  assert.equal(b.total, quoteBuyExactTokens(small, small.realToken, 100n).total);
  assert.ok(b.total > 2_000_000_000n && b.total < 2_030_000_000n, `~2 SOL + 1% fee, got ${b.total}`);
  assert.equal(b.maxCost, (b.total * 10_200n) / 10_000n);

  assert.throws(() => graduationBuy(fresh(MAINNET_CURVE), 100n, 200n, 5_000_000_000n), /CURVE_PRESET=small/);
  assert.throws(() => graduationBuy({ ...small, realToken: 0n }, 100n, 200n, 5_000_000_000n), /no tokens left/);
});

test("worker hand-off: a claimed registry since the request means launched; otherwise refunded", () => {
  const mint = Keypair.generate().publicKey;
  assert.equal(workerLaunchedMint({ mint, launchTimestamp: 1_000n }, 990n), mint);
  assert.equal(workerLaunchedMint({ mint, launchTimestamp: 1_000n }, 1_000n), mint);
  assert.equal(workerLaunchedMint({ mint, launchTimestamp: 900n }, 990n), null, "an older launch of the same ticker");
  assert.equal(workerLaunchedMint({ mint: PublicKey.default, launchTimestamp: 0n }, 990n), null);
  assert.equal(workerLaunchedMint(null, 990n), null);
});

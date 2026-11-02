import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { MerkleTree, leafHash, verify } from "./merkle";

test("root matches the vector pinned in programs/parabull/src/merkle.rs", () => {
  const leaves = [0, 1, 2, 3, 4].map((i) => leafHash(i, new PublicKey(Buffer.alloc(32, i + 1)), BigInt(1000 * (i + 1))));
  const t = new MerkleTree(leaves);
  assert.equal(t.root().toString("hex"), "8e2f88cdcb92884d2f7366851fa96d7301a484d2407381bc1566a4c5de6f1e7a");
  leaves.forEach((l, i) => assert.ok(verify(t.proof(i), t.root(), l)));
});

test("tampered leaf fails", () => {
  const k = new PublicKey(Buffer.alloc(32, 9));
  const t = new MerkleTree([leafHash(0, k, 5n), leafHash(1, k, 6n), leafHash(2, k, 7n)]);
  assert.ok(!verify(t.proof(1), t.root(), leafHash(1, k, 600n)));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { leafHash, verify } from "./merkle";
import { MAX_REWARD_LEAVES, aggregateBalances, allocate, buildArtifact, chunk, distributableLamports, isEligibleOwner } from "./snapshot";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const wallet = (lamports = 1) => ({ owner: SystemProgram.programId, executable: false, lamports, data: Buffer.alloc(0) });

test("aggregates per owner, drops zeros, sorts deterministically", () => {
  const [a, b, c] = [key(1), key(2), key(3)];
  const h = aggregateBalances([
    { owner: a, amount: 5n },
    { owner: b, amount: 7n },
    { owner: a, amount: 4n },
    { owner: c, amount: 0n },
  ]);
  assert.deepEqual(h.map((x) => [x.owner.toBase58(), x.balance]), [
    [a.toBase58(), 9n],
    [b.toBase58(), 7n],
  ]);
});

test("eligibility: only payable system wallets, minus exclusions", () => {
  const user = Keypair.generate().publicKey; // on-curve
  const pda = PublicKey.findProgramAddressSync([Buffer.from("x")], SystemProgram.programId)[0]; // off-curve
  const none = new Set<string>();
  assert.ok(isEligibleOwner(user, { account: wallet(), onCurve: true }, none));
  assert.ok(isEligibleOwner(user, { account: null, onCurve: true }, none), "fresh wallet with no account yet");
  assert.ok(!isEligibleOwner(user, { account: { ...wallet(), owner: new PublicKey(Buffer.alloc(32, 7)) }, onCurve: true }, none), "program-owned (pool vault owner, curve, ...)");
  assert.ok(!isEligibleOwner(user, { account: { ...wallet(), executable: true }, onCurve: true }, none), "executable");
  assert.ok(!isEligibleOwner(user, { account: { ...wallet(), data: Buffer.alloc(8) }, onCurve: true }, none), "has data");
  assert.ok(!isEligibleOwner(pda, { account: null, onCurve: false }, none), "empty off-curve authority (e.g. CPMM vault authority)");
  assert.ok(isEligibleOwner(pda, { account: wallet(5), onCurve: false }, none), "funded off-curve system account (e.g. a multisig vault)");
  assert.ok(!isEligibleOwner(user, { account: wallet(), onCurve: true }, new Set([user.toBase58()])), "explicitly excluded");
});

test("distributable respects rent and outstanding commitments", () => {
  assert.equal(distributableLamports(10_000n, 1_000n, 4_000n), 5_000n);
  assert.equal(distributableLamports(10_000n, 1_000n, 4_000n, 5_000n), 2_500n);
  assert.equal(distributableLamports(1_000n, 1_000n, 0n), 0n);
  assert.equal(distributableLamports(1_000n, 1_200n, 0n), 0n, "never negative");
});

test("pro-rata allocation never exceeds the pool and drops dust", () => {
  const holders = [
    { owner: key(1), balance: 600n },
    { owner: key(2), balance: 300n },
    { owner: key(3), balance: 99n },
    { owner: key(4), balance: 1n },
  ];
  const e = allocate(holders, 1_000_000n, 1_000n);
  assert.deepEqual(e.map((x) => x.amount), [600_000n, 300_000n, 99_000n, 1_000n], "the 1/1000 holder gets exactly the 1000 minimum: kept");
  const e2 = allocate(holders, 1_000_000n, 1_001n);
  assert.equal(e2.length, 3, "below the minimum payout is dropped");
  const odd = allocate([{ owner: key(1), balance: 1n }, { owner: key(2), balance: 1n }, { owner: key(3), balance: 1n }], 100n, 1n);
  assert.deepEqual(odd.map((x) => x.amount), [33n, 33n, 33n]);
  assert.ok(odd.reduce((s, x) => s + x.amount, 0n) <= 100n);
  assert.deepEqual(allocate([], 100n, 1n), []);
  assert.deepEqual(allocate(holders, 0n, 1n), []);
});

test("random allocations: total <= distributable, proportional within 1 lamport", () => {
  for (let r = 0; r < 200; r++) {
    const n = 1 + (r % 37);
    const holders = Array.from({ length: n }, (_, i) => ({ owner: key((i % 250) + 1), balance: BigInt(1 + ((i * 7919 + r * 104729) % 1_000_000)) }));
    const pool = BigInt(1 + ((r * 2654435761) % 10_000_000_000));
    const supply = holders.reduce((s, h) => s + h.balance, 0n);
    const e = allocate(holders, pool, 0n);
    const total = e.reduce((s, x) => s + x.amount, 0n);
    assert.ok(total <= pool);
    e.forEach((x, i) => {
      const exact = (pool * holders.find((h) => h.owner.equals(x.claimant))!.balance) / supply;
      assert.equal(x.amount, exact);
      void i;
    });
  }
});

test("chunking respects the on-chain leaf limit", () => {
  const items = Array.from({ length: MAX_REWARD_LEAVES * 2 + 5 }, (_, i) => i);
  const parts = chunk(items, MAX_REWARD_LEAVES);
  assert.deepEqual(parts.map((p) => p.length), [MAX_REWARD_LEAVES, MAX_REWARD_LEAVES, 5]);
});

test("artifact: every proof verifies against the root and matches the on-chain leaf format", () => {
  const entries = Array.from({ length: 13 }, (_, i) => ({ claimant: key(i + 1), amount: BigInt(1_000 * (i + 1)) }));
  const balances = new Map(entries.map((e) => [e.claimant.toBase58(), e.amount * 10n]));
  const { artifact, root, total } = buildArtifact(7, entries, balances, { snapshotSlot: 42, parabullMint: key(99) });
  assert.equal(artifact.epoch, 7);
  assert.equal(artifact.numLeaves, 13);
  assert.equal(total, entries.reduce((s, e) => s + e.amount, 0n));
  assert.equal(artifact.root, root.toString("hex"));
  for (const l of artifact.leaves) {
    const leaf = leafHash(l.index, new PublicKey(l.claimant), BigInt(l.amount));
    assert.ok(verify(l.proof.map((p) => Buffer.from(p, "hex")), root, leaf));
  }
  assert.throws(() => buildArtifact(0, [], balances, { snapshotSlot: 0, parabullMint: key(1) }));
});

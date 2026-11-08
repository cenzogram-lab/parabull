import { test } from "node:test";
import assert from "node:assert/strict";
import { AnchorProvider, BorshCoder, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemInstruction, SystemProgram } from "@solana/web3.js";
import type { Parabull } from "../../target/types/parabull";
import type { CalloutJson } from "../../app/src/lib/callouts";
import { leafHash as appLeafHash, verifyProof } from "../../app/src/lib/merkle";
import { DEFAULT_RULES, allocateCallers, attribute, buildCallerArtifact, loadReferrals, parseTime, publishInstructions, type ReferralEvent } from "./callerEpoch";
import { Pdas } from "./pdas";
import { loadIdl } from "./program";

const key = () => Keypair.generate().publicKey.toBase58();
const [CALLER_A, CALLER_B, T1, T2, T3] = [key(), key(), key(), key(), key()].sort();
const MINT = key();
const OTHER_MINT = key();
const SOL = 1_000_000_000n;

const callout = (id: string, wallet: string, ts = 1_000_000): CalloutJson => ({ id, wallet, mint: MINT, text: "x", calledAtMcapSol: 30, calledAtPriceSol: 3e-8, holding: "1000000", ts });
let n = 0;
const ev = (calloutId: string, trader: string, sol: bigint, o: Partial<ReferralEvent> = {}): ReferralEvent => ({ calloutId, signature: `sig${++n}`, index: 0, mint: MINT, trader, solLamports: sol.toString(), feeLamports: (sol / 100n).toString(), tokenAmount: "1", slot: n, timestamp: 2_000, ...o });

test("caller epoch: only buys a callout really brought in count (coin, timing, size, no self-referral), capped per trader", () => {
  const callouts = new Map([
    ["AAAAAAAAAAAA", callout("AAAAAAAAAAAA", CALLER_A)],
    ["BBBBBBBBBBBB", callout("BBBBBBBBBBBB", CALLER_B)],
  ]);
  const events = [
    ev("AAAAAAAAAAAA", T1, 2n * SOL),
    ev("AAAAAAAAAAAA", T1, 12n * SOL), // T1's total for A is capped at 10 SOL
    ev("AAAAAAAAAAAA", T2, 1n * SOL),
    ev("BBBBBBBBBBBB", T3, 3n * SOL),
    ev("AAAAAAAAAAAA", CALLER_A, 5n * SOL), // self-referral
    ev("AAAAAAAAAAAA", T3, 1n * SOL, { mint: OTHER_MINT }), // another coin
    ev("BBBBBBBBBBBB", T2, 1n * SOL, { timestamp: 999 }), // before the callout (ts 1_000_000 ms = 1000 s)
    ev("BBBBBBBBBBBB", T2, 49_999_999n), // under 0.05 SOL
    ev("ZZZZZZZZZZZZ", T2, 1n * SOL), // unknown callout
  ];
  events.push({ ...events[0] }); // the same buy twice
  const { callers, dropped } = attribute(events, callouts, DEFAULT_RULES);
  assert.deepEqual(dropped, { unknown_callout: 1, other_coin: 1, self_referral: 1, before_callout: 1, too_small: 1 });
  assert.deepEqual(
    callers.map((c) => [c.caller, c.countedLamports, c.volumeLamports, c.feeLamports, c.buys, c.traders, c.callouts]),
    [
      [CALLER_A, 11n * SOL, 15n * SOL, 15n * SOL / 100n, 3, 2, ["AAAAAAAAAAAA"]],
      [CALLER_B, 3n * SOL, 3n * SOL, 3n * SOL / 100n, 1, 1, ["BBBBBBBBBBBB"]],
    ],
  );
});

test("caller epoch: the budget is split by counted volume, floored and capped, never over the budget", () => {
  const stats = (caller: string, counted: bigint) => ({ caller, countedLamports: counted, volumeLamports: counted, feeLamports: 0n, buys: 1, traders: 1, callouts: [] });
  const rules = { ...DEFAULT_RULES, maxCallerShareBps: 10_000n };
  // 3:1, a 1 SOL budget: 0.75 and 0.25 SOL.
  assert.deepEqual(allocateCallers([stats(CALLER_A, 3n), stats(CALLER_B, 1n)], SOL, rules), [
    { caller: CALLER_A, amount: 750_000_000n },
    { caller: CALLER_B, amount: 250_000_000n },
  ]);
  // Rounding down: three equal callers share 100 lamports as 33 each.
  const three = allocateCallers([stats(T1, 1n), stats(T2, 1n), stats(T3, 1n)], 100n, { ...rules, minPayoutLamports: 1n });
  assert.deepEqual(three.map((x) => x.amount), [33n, 33n, 33n]);
  // The 25% cap: the big caller gets 0.25 SOL, not 0.75; the rest stays with the treasury.
  const capped = allocateCallers([stats(CALLER_A, 3n), stats(CALLER_B, 1n)], SOL, DEFAULT_RULES);
  assert.deepEqual(capped.map((x) => x.amount), [250_000_000n, 250_000_000n]);
  // Dust under the minimum payout is dropped.
  assert.deepEqual(allocateCallers([stats(CALLER_A, 1_000_000n), stats(CALLER_B, 1n)], SOL, rules).map((x) => x.caller), [CALLER_A]);
  assert.deepEqual(allocateCallers([], SOL, rules), []);
});

test("caller epoch: the artifact's proofs verify with the app's and indexer's Merkle code too", () => {
  const payouts = [
    { caller: CALLER_A, amount: 700n },
    { caller: CALLER_B, amount: 300n },
    { caller: T1, amount: 5n },
  ];
  const stats = new Map(payouts.map((p) => [p.caller, { caller: p.caller, countedLamports: p.amount, volumeLamports: p.amount, feeLamports: 0n, buys: 2, traders: 1, callouts: ["AAAAAAAAAAAA"] }]));
  const funder = Keypair.generate().publicKey;
  const { artifact, root, total } = buildCallerArtifact(9, payouts, stats, { snapshotSlot: 42, window: { since: 1, until: 2 }, rules: DEFAULT_RULES, dropped: { unknown_callout: 0, other_coin: 0, self_referral: 2, before_callout: 0, too_small: 0 }, funder, now: new Date(0) });
  assert.deepEqual([artifact.epoch, artifact.kind, artifact.totalLamports, artifact.numLeaves, total], [9, "caller", "1005", 3, 1005n]);
  assert.equal(artifact.root, root.toString("hex"));
  assert.equal(artifact.funder, funder.toBase58());
  assert.equal(artifact.dropped.self_referral, 2);
  for (const l of artifact.leaves) {
    const ok = verifyProof(l.proof.map((h) => Uint8Array.from(Buffer.from(h, "hex"))), Uint8Array.from(root), appLeafHash(l.index, new PublicKey(l.claimant).toBytes(), BigInt(l.amount)));
    assert.ok(ok, `leaf ${l.index}`);
  }
  assert.throws(() => buildCallerArtifact(9, [], stats, { snapshotSlot: 1, window: { since: 1, until: 2 }, rules: DEFAULT_RULES, dropped: artifact.dropped, funder }), /1\.\./);
});

test("caller epoch: one transaction, the treasury's top-up first and then publish_reward_epoch", async () => {
  const program = new Program<Parabull>(loadIdl(), new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(Keypair.generate()), {}));
  const pdas = new Pdas(program.programId);
  const funder = Keypair.generate().publicKey;
  const crank = Keypair.generate().publicKey;
  const root = Buffer.alloc(32, 7);
  const ixs = await publishInstructions(program, pdas, { funder, crank, epoch: 5, root, total: 1_234n, numLeaves: 3, snapshotSlot: 99 });
  assert.equal(ixs.length, 2);
  assert.ok(ixs[0].programId.equals(SystemProgram.programId));
  const t = SystemInstruction.decodeTransfer(ixs[0]);
  assert.ok(t.fromPubkey.equals(funder) && t.toPubkey.equals(pdas.holderVault()));
  assert.equal(t.lamports, 1_234n);
  assert.ok(ixs[1].programId.equals(program.programId));
  const d = (program.coder as BorshCoder).instruction.decode(ixs[1].data)!;
  const args = d.data as { merkleRoot: number[]; totalLamports: { toString(): string }; numLeaves: number; snapshotSlot: { toString(): string } };
  assert.deepEqual([d.name, Buffer.from(args.merkleRoot).equals(root), args.totalLamports.toString(), args.numLeaves, args.snapshotSlot.toString()], ["publishRewardEpoch", true, "1234", 3, "99"]);
  const keys = ixs[1].keys.map((k) => k.pubkey.toBase58());
  assert.ok(keys.includes(pdas.rewardEpoch(5).toBase58()) && keys.includes(pdas.holderVault().toBase58()));
  assert.ok(ixs[1].keys.find((k) => k.pubkey.equals(crank))!.isSigner, "the crank signs publish");
});

test("caller epoch: referrals are read page by page and refused when the indexer's record starts after the window", async () => {
  const calls: { url: string; origin: string | null }[] = [];
  const pages: Record<string, unknown> = {
    "0": { events: [ev("AAAAAAAAAAAA", T1, SOL)], next: "1", coveredFrom: null },
    "1": { events: [ev("BBBBBBBBBBBB", T2, SOL)], next: null, coveredFrom: null },
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const origin = new Headers(init?.headers).get("origin");
    calls.push({ url, origin });
    const u = new URL(url);
    if (u.pathname === "/referrals") return Response.json(pages[u.searchParams.get("cursor")!]);
    if (u.pathname === "/callouts") return Response.json({ callouts: u.searchParams.get("ids")!.split(",").map((id) => callout(id, CALLER_A)) });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const o = { since: 100, until: 200, indexerUrl: "https://ix.test", edgeUrl: "https://edge.test", calloutsOrigin: "https://app.test", fetchImpl };
  const { events, callouts } = await loadReferrals(o);
  assert.equal(events.length, 2);
  assert.deepEqual([...callouts.keys()].sort(), ["AAAAAAAAAAAA", "BBBBBBBBBBBB"]);
  assert.deepEqual(calls.map((c) => c.url), [
    "https://ix.test/referrals?since=100&until=200&limit=5000&cursor=0",
    "https://ix.test/referrals?since=100&until=200&limit=5000&cursor=1",
    "https://edge.test/callouts?ids=AAAAAAAAAAAA,BBBBBBBBBBBB&limit=100",
  ]);
  assert.equal(calls[2].origin, "https://app.test", "the Worker only answers the app's origin");
  pages["0"] = { events: [], next: null, coveredFrom: 150 };
  await assert.rejects(loadReferrals(o), /starts at .* after the window's start/);
  pages["0"] = { events: [], next: null, coveredFrom: 100 };
  assert.deepEqual((await loadReferrals(o)).events, [], "complete from exactly `since` is fine");
});

test("caller epoch: dates and unix times", () => {
  assert.equal(parseTime("2026-11-01"), Date.UTC(2026, 10, 1) / 1000);
  assert.equal(parseTime("2026-11-01T12:00:00Z"), Date.UTC(2026, 10, 1, 12) / 1000);
  assert.equal(parseTime("1793491200"), 1_793_491_200);
  assert.throws(() => parseTime("soon"), /not a date/);
});

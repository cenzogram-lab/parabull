import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { base58Decode } from "../../../app/src/lib/chatMessage";
import { refMemo } from "../../../app/src/lib/callouts";
import { leafHash, verifyProof } from "../../../app/src/lib/merkle";
import { Api } from "./api";
import { Indexer } from "./indexer";
import { MockChain, addressOf } from "./mockChain";
import { verifyArtifact } from "./rewards";
import { Rpc } from "./rpc";

const ALICE = addressOf("alice");
const BOB = addressOf("bob");
const CAROL = addressOf("carol");
const BASE = "https://rewards.test/snapshots";

/** A chain, an indexer reading artifacts from `files` (url -> JSON; absent = 404), and its API. */
async function setup(t: TestContext) {
  const chain = new MockChain();
  await chain.initGlobal();
  const files = new Map<string, unknown>();
  const fetched: string[] = [];
  const fetchImpl = async (url: string) => {
    fetched.push(url);
    return files.has(url) ? new Response(JSON.stringify(files.get(url))) : new Response("missing", { status: 404 });
  };
  let now = chain.time * 1000;
  const ix = new Indexer({ rpc: new Rpc("http://rpc.test", chain.fetch, 2_000), now: () => now, rewardsBaseUrl: `${BASE}/`, fetchImpl });
  const api = new Api(ix);
  const server: Server = api.attach(createServer());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    api.closeStreams();
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { chain, ix, files, fetched, get, clock: { advance: (ms: number) => (now += ms) } };
}

test("rewards: allocations come from verified artifacts, with proofs from the indexer's own tree and claims from the bitmap", async (t) => {
  const s = await setup(t);
  const holder = await s.chain.publishEpoch([{ claimant: ALICE, amount: 700n }, { claimant: BOB, amount: 200n }, { claimant: CAROL, amount: 100n }], "holder");
  const caller = await s.chain.publishEpoch([{ claimant: BOB, amount: 50_000n }], "caller");
  // The proofs in the file are wrong on purpose: the indexer must not serve them.
  s.files.set(`${BASE}/epoch-1.json`, { ...holder.artifact, leaves: holder.artifact.leaves.map((l) => ({ ...l, proof: ["00".repeat(32)] })) });
  s.files.set(`${BASE}/epoch-2.json`, caller.artifact);
  await s.ix.start();

  const bob = (await s.get(`/rewards/${BOB}`)).body;
  assert.deepEqual(bob.allocations.map((a: any) => [a.epoch, a.kind, a.index, a.amount, a.claimed, a.claimable]), [
    [2, "caller", 0, "50000", false, true],
    [1, "holder", 1, "200", false, true],
  ]);
  assert.equal(bob.unclaimedLamports, "50200");
  assert.deepEqual(bob.unverifiedEpochs, []);
  for (const a of bob.allocations) {
    const proof = (a.proof as string[]).map((h) => Uint8Array.from(Buffer.from(h, "hex")));
    assert.ok(verifyProof(proof, Uint8Array.from(Buffer.from(a.root, "hex")), leafHash(a.index, base58Decode(BOB)!, BigInt(a.amount))), `epoch ${a.epoch} proof verifies`);
  }
  assert.equal(bob.allocations[1].root, Buffer.from(holder.root).toString("hex"));

  // A claim (seen in the logs) shows at once; the next sync reads the same from the account.
  await s.chain.claimReward(1, 1, BOB, 200n);
  await s.ix.pollTransactions();
  assert.deepEqual((await s.get(`/rewards/${BOB}`)).body.allocations.map((a: any) => [a.epoch, a.claimed, a.claimable]), [[2, false, true], [1, true, false]]);
  await s.ix.syncRewards();
  assert.equal(s.ix.rewards.epochs.get(1)!.claimedLamports, 200n);

  const summary = (await s.get("/rewards")).body;
  assert.deepEqual(summary.totals, { holder: { epochs: 1, lamports: "1000", allocations: 3 }, caller: { epochs: 1, lamports: "50000", allocations: 1 } });
  assert.deepEqual(summary.epochs.map((e: any) => [e.epoch, e.kind, e.artifact, e.claimedCount]), [[2, "caller", "verified", 0], [1, "holder", "verified", 1]]);
  assert.equal(summary.vault.nextEpoch, 3);
  assert.equal((await s.get("/rewards/nope")).status, 400);
  assert.deepEqual((await s.get(`/rewards/${addressOf("nobody")}`)).body.allocations, []);
});

test("rewards: a file that doesn't rebuild the on-chain root serves nothing; a missing one is retried later", async (t) => {
  const s = await setup(t);
  const e1 = await s.chain.publishEpoch([{ claimant: ALICE, amount: 600n }, { claimant: BOB, amount: 400n }]);
  const e2 = await s.chain.publishEpoch([{ claimant: ALICE, amount: 5n }]);
  // Epoch 1's file moves 100 lamports from Bob to Alice: same total, different leaves.
  const tampered = { ...e1.artifact, leaves: [{ ...e1.artifact.leaves[0], amount: "700" }, { ...e1.artifact.leaves[1], amount: "300" }] };
  s.files.set(`${BASE}/epoch-1.json`, tampered);
  await s.ix.start();
  const alice = (await s.get(`/rewards/${ALICE}`)).body;
  assert.deepEqual(alice.allocations, []);
  assert.deepEqual(alice.unverifiedEpochs, [2, 1]);
  assert.deepEqual(s.ix.rewards.artifactState(1), { state: "mismatch", kind: null, error: "leaves don't rebuild the on-chain root" });
  assert.equal(s.ix.rewards.artifactState(2)!.state, "missing");
  // A mismatch is final; a missing file is asked for again once its back-off has passed.
  s.files.set(`${BASE}/epoch-1.json`, e1.artifact);
  s.files.set(`${BASE}/epoch-2.json`, e2.artifact);
  const before = s.fetched.length;
  await s.ix.loadArtifacts();
  assert.equal(s.fetched.length, before, "not before the back-off");
  s.clock.advance(31_000);
  await s.ix.loadArtifacts();
  assert.deepEqual(s.fetched.slice(before), [`${BASE}/epoch-2.json`]);
  assert.deepEqual((await s.get(`/rewards/${ALICE}`)).body.allocations.map((a: any) => a.epoch), [2]);
});

test("rewards: an expired epoch lists its allocation without a proof; publishing is picked up from the event", async (t) => {
  const s = await setup(t);
  await s.ix.start();
  const e = await s.chain.publishEpoch([{ claimant: CAROL, amount: 9n }, { claimant: BOB, amount: 1n }]);
  s.files.set(`${BASE}/epoch-1.json`, e.artifact);
  await s.ix.pollTransactions();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await s.get(`/rewards/${CAROL}`)).body.allocations[0]?.claimable, true, "found from RewardEpochPublished, no sync needed");
  await s.chain.expireEpoch(1);
  await s.ix.pollTransactions();
  await new Promise((r) => setTimeout(r, 20));
  const [a] = (await s.get(`/rewards/${CAROL}`)).body.allocations;
  assert.deepEqual([a.expired, a.proof, a.claimable, a.claimed], [true, null, false, false]);
  assert.equal((await s.get(`/rewards/${CAROL}`)).body.unclaimedLamports, "0");
});

test("rewards: verifyArtifact checks the epoch, the counts, each leaf and the total", () => {
  const on = { epoch: 3, root: new Uint8Array(32), totalLamports: 10n, numLeaves: 1 };
  const leaf = { index: 0, claimant: ALICE, amount: "10" };
  const art = (over: object) => ({ epoch: 3, root: "00".repeat(32), totalLamports: "10", numLeaves: 1, leaves: [leaf], ...over });
  assert.match((verifyArtifact(art({ epoch: 4 }), on) as { error: string }).error, /epoch/);
  assert.match((verifyArtifact(art({ root: "11".repeat(32) }), on) as { error: string }).error, /root/);
  assert.match((verifyArtifact(art({ totalLamports: "11" }), on) as { error: string }).error, /total/);
  assert.match((verifyArtifact(art({ leaves: [] }), on) as { error: string }).error, /numLeaves/);
  assert.match((verifyArtifact(art({ leaves: [{ ...leaf, index: 1 }] }), on) as { error: string }).error, /leaf 0/);
  assert.match((verifyArtifact(art({ leaves: [{ ...leaf, claimant: "x" }] }), on) as { error: string }).error, /leaf 0/);
  assert.match((verifyArtifact(art({ leaves: [{ ...leaf, amount: "0" }] }), on) as { error: string }).error, /leaf 0/);
  assert.match((verifyArtifact(null, on) as { error: string }).error, /epoch/);
  // Everything matches but the root: the rebuilt tree decides.
  assert.match((verifyArtifact(art({}), on) as { error: string }).error, /rebuild/);
});

test("referrals API: per callout and by window, with coverage", async (t) => {
  const s = await setup(t);
  const ticket = s.chain.requestLaunch(ALICE, "API", 1n);
  const mint = addressOf("mint:API");
  await s.chain.create(ticket, { mint, name: "Api", symbol: "API", uri: "" });
  await s.chain.trade(mint, BOB, true, 2_000_000_000_000n, { memo: refMemo("AbCdEfGhJkLm") });
  await s.chain.trade(mint, CAROL, true, 1_000_000_000_000n, { memo: refMemo("AbCdEfGhJkLm") });
  await s.ix.start();
  const one = (await s.get("/referrals/AbCdEfGhJkLm")).body;
  assert.deepEqual([one.buys, one.traders, one.byTrader.length], [2, 2, 2]);
  assert.equal((await s.get("/referrals/ZyXwVuTsRqPn")).body.buys, 0);
  assert.equal((await s.get("/referrals/bad")).status, 400);
  const w = (await s.get("/referrals?limit=1")).body;
  assert.deepEqual([w.events.length, w.next, w.coveredFrom], [1, "1", null]);
  assert.equal(w.events[0].trader, BOB);
  assert.equal(typeof w.events[0].solLamports, "string");
  assert.deepEqual((await s.get("/referrals?cursor=1")).body.events.map((e: any) => e.trader), [CAROL]);
  assert.deepEqual((await s.get(`/referrals?since=${s.chain.time + 1}`)).body.events, []);
  for (const q of ["since=-1", "until=x", "cursor=-2", "limit=0"]) assert.equal((await s.get(`/referrals?${q}`)).status, 400, q);
});

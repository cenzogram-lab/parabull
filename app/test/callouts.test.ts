import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnchorProvider, Program, type Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import idlJson from "../src/idl/parabull.json";
import type { Parabull } from "../src/idl/parabull";
import { buyMethod } from "../src/lib/buy";
import { chatEndpoints } from "../src/lib/chatClient";
import { REFERRAL_TTL_MS, refMemo, type CalloutJson } from "../src/lib/callouts";
import { byCalloutResult, calloutMove, mergeCallouts, toCallout } from "../src/lib/calloutsClient";
import { buildLevels, leafHash, proofFor, rootOf } from "../src/lib/merkle";
import { ata2022, ASSOCIATED_TOKEN_PROGRAM_ID, Pdas, TOKEN_2022_PROGRAM_ID } from "../src/lib/pdas";
import { MEMO_PROGRAM_ID, referralFor, refMemoInstruction, rememberReferral, type KeyValue } from "../src/lib/referral";
import { bytesToHex, checkBeforeClaim, claimRows, proofMatches, type AllocationJson } from "../src/lib/rewardsClaim";
import type { Callout, Coin } from "../src/lib/types";

const MINT = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const AUTHOR = Keypair.generate().publicKey.toBase58();
const BUYER = Keypair.generate().publicKey.toBase58();
const ID = "AbCdEfGhJkLm";

function memoryStore(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

test("referral: a followed link tags buys of its coin for a day, never the author's own", () => {
  const store = memoryStore();
  const at = 1_800_000_000_000;
  rememberReferral({ calloutId: ID, mint: MINT, author: AUTHOR, at }, store);
  assert.deepEqual(referralFor(MINT, BUYER, at + 1, store), { calloutId: ID, mint: MINT, author: AUTHOR, at });
  assert.equal(referralFor(MINT, null, at + 1, store)?.calloutId, ID, "before a wallet connects");
  assert.equal(referralFor(OTHER, BUYER, at + 1, store), null, "only that coin");
  assert.equal(referralFor(MINT, AUTHOR, at + 1, store), null, "no self-referral");
  assert.equal(referralFor(MINT, BUYER, at + REFERRAL_TTL_MS, store), null, "expires");
  // The latest link for a coin wins; other coins' links are kept.
  rememberReferral({ calloutId: "ZyXwVuTsRqPn", mint: OTHER, author: AUTHOR, at }, store);
  rememberReferral({ calloutId: "NpQrStUvWxYz", mint: MINT, author: BUYER, at: at + 5 }, store);
  assert.equal(referralFor(MINT, AUTHOR, at + 6, store)?.calloutId, "NpQrStUvWxYz");
  assert.equal(referralFor(OTHER, BUYER, at + 6, store)?.calloutId, "ZyXwVuTsRqPn");
  // Garbage in storage, or storage that throws, is just no referral.
  store.data.set("parabull:referrals", "{not json");
  assert.equal(referralFor(MINT, BUYER, at, store), null);
  const broken: KeyValue = { get: () => { throw new Error("denied"); }, set: () => { throw new Error("denied"); } };
  assert.doesNotThrow(() => rememberReferral({ calloutId: ID, mint: MINT, author: AUTHOR, at }, broken));
  assert.equal(referralFor(MINT, BUYER, at, broken), null);
});

test("referral: the memo instruction is SPL Memo v2 with the referral text and no accounts", () => {
  const ix = refMemoInstruction(ID);
  assert.ok(ix.programId.equals(new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")));
  assert.ok(ix.programId.equals(MEMO_PROGRAM_ID));
  assert.deepEqual(ix.keys, []);
  assert.equal(Buffer.from(ix.data).toString("utf8"), `parabull:ref:${ID}`);
  assert.equal(refMemo(ID), `parabull:ref:${ID}`);
  assert.throws(() => refMemoInstruction("not-an-id"), /callout id/);
});

test("buy: a referral adds the memo after `buy`, at the top level; without one the buy is unchanged", async () => {
  const wallet = { publicKey: Keypair.generate().publicKey } as unknown as Wallet;
  const program = new Program<Parabull>(idlJson as unknown as Parabull, new AnchorProvider(new Connection("http://127.0.0.1:1"), wallet, {}));
  const pdas = new Pdas(program.programId);
  const mint = new PublicKey(MINT);
  const user = wallet.publicKey;
  const curve = pdas.bondingCurve(mint);
  const accounts = { user, global: pdas.global(), mint, bondingCurve: curve, curveTokenAccount: ata2022(mint, curve), userTokenAccount: ata2022(mint, user), tokenProgram: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId };
  // Anchor's BN is bn.js; Node's ESM loader doesn't see Anchor's named BN export, so take bn.js itself.
  const BN = createRequire(import.meta.url)("bn.js") as typeof import("@coral-xyz/anchor").BN;
  const tagged = await buyMethod(program, accounts, new BN(1_000), new BN(2_000), ID).transaction();
  assert.deepEqual(tagged.instructions.map((i) => i.programId.toBase58()), [program.programId.toBase58(), MEMO_PROGRAM_ID.toBase58()]);
  assert.equal(Buffer.from(tagged.instructions[1].data).toString(), `parabull:ref:${ID}`);
  const plain = await buyMethod(program, accounts, new BN(1_000), new BN(2_000), null).transaction();
  assert.deepEqual(plain.instructions.map((i) => i.programId.toBase58()), [program.programId.toBase58()]);
  assert.deepEqual(plain.instructions[0].data, tagged.instructions[0].data, "the buy itself is the same");
});

const coin = (mcapUsd: number) => ({ mint: MINT, mcapUsd }) as Coin;
const json = (over: Partial<CalloutJson> = {}): CalloutJson => ({ id: ID, wallet: AUTHOR, mint: MINT, text: "to the moon", calledAtMcapSol: 40, calledAtPriceSol: 4e-8, holding: "1000000", ts: 1_000, ...over });

test("callouts client: the Worker's JSON as the views' Callout; merging, the move since the call and the best-first order", () => {
  const c = toCallout(json(), 150);
  assert.deepEqual(c, { id: ID, handle: `${AUTHOR.slice(0, 4)}…${AUTHOR.slice(-4)}`, wallet: AUTHOR, text: "to the moon", mint: MINT, calledAtMcap: 6_000, ts: 1_000, position: null, engagement: null });
  assert.equal(calloutMove(c, coin(9_000)), 0.5);
  assert.equal(calloutMove({ calledAtMcap: 0 }, coin(9_000)), 0);
  const merged = mergeCallouts([json({ id: "AAAAAAAAAAAA", ts: 1 }), json({ id: "BBBBBBBBBBBB", ts: 3 })], [json({ id: "AAAAAAAAAAAA", ts: 1, text: "edited" }), json({ id: "CCCCCCCCCCCC", ts: 2 })]);
  assert.deepEqual(merged.map((x) => [x.id, x.text]), [["BBBBBBBBBBBB", "to the moon"], ["CCCCCCCCCCCC", "to the moon"], ["AAAAAAAAAAAA", "edited"]]);
  const byMint = new Map([[MINT, coin(9_000)]]);
  const a: Callout = { ...c, id: "a", calledAtMcap: 3_000 }; // +200%
  const b: Callout = { ...c, id: "b", calledAtMcap: 6_000 }; // +50%
  const orphan: Callout = { ...c, id: "o", mint: OTHER };
  assert.deepEqual([orphan, b, a].sort(byCalloutResult(byMint)).map((x) => x.id), ["a", "b", "o"]);
  assert.equal(chatEndpoints("wss://edge.parabull.test/chat")!.callouts, "https://edge.parabull.test/callouts");
});

test("claims: checked against the epoch account itself before anything is sent", () => {
  const wallet = Keypair.generate().publicKey.toBytes();
  const leaves = [leafHash(0, Keypair.generate().publicKey.toBytes(), 5n), leafHash(1, wallet, 700n), leafHash(2, Keypair.generate().publicKey.toBytes(), 1n)];
  const levels = buildLevels(leaves);
  const root = rootOf(levels);
  const a: AllocationJson = { epoch: 4, kind: "caller", index: 1, amount: "700", proof: proofFor(levels, 1).map(bytesToHex), root: bytesToHex(root), claimed: false, expired: false, claimable: true, publishedAt: 1, expiresAt: 2, totalLamports: "706", numLeaves: 3 };
  const onChain = { merkleRoot: Array.from(root), numLeaves: 3, expired: false, claimedBitmap: new Uint8Array(1) };
  assert.equal(proofMatches(a, wallet), true);
  assert.equal(checkBeforeClaim(onChain, wallet, a), null);
  assert.match(checkBeforeClaim(null, wallet, a)!, /isn't on-chain/);
  assert.match(checkBeforeClaim({ ...onChain, expired: true }, wallet, a)!, /expired/);
  assert.equal(checkBeforeClaim({ ...onChain, merkleRoot: new Array(32).fill(1) }, wallet, a), "The indexer's root doesn't match the on-chain root");
  assert.match(checkBeforeClaim({ ...onChain, claimedBitmap: Uint8Array.of(0b10) }, wallet, a)!, /Already claimed/);
  assert.equal(checkBeforeClaim({ ...onChain, claimedBitmap: Uint8Array.of(0b101) }, wallet, a), null, "other leaves' bits don't matter");
  assert.match(checkBeforeClaim(onChain, wallet, { ...a, proof: null })!, /No proof/);
  assert.match(checkBeforeClaim(onChain, wallet, { ...a, index: 7 })!, /outside/);
  // Same root, but the amount (or the wallet) isn't the leaf's: the proof doesn't lead to the root.
  assert.match(checkBeforeClaim(onChain, wallet, { ...a, amount: "701" })!, /proof doesn't match/);
  assert.match(checkBeforeClaim(onChain, Keypair.generate().publicKey.toBytes(), a)!, /proof doesn't match/);
  assert.equal(proofMatches({ ...a, amount: "701" }, wallet), false);
});

test("claims: every claimable allocation is listed, however old, before the claimed and expired ones", () => {
  const al = (epoch: number, claimable: boolean): AllocationJson => ({ epoch, kind: "holder", index: 0, amount: "1", proof: [], root: "", claimed: !claimable, expired: false, claimable, publishedAt: 0, expiresAt: 0, totalLamports: "1", numLeaves: 1 });
  // Newest first, as the indexer serves them: 20 claimed epochs, then an old one still claimable.
  const list = [...Array.from({ length: 20 }, (_, i) => al(40 - i, false)), al(3, true)];
  const rows = claimRows(list);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.map((r) => r.epoch).slice(0, 3), [3, 40, 39], "the old claimable one first, then the newest of the rest");
  const many = Array.from({ length: 15 }, (_, i) => al(i, true));
  assert.equal(claimRows(many).length, 15, "claimable rows are never cut off");
});

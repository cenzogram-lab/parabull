import { test } from "node:test";
import assert from "node:assert/strict";
import { AnchorProvider, BN, BorshCoder, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransactionResponse } from "@solana/web3.js";
import type { Parabull } from "../../target/types/parabull";
import { metadataCommitment, tweetIdHash } from "./launch";
import { DELAY_MAX_MS, DELAY_MIN_MS, DecisionInput, checkMetadataUri, decide, findRequestArgs, randomDelayMs, verifyTweet } from "./launchWorker";
import { loadIdl } from "./program";
import { Pdas } from "./pdas";

const NAME = "Pepe Coin";
const SYMBOL = "PEPE";
const URI = "https://arweave.net/pepe.json";
const TWEET = 1_850_000_000_000_000_000n;
const DAY = 86_400n;

const base = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  now: 1_000_000n,
  paused: false,
  expiresAt: 1_000_600n,
  lockSeconds: 3n * DAY,
  ticketMetadataHash: metadataCommitment(NAME, SYMBOL, URI),
  ticketTweetHash: null,
  args: { nonce: 1n, name: NAME, symbol: SYMBOL, uri: URI, tweetId: null },
  ticker: null,
  name: null,
  tweet: null,
  ...over,
});

test("decide: schedules a clean ticket", () => {
  assert.deepEqual(decide(base()), { action: "schedule" });
  // An expired lock (or a never-used registry) is free again.
  const old = { mint: Keypair.generate().publicKey, launchTimestamp: 1_000_000n - 3n * DAY };
  assert.deepEqual(decide(base({ ticker: old, name: old })), { action: "schedule" });
  assert.deepEqual(decide(base({ ticker: { mint: PublicKey.default, launchTimestamp: 0n } })), { action: "schedule" });
});

test("decide: rejects what create would reject", () => {
  const live = { mint: Keypair.generate().publicKey, launchTimestamp: 1_000_000n - 3n * DAY + 1n };
  assert.equal(decide(base({ ticker: live })).action, "reject");
  assert.equal(decide(base({ name: live })).action, "reject");
  assert.equal(decide(base({ tweet: live })).action, "reject");
  assert.equal(decide(base({ ticketMetadataHash: Buffer.alloc(32) })).action, "reject");
  // Tweet on the ticket must match the request's tweet id.
  const withTweet = { nonce: 1n, name: NAME, symbol: SYMBOL, uri: URI, tweetId: TWEET };
  assert.deepEqual(decide(base({ args: withTweet, ticketTweetHash: tweetIdHash(TWEET) })), { action: "schedule" });
  assert.equal(decide(base({ args: withTweet, ticketTweetHash: tweetIdHash(TWEET + 1n) })).action, "reject");
  assert.equal(decide(base({ args: withTweet, ticketTweetHash: null })).action, "reject");
});

test("decide: waits while paused or undecodable, abandons near expiry", () => {
  assert.equal(decide(base({ paused: true })).action, "wait");
  assert.equal(decide(base({ args: null })).action, "wait");
  assert.equal(decide(base({ now: 1_000_600n - 30n })).action, "abandon");
  assert.equal(decide(base({ now: 1_000_600n - 31n })).action, "schedule");
});

test("random delay is uniform over [3000, 15000] ms from a CSPRNG", () => {
  let seen: [number, number] | null = null;
  assert.equal(randomDelayMs((a, b) => ((seen = [a, b]), a)), 3_000);
  assert.deepEqual(seen, [3_000, 15_001], "max is inclusive");
  for (let i = 0; i < 2_000; i++) {
    const d = randomDelayMs();
    assert.ok(d >= DELAY_MIN_MS && d <= DELAY_MAX_MS, `${d}`);
  }
});

test("recovers name/symbol/URI/tweet from the user's request_launch transaction", async () => {
  const provider = new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(Keypair.generate()), {});
  const program = new Program<Parabull>(loadIdl(), provider);
  const pdas = new Pdas(program.programId);
  const payer = Keypair.generate().publicKey;
  const ticket = pdas.ticket(payer, 42n);
  const ix = await program.methods
    .requestLaunch(new BN(42), NAME, SYMBOL, URI, new BN(TWEET.toString()))
    .accountsStrict({ payer, global: pdas.global(), ticket, systemProgram: SystemProgram.programId })
    .instruction();
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: [ix] }).compileToV0Message();
  const tx = { transaction: { message, signatures: [] }, meta: null } as unknown as VersionedTransactionResponse;
  const coder = program.coder as BorshCoder;

  const args = findRequestArgs(tx, program.programId, ticket, coder);
  assert.deepEqual(args, { nonce: 42n, name: NAME, symbol: SYMBOL, uri: URI, tweetId: TWEET });
  // The decoded metadata reproduces the ticket's commitment.
  assert.ok(metadataCommitment(args!.name, args!.symbol, args!.uri).equals(metadataCommitment(NAME, SYMBOL, URI)));
  // A different ticket in the same transaction isn't confused for this one.
  assert.equal(findRequestArgs(tx, program.programId, pdas.ticket(payer, 43n), coder), null);
});

const respond = (status: number, body: unknown) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

test("metadata URI check", async () => {
  assert.equal(await checkMetadataUri(URI, { fetchImpl: respond(200, { name: NAME, image: "https://x/y.png" }) }), null);
  assert.match((await checkMetadataUri("http://plain.example/m.json"))!, /https/);
  assert.match((await checkMetadataUri(URI, { fetchImpl: respond(404, {}) }))!, /404/);
  assert.match((await checkMetadataUri(URI, { fetchImpl: respond(200, { name: NAME }) }))!, /no image/);
  assert.match((await checkMetadataUri(URI, { fetchImpl: respond(200, "not json") }))!, /unreachable/);
  let asked = "";
  const spy = (async (u: string) => ((asked = u), new Response(JSON.stringify({ image: "i" }), { status: 200 }))) as unknown as typeof fetch;
  await checkMetadataUri("ipfs://bafyhash/meta.json", { fetchImpl: spy });
  assert.equal(asked, "https://ipfs.io/ipfs/bafyhash/meta.json");
});

test("tweet check (X API v2)", async () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const tweet = (text: string, created: string, author = "42") => respond(200, { data: { text, created_at: created, author_id: author } });
  assert.equal(await verifyTweet(TWEET, SYMBOL, {}), null, "skipped without a bearer token");
  const ok = { bearer: "t", nowMs: now };
  assert.equal(await verifyTweet(TWEET, SYMBOL, { ...ok, fetchImpl: tweet("launching $PEPE today", "2026-11-02T10:00:00Z") }), null);
  assert.match((await verifyTweet(TWEET, SYMBOL, { ...ok, fetchImpl: tweet("launching $PEPEX", "2026-11-02T10:00:00Z") }))!, /mention/);
  assert.match((await verifyTweet(TWEET, SYMBOL, { ...ok, fetchImpl: tweet("$pepe", "2026-10-30T10:00:00Z") }))!, /24h/);
  assert.match(
    (await verifyTweet(TWEET, SYMBOL, { ...ok, expectedAuthorId: "7", fetchImpl: tweet("$PEPE", "2026-11-02T10:00:00Z") }))!,
    /author/,
  );
  assert.match((await verifyTweet(TWEET, SYMBOL, { ...ok, fetchImpl: respond(404, {}) }))!, /404/);
});

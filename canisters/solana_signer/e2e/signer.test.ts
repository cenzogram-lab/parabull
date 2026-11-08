/**
 * The signer canister on PocketIC, with a fiduciary subnet holding the `key_1` threshold keys (as on mainnet), driven by
 * the app's own client (app/src/lib/auth/chainFusionSigner.ts). Needs the built Wasm: `mops build solana_signer` in
 * canisters/solana_signer, and the app's dependencies installed (`npm ci --prefix app`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import { generateRandomIdentity, PocketIc, PocketIcServer, SubnetStateType, type Actor } from "@dfinity/pic";
import { AnonymousIdentity, type Identity } from "@icp-sdk/core/agent";
import type { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { canisterSigner } from "../../../app/src/lib/auth/chainFusionSigner.ts";

// The app's copy of web3.js, so transactions are the same classes the app's client signs.
const web3 = createRequire(new URL("../../../app/package.json", import.meta.url))("@solana/web3.js") as typeof import("../../../app/node_modules/@solana/web3.js");

const WASM = new URL("../.mops/.build/solana_signer.wasm", import.meta.url).pathname;

const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Limits = IDL.Record({ per_caller_per_minute: IDL.Nat, global_per_minute: IDL.Nat });
  return IDL.Service({
    get_solana_address: IDL.Func([IDL.Principal], [IDL.Text], []),
    lookup_solana_address: IDL.Func([IDL.Principal], [IDL.Opt(IDL.Text)], ["query"]),
    sign_solana_transaction: IDL.Func([IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)], [IDL.Vec(IDL.Nat8)], []),
    configure: IDL.Func([IDL.Record({ key_name: IDL.Opt(IDL.Text), signing_paused: IDL.Opt(IDL.Bool), limits: IDL.Opt(Limits) })], [], []),
    status: IDL.Func(
      [],
      [IDL.Record({ key_name: IDL.Text, signing_paused: IDL.Bool, limits: Limits, known_addresses: IDL.Nat, signatures_issued: IDL.Nat })],
      ["query"],
    ),
  });
};

interface Limits {
  per_caller_per_minute: bigint;
  global_per_minute: bigint;
}
interface SignerService {
  get_solana_address(owner: Principal): Promise<string>;
  lookup_solana_address(owner: Principal): Promise<[] | [string]>;
  sign_solana_transaction(message: Uint8Array, expectedSigner: Uint8Array): Promise<Uint8Array | number[]>;
  configure(update: { key_name: [] | [string]; signing_paused: [] | [boolean]; limits: [] | [Limits] }): Promise<void>;
  status(): Promise<{ key_name: string; signing_paused: boolean; limits: Limits; known_addresses: bigint; signatures_issued: bigint }>;
}

const NONE = { key_name: [] as [], signing_paused: [] as [], limits: [] as [] };
const limits = (perCaller: number, global: number): [Limits] => [{ per_caller_per_minute: BigInt(perCaller), global_per_minute: BigInt(global) }];
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

/** A legacy transfer from `from`, the kind the app builds, with a fixed blockhash (nothing is sent anywhere). */
function transfer(from: InstanceType<typeof web3.PublicKey>) {
  const tx = new web3.Transaction({ feePayer: from, recentBlockhash: "11111111111111111111111111111111" });
  tx.add(web3.SystemProgram.transfer({ fromPubkey: from, toPubkey: web3.Keypair.generate().publicKey, lamports: 1_000 }));
  return tx;
}

describe("solana_signer canister (threshold Ed25519 on PocketIC)", () => {
  let server: PocketIcServer;
  let pic: PocketIc;
  let signer: Actor<SignerService>;
  const controller = generateRandomIdentity();
  const alice = generateRandomIdentity();
  const bob = generateRandomIdentity();
  const as = (who: Identity) => (signer.setIdentity(who), signer);

  before(async () => {
    server = await PocketIcServer.start();
    pic = await PocketIc.create(server.getUrl(), {
      fiduciary: { state: { type: SubnetStateType.New } },
      application: [{ state: { type: SubnetStateType.New } }],
    });
    const fixture = await pic.setupCanister<SignerService>({ idlFactory, wasm: readFileSync(WASM), sender: controller.getPrincipal() });
    signer = fixture.actor;
  });

  after(async () => {
    await pic?.tearDown();
    await server?.stop();
  });

  test("defaults: key_1, signing on, conservative limits", async () => {
    const s = await as(alice).status();
    assert.equal(s.key_name, "key_1");
    assert.equal(s.signing_paused, false);
    assert.deepEqual(s.limits, { per_caller_per_minute: 10n, global_per_minute: 30n });
    assert.equal(s.known_addresses, 0n);
  });

  test("each principal gets its own stable 32-byte Ed25519 address", async () => {
    const a1 = await as(alice).get_solana_address(alice.getPrincipal());
    const a2 = await as(alice).get_solana_address(alice.getPrincipal());
    const b = await as(bob).get_solana_address(bob.getPrincipal());
    assert.equal(bs58.decode(a1).length, 32);
    assert.equal(a1, a2, "the same principal always gets the same address");
    assert.notEqual(a1, b, "different principals get different addresses");
    // Anyone may look up another principal's (public) address; it matches what that principal sees.
    assert.equal(await as(bob).get_solana_address(alice.getPrincipal()), a1);
    // Only callers' own keys are cached, and the query reads that cache.
    assert.deepEqual(await as(bob).lookup_solana_address(alice.getPrincipal()), [a1]);
    assert.deepEqual(await as(alice).lookup_solana_address(generateRandomIdentity().getPrincipal()), []);
    assert.equal((await as(alice).status()).known_addresses, 2n);
  });

  test("anonymous callers and the anonymous owner are refused", async () => {
    await assert.rejects(as(new AnonymousIdentity()).get_solana_address(alice.getPrincipal()), /anonymous callers/);
    await assert.rejects(as(alice).get_solana_address(new AnonymousIdentity().getPrincipal()), /anonymous principal has no Solana address/);
    await assert.rejects(as(new AnonymousIdentity()).sign_solana_transaction(bytes(10), bytes(32)), /anonymous callers/);
  });

  test("the app's client signs a real transaction as the caller's address, and it verifies", async () => {
    const client = await canisterSigner(alice.getPrincipal(), as(alice));
    assert.equal(client.publicKey.toBase58(), await as(alice).get_solana_address(alice.getPrincipal()));
    const signed = await client.signTransaction(transfer(client.publicKey));
    assert.ok(signed.verifySignatures(), "Solana accepts the signature for the fee payer");
    // The raw signature verifies against the base58 address the canister returned, and not against anyone else's.
    const message = signed.serializeMessage();
    const sig = Uint8Array.from(await as(alice).sign_solana_transaction(message, client.publicKey.toBytes()));
    assert.equal(sig.length, 64);
    assert.ok(ed25519.verify(sig, message, client.publicKey.toBytes()));
    const bobKey = bs58.decode(await as(bob).get_solana_address(bob.getPrincipal()));
    assert.ok(!ed25519.verify(sig, message, bobKey));
  });

  test("a caller can't sign as another principal's address: refused before any signature", async () => {
    const before = (await as(alice).status()).signatures_issued;
    const bobKey = bs58.decode(await as(bob).get_solana_address(bob.getPrincipal()));
    await assert.rejects(as(alice).sign_solana_transaction(bytes(100), bobKey), /expected signer mismatch/);
    // A made-up key, too.
    await assert.rejects(as(alice).sign_solana_transaction(bytes(100), bytes(32, 9)), /expected signer mismatch/);
    assert.equal((await as(alice).status()).signatures_issued, before, "no threshold signature was requested");
    // And the app's client, built for Bob but called by Alice, gets the same refusal.
    const forged = await canisterSigner(bob.getPrincipal(), as(alice));
    await assert.rejects(forged.signBytes(bytes(50)), /expected signer mismatch/);
  });

  test("malformed requests are refused", async () => {
    const key = bs58.decode(await as(alice).get_solana_address(alice.getPrincipal()));
    await assert.rejects(as(alice).sign_solana_transaction(new Uint8Array(0), key), /message is empty/);
    await assert.rejects(as(alice).sign_solana_transaction(bytes(1233), key), /1233 bytes/);
    await assert.rejects(as(alice).sign_solana_transaction(bytes(10), key.slice(0, 31)), /31 bytes/);
    // 1232 bytes is the largest message that fits in a Solana transaction, and is signed.
    const sig = Uint8Array.from(await as(alice).sign_solana_transaction(bytes(1232), key));
    assert.ok(ed25519.verify(sig, bytes(1232), key));
  });

  test("only controllers configure it; the key can't change once addresses exist", async () => {
    await assert.rejects(as(alice).configure({ ...NONE, signing_paused: [true] }), /only the signer's controllers/);
    await assert.rejects(as(controller).configure({ ...NONE, key_name: ["test_key_1"] }), /can't change once addresses exist/);
    await assert.rejects(as(controller).configure({ ...NONE, key_name: ["key_2"] }), /unknown key name/);
    // A refused update changes nothing, not even its valid parts.
    await assert.rejects(as(controller).configure({ key_name: ["key_2"], signing_paused: [true], limits: [] }), /unknown key name/);
    assert.equal((await as(alice).status()).signing_paused, false);
  });

  test("controllers can pause signing; addresses still resolve", async () => {
    const key = bs58.decode(await as(alice).get_solana_address(alice.getPrincipal()));
    await as(controller).configure({ ...NONE, signing_paused: [true] });
    await assert.rejects(as(alice).sign_solana_transaction(bytes(10), key), /signing is paused/);
    assert.equal(bs58.decode(await as(alice).get_solana_address(alice.getPrincipal())).length, 32);
    await as(controller).configure({ ...NONE, signing_paused: [false] });
    assert.equal(Uint8Array.from(await as(alice).sign_solana_transaction(bytes(10), key)).length, 64);
  });

  test("rate limits: per caller, then for everyone together; both reset after a minute", async () => {
    const carol = generateRandomIdentity();
    const dave = generateRandomIdentity();
    const carolKey = bs58.decode(await as(carol).get_solana_address(carol.getPrincipal()));
    const daveKey = bs58.decode(await as(dave).get_solana_address(dave.getPrincipal()));
    await pic.advanceTime(61_000);
    await pic.tick();
    await as(controller).configure({ ...NONE, limits: limits(2, 3) });

    assert.equal(Uint8Array.from(await as(carol).sign_solana_transaction(bytes(10), carolKey)).length, 64);
    assert.equal(Uint8Array.from(await as(carol).sign_solana_transaction(bytes(11), carolKey)).length, 64);
    await assert.rejects(as(carol).sign_solana_transaction(bytes(12), carolKey), /at most 2 requests a minute per caller/);
    assert.equal(Uint8Array.from(await as(dave).sign_solana_transaction(bytes(13), daveKey)).length, 64);
    await assert.rejects(as(dave).sign_solana_transaction(bytes(14), daveKey), /at its limit of 3 requests a minute/);

    await pic.advanceTime(61_000);
    await pic.tick();
    assert.equal(Uint8Array.from(await as(carol).sign_solana_transaction(bytes(15), carolKey)).length, 64);
    await as(controller).configure({ ...NONE, limits: limits(10, 30) });
  });
});

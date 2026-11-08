import { test } from "node:test";
import assert from "node:assert/strict";
import { utils } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { canisterSigner, mockKeypair, mockSigner, type SolanaSignerActor } from "../src/lib/auth/chainFusionSigner";
import { resolveIiMode } from "../src/lib/auth/iiConfig";
import { ImportedSigner, parseSecretKey } from "../src/lib/wallet/importedKey";
import { messageBytes, signWithSeed, verifyEd25519 } from "../src/lib/wallet/signing";

const BLOCKHASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const legacyTx = (payer: PublicKey) => {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: BLOCKHASH });
  tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1_000 }));
  return tx;
};
const versionedTx = (payer: PublicKey) =>
  new VersionedTransaction(
    new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message(),
  );
const PRINCIPAL = { toText: () => "2vxsx-fae-not-anonymous", isAnonymous: () => false };

test("Path B: a private key parses from base58 and from a solana-keygen JSON file", () => {
  const kp = Keypair.generate();
  const b58 = parseSecretKey(`  ${utils.bytes.bs58.encode(kp.secretKey)}\n`);
  const json = parseSecretKey(JSON.stringify(Array.from(kp.secretKey)));
  assert.ok(b58.ok && b58.keypair.publicKey.equals(kp.publicKey));
  assert.ok(json.ok && json.keypair.publicKey.equals(kp.publicKey));
  // The parsed keypair still signs after the decoded input bytes are wiped (it holds its own copy).
  const sig = new ImportedSigner((b58 as { keypair: Keypair }).keypair).signBytes(new Uint8Array([1, 2, 3]));
  assert.ok(verifyEd25519(new Uint8Array([1, 2, 3]), sig, kp.publicKey));
});

test("Path B: bad keys are refused with a reason", () => {
  const kp = Keypair.generate();
  const mismatched = kp.secretKey.slice();
  mismatched.set(Keypair.generate().publicKey.toBytes(), 32);
  const cases: [string, RegExp][] = [
    ["", /Paste/],
    ["0OIl-not-base58", /base58/],
    [utils.bytes.bs58.encode(kp.secretKey.slice(0, 32)), /64 bytes; this is 32/],
    ["[1,2,3]", /64 bytes; this is 3/],
    ["[1,2,300]", /0 to 255/],
    ["[not json", /key file/],
    [utils.bytes.bs58.encode(mismatched), /public half/],
  ];
  for (const [input, why] of cases) {
    const r = parseSecretKey(input);
    assert.ok(!r.ok && why.test(r.error), `${input.slice(0, 12)} -> ${!r.ok && r.error}`);
  }
});

test("Path B: the imported key signs legacy and versioned transactions with no popup, and can be cleared", () => {
  const kp = Keypair.generate();
  const signer = new ImportedSigner(kp);
  const legacy = signer.signTransaction(legacyTx(kp.publicKey));
  assert.ok(legacy.verifySignatures(), "legacy transaction fully signed");
  const v0 = signer.signTransaction(versionedTx(kp.publicKey));
  assert.ok(verifyEd25519(v0.message.serialize(), v0.signatures[0], kp.publicKey), "v0 signature over the message");
  signer.clear();
  assert.throws(() => signer.signBytes(new Uint8Array([1])), /cleared/);
});

test("Path A (development): the mock key is deterministic per principal and signs like the canister would", async () => {
  assert.ok(mockKeypair("aaaaa-aa").publicKey.equals(mockKeypair("aaaaa-aa").publicKey));
  assert.ok(!mockKeypair("aaaaa-aa").publicKey.equals(mockKeypair("bbbbb-bb").publicKey));
  const signer = mockSigner("aaaaa-aa");
  assert.equal(signer.kind, "mock");
  const tx = await signer.signTransaction(legacyTx(signer.publicKey));
  assert.ok(tx.verifySignatures());
  const [a, b] = await signer.signAllTransactions([legacyTx(signer.publicKey), versionedTx(signer.publicKey)]);
  assert.ok((a as Transaction).verifySignatures() && verifyEd25519(messageBytes(b), (b as VersionedTransaction).signatures[0], signer.publicKey));
});

/** A stand-in signer canister: one Ed25519 key per principal (as threshold derivation gives), signing only as the caller. */
function fakeCanister(opts: { tamper?: "short" | "wrong" } = {}) {
  const keys = new Map<string, Keypair>();
  const keyOf = (p: string) => keys.get(p) ?? (keys.set(p, Keypair.generate()), keys.get(p)!);
  const calls: { message: Uint8Array; expected: Uint8Array }[] = [];
  const caller = PRINCIPAL.toText();
  const actor: SolanaSignerActor = {
    get_solana_address: async (p) => keyOf(p.toText()).publicKey.toBase58(),
    sign_solana_transaction: async (message, expected) => {
      calls.push({ message, expected });
      const kp = keyOf(caller);
      if (!kp.publicKey.equals(new PublicKey(expected))) throw new Error("expected signer doesn't match the caller's key");
      const sig = signWithSeed(message, kp.secretKey.subarray(0, 32));
      if (opts.tamper === "short") return Array.from(sig.subarray(0, 63));
      if (opts.tamper === "wrong") return signWithSeed(message, Keypair.generate().secretKey.subarray(0, 32));
      return sig;
    },
  };
  return { actor, calls, keyOf };
}

test("Path A (Chain Fusion): the address comes from the canister and signatures are attached and verified", async () => {
  const { actor, calls, keyOf } = fakeCanister();
  const signer = await canisterSigner(PRINCIPAL, actor);
  assert.equal(signer.kind, "canister");
  assert.ok(signer.publicKey.equals(keyOf(PRINCIPAL.toText()).publicKey), "the derived address");
  const tx = legacyTx(signer.publicKey);
  const unsignedMessage = new Uint8Array(tx.serializeMessage());
  const signed = await signer.signTransaction(tx);
  assert.ok(signed.verifySignatures(), "the canister's signature makes the transaction valid");
  assert.deepEqual(Array.from(calls[0].message), Array.from(unsignedMessage), "the canister is sent the transaction message (wire format)");
  assert.deepEqual(Array.from(calls[0].expected), Array.from(signer.publicKey.toBytes()), "with the address the client expects to sign as");
  const v0 = await signer.signTransaction(versionedTx(signer.publicKey));
  assert.ok(verifyEd25519(v0.message.serialize(), v0.signatures[0], signer.publicKey));
});

test("Path A (Chain Fusion): bad canister answers are refused before they reach a transaction", async () => {
  for (const tamper of ["short", "wrong"] as const) {
    const { actor } = fakeCanister({ tamper });
    const signer = await canisterSigner(PRINCIPAL, actor);
    await assert.rejects(signer.signTransaction(legacyTx(signer.publicKey)), tamper === "short" ? /63-byte signature/ : /doesn't verify/);
  }
  const { actor } = fakeCanister();
  await assert.rejects(canisterSigner({ toText: () => "2vxsx-fae", isAnonymous: () => true }, actor), /anonymous/);
  await assert.rejects(canisterSigner(PRINCIPAL, { ...actor, get_solana_address: async () => "not-an-address" }), /didn't return a Solana address/);
});

test("Path A: which sign-in a build offers", () => {
  const base = { isDemo: false, cluster: "devnet", dev: false };
  assert.deepEqual(resolveIiMode({ ...base, canisterId: "uxrrr-q7777-77774-qaaaq-cai" }), { kind: "canister", canisterId: "uxrrr-q7777-77774-qaaaq-cai" });
  assert.equal(resolveIiMode({ ...base, canisterId: "not a canister" }).kind, "off");
  assert.equal(resolveIiMode(base).kind, "off", "production chain build without a signer canister: never the mock key");
  assert.equal(resolveIiMode({ ...base, isDemo: true }).kind, "mock-signer");
  assert.equal(resolveIiMode({ ...base, dev: true }).kind, "mock-signer");
  assert.equal(resolveIiMode({ ...base, cluster: "localnet" }).kind, "offline");
});

test("connect dialog: Phantom and Solflare are detected from their injected providers", async () => {
  const { WALLET_BRANDS } = await import("../src/wallet/brands");
  const [phantom, solflare] = WALLET_BRANDS;
  assert.deepEqual(WALLET_BRANDS.map((b) => b.name), ["Phantom", "Solflare"]);
  assert.equal(phantom.install, "https://phantom.com/download");
  assert.equal(solflare.install, "https://solflare.com/download");
  assert.match(phantom.icon ?? "", /^data:image\/svg\+xml;base64,/, "Phantom's official icon is embedded");
  assert.equal(solflare.icon, null, "Solflare's icon comes from its registered adapter");
  const g = globalThis as unknown as { window?: unknown };
  const had = "window" in g;
  const saved = g.window;
  try {
    g.window = {};
    assert.equal(phantom.injected(), false);
    assert.equal(solflare.injected(), false);
    g.window = { phantom: { solana: { isPhantom: true } } };
    assert.equal(phantom.injected(), true, "window.phantom.solana");
    g.window = { solana: { isPhantom: true } };
    assert.equal(phantom.injected(), true, "legacy window.solana");
    g.window = { solana: { isPhantom: false } };
    assert.equal(phantom.injected(), false, "another wallet on window.solana isn't Phantom");
    g.window = { solflare: { isSolflare: true } };
    assert.equal(solflare.injected(), true, "window.solflare");
  } finally {
    if (had) g.window = saved;
    else delete g.window;
  }
});

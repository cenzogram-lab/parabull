/**
 * Path A against the deployed signer canister, on Solana devnet: an Internet Identity-style principal gets a Solana
 * address from the canister, the address is funded, and the canister signs real devnet transactions (legacy and v0)
 * that the network accepts. It also checks the canister refuses to sign for an address that isn't the caller's.
 *
 *   SIGNER_CANISTER_ID=<canister id> npm run devnet-smoke
 *
 * Env:
 *   SIGNER_CANISTER_ID    required; the mainnet solana_signer canister (addresses don't depend on the Solana cluster,
 *                         so the mainnet canister serves devnet too)
 *   FUNDER_KEYPAIR        devnet wallet that funds the test address (default ~/.config/solana/id.json)
 *   SOLANA_RPC_URL        default https://api.devnet.solana.com; a mainnet-beta RPC is refused
 *   IC_HOST               default https://icp-api.io
 *   SIGNER_IDENTITY_SEED  optional, 64 hex chars: reuse one principal (and Solana address) across runs; default a new
 *                         random principal each run
 *   FUND_LAMPORTS         default 20000000 (0.02 SOL); all of it except fees goes back to the funder
 *
 * Cost: two threshold signatures (about 26B cycles each with key_1) and one key derivation, from the canister's
 * balance. Each run counts against the canister's rate limits like any user.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import type { IDL } from "@icp-sdk/core/candid";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

const MAINNET_BETA_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const FEE_LAMPORTS = 5_000;

const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Limits = IDL.Record({ per_caller_per_minute: IDL.Nat, global_per_minute: IDL.Nat });
  return IDL.Service({
    get_solana_address: IDL.Func([IDL.Principal], [IDL.Text], []),
    lookup_solana_address: IDL.Func([IDL.Principal], [IDL.Opt(IDL.Text)], ["query"]),
    sign_solana_transaction: IDL.Func([IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)], [IDL.Vec(IDL.Nat8)], []),
    status: IDL.Func(
      [],
      [IDL.Record({ key_name: IDL.Text, signing_paused: IDL.Bool, limits: Limits, known_addresses: IDL.Nat, signatures_issued: IDL.Nat })],
      ["query"],
    ),
  });
};

interface Signer {
  get_solana_address(owner: Principal): Promise<string>;
  lookup_solana_address(owner: Principal): Promise<[] | [string]>;
  sign_solana_transaction(message: Uint8Array, expectedSigner: Uint8Array): Promise<Uint8Array | number[]>;
  status(): Promise<{ key_name: string; signing_paused: boolean; limits: { per_caller_per_minute: bigint; global_per_minute: bigint }; known_addresses: bigint; signatures_issued: bigint }>;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`set ${name}`);
  return v;
}

function loadKeypair(path: string): Keypair {
  const file = path.replace(/^~(?=\/|$)/, homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]));
}

function identitySeed(): Uint8Array {
  const hex = process.env.SIGNER_IDENTITY_SEED;
  if (!hex) return randomBytes(32);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("SIGNER_IDENTITY_SEED must be 64 hex characters");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** Signs `message` with the canister and checks the signature against `address` before anyone relies on it. */
async function canisterSign(signer: Signer, message: Uint8Array, address: PublicKey): Promise<Uint8Array> {
  const sig = Uint8Array.from(await signer.sign_solana_transaction(message, address.toBytes()));
  assert.equal(sig.length, 64, `the canister returned a ${sig.length}-byte signature`);
  assert.ok(ed25519.verify(sig, message, address.toBytes()), "the canister's signature doesn't verify against the address");
  return sig;
}

const explorer = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

async function main() {
  const canisterId = env("SIGNER_CANISTER_ID");
  const connection = new Connection(env("SOLANA_RPC_URL", "https://api.devnet.solana.com"), "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis === MAINNET_BETA_GENESIS) throw new Error("SOLANA_RPC_URL is a mainnet-beta RPC; this smoke test moves real funds only on devnet");
  const funder = loadKeypair(env("FUNDER_KEYPAIR", "~/.config/solana/id.json"));
  const fund = BigInt(env("FUND_LAMPORTS", "20000000"));

  // Mainnet's root key ships with the agent; no fetchRootKey.
  const identity = Ed25519KeyIdentity.generate(identitySeed());
  const principal = identity.getPrincipal();
  const agent = await HttpAgent.create({ host: env("IC_HOST", "https://icp-api.io"), identity });
  const signer = Actor.createActor<Signer>(idlFactory, { agent, canisterId });

  const before = await signer.status();
  console.log(`signer ${canisterId}: key ${before.key_name}, ${before.signatures_issued} signatures so far, limits ${before.limits.per_caller_per_minute}/caller and ${before.limits.global_per_minute} overall a minute`);
  if (before.signing_paused) throw new Error("signing is paused on the canister (configure signing_paused = false)");

  // 1. Address: derived from this principal, stable, and cached for the query.
  const text = await signer.get_solana_address(principal);
  const address = new PublicKey(text);
  assert.equal(bs58.decode(text).length, 32);
  assert.equal(await signer.get_solana_address(principal), text, "the same principal must get the same address");
  assert.deepEqual(await signer.lookup_solana_address(principal), [text], "the query must return the cached address");
  console.log(`principal ${principal.toText()} -> Solana address ${text}`);

  // 2. Asking it to sign as an address that isn't the caller's is refused, before any signature is requested.
  await assert.rejects(signer.sign_solana_transaction(new Uint8Array(32).fill(1), funder.publicKey.toBytes()), /expected signer mismatch/);
  console.log("refused to sign as another address (expected signer mismatch)");

  // 3. Fund the address from the funder (a local keypair signs this one).
  const funderBalance = await connection.getBalance(funder.publicKey);
  if (BigInt(funderBalance) < fund + 10_000n) throw new Error(`the funder ${funder.publicKey.toBase58()} has ${funderBalance / LAMPORTS_PER_SOL} SOL on devnet; it needs at least ${Number(fund) / LAMPORTS_PER_SOL} (solana airdrop 1 ${funder.publicKey.toBase58()} --url devnet)`);
  const fundSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: address, lamports: fund })),
    [funder],
    { commitment: "confirmed" },
  );
  console.log(`funded ${Number(fund) / LAMPORTS_PER_SOL} SOL: ${explorer(fundSig)}`);

  // 4. A legacy transaction signed by the canister: half back to the funder.
  const half = fund / 2n;
  {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: address, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({ fromPubkey: address, toPubkey: funder.publicKey, lamports: half }),
    );
    tx.addSignature(address, Buffer.from(await canisterSign(signer, tx.serializeMessage(), address)));
    assert.ok(tx.verifySignatures(), "the legacy transaction must be fully signed");
    const signature = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    console.log(`legacy transfer signed by the canister: ${explorer(signature)}`);
  }

  // 5. A v0 transaction signed by the canister: everything that's left, minus its fee, back to the funder.
  {
    const left = BigInt(await connection.getBalance(address, "confirmed"));
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: address,
      recentBlockhash: blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: address, toPubkey: funder.publicKey, lamports: left - BigInt(FEE_LAMPORTS) })],
    }).compileToV0Message();
    const vtx = new VersionedTransaction(message);
    vtx.addSignature(address, await canisterSign(signer, message.serialize(), address));
    const signature = await connection.sendRawTransaction(vtx.serialize());
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    console.log(`v0 transfer signed by the canister: ${explorer(signature)}`);
  }

  const leftover = await connection.getBalance(address, "confirmed");
  assert.equal(leftover, 0, "the test address should be empty again");
  const after = await signer.status();
  console.log(`done: ${after.signatures_issued - before.signatures_issued} signatures issued by the canister; the test address is empty`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

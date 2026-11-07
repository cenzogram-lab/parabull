/**
 * Path A signer: a Solana account controlled through Internet Identity. The address is a threshold Ed25519 key the
 * signer canister derives from the user's principal (Chain Fusion, `sign_with_schnorr`); see solana_signer.did for
 * the interface and the rules the canister enforces. Every signature is an update call to that canister.
 *
 * Without a configured canister, development and demo builds use `mockSigner`: an Ed25519 key derived locally from the
 * principal text. Anyone who knows the principal can rebuild that key, so it exists only for offline testing and is
 * never offered in a production chain build (see iiConfig.ts).
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { sha256 } from "../sha256";
import { attachSignature, messageBytes, signWithSeed, verifyEd25519, type AnyTransaction } from "../wallet/signing";

/** The signer canister's methods as an agent-js actor exposes them (blob/vec nat8 arrive as Uint8Array or number[]). */
export interface SolanaSignerActor {
  get_solana_address(principal: { toText(): string }): Promise<string>;
  sign_solana_transaction(message: Uint8Array, expectedSigner: Uint8Array): Promise<Uint8Array | number[]>;
}

export interface SolanaSigner {
  publicKey: PublicKey;
  kind: "canister" | "mock";
  signBytes(message: Uint8Array): Promise<Uint8Array>;
  signTransaction<T extends AnyTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends AnyTransaction>(txs: T[]): Promise<T[]>;
}

function fromSignBytes(publicKey: PublicKey, kind: SolanaSigner["kind"], signBytes: (m: Uint8Array) => Promise<Uint8Array>): SolanaSigner {
  const signTransaction = async <T extends AnyTransaction>(tx: T): Promise<T> => attachSignature(tx, publicKey, await signBytes(messageBytes(tx)));
  return {
    publicKey,
    kind,
    signBytes,
    signTransaction,
    // One canister call per transaction, in order (a batch call would need a canister method that takes several).
    signAllTransactions: async (txs) => {
      const out = [];
      for (const tx of txs) out.push(await signTransaction(tx));
      return out;
    },
  };
}

/**
 * The canister-backed signer. Every signature the canister returns is checked against the derived address before it
 * is attached, so a wrong or corrupted answer fails here instead of producing a transaction the network rejects.
 */
export async function canisterSigner(principal: { toText(): string; isAnonymous?(): boolean }, actor: SolanaSignerActor): Promise<SolanaSigner> {
  if (principal.isAnonymous?.()) throw new Error("Internet Identity sign-in didn't complete (anonymous principal)");
  let publicKey: PublicKey;
  try {
    publicKey = new PublicKey(await actor.get_solana_address(principal as never));
  } catch (e) {
    throw new Error(`The signer canister didn't return a Solana address: ${e instanceof Error ? e.message : String(e)}`);
  }
  const expected = publicKey.toBytes();
  return fromSignBytes(publicKey, "canister", async (message) => {
    const sig = Uint8Array.from(await actor.sign_solana_transaction(message, expected));
    if (sig.length !== 64) throw new Error(`The signer canister returned a ${sig.length}-byte signature; Ed25519 signatures are 64 bytes`);
    if (!verifyEd25519(message, sig, publicKey)) throw new Error("The signer canister's signature doesn't verify against this account's address");
    return sig;
  });
}

/** The deterministic development key for a principal: sha256("parabull:ii-mock-signer:" + principal) as the seed. */
export function mockKeypair(principalText: string): Keypair {
  return Keypair.fromSeed(sha256(new TextEncoder().encode(`parabull:ii-mock-signer:${principalText}`)));
}

/** Development stand-in for the canister: same interface, key derived locally from the principal. */
export function mockSigner(principalText: string): SolanaSigner {
  const keypair = mockKeypair(principalText);
  return fromSignBytes(keypair.publicKey, "mock", async (message) => {
    const secret = keypair.secretKey;
    try {
      return signWithSeed(message, secret.subarray(0, 32));
    } finally {
      secret.fill(0);
    }
  });
}

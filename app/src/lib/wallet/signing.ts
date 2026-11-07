/**
 * Ed25519 signing shared by the app's own signers (an imported key, an Internet Identity signer): the bytes a
 * Solana transaction is signed over, attaching a signature, and checking one before it is used.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "buffer";

export type AnyTransaction = Transaction | VersionedTransaction;

export const isVersioned = (tx: AnyTransaction): tx is VersionedTransaction => "version" in tx;

/** The serialized message a transaction's signatures cover (the wire-format message, not the whole transaction). */
export const messageBytes = (tx: AnyTransaction): Uint8Array => (isVersioned(tx) ? tx.message.serialize() : new Uint8Array(tx.serializeMessage()));

/** True when `signature` is `signer`'s Ed25519 signature over `message`. */
export function verifyEd25519(message: Uint8Array, signature: Uint8Array, signer: PublicKey): boolean {
  if (signature.length !== 64) return false;
  try {
    return ed25519.verify(signature, message, signer.toBytes());
  } catch {
    return false;
  }
}

/** Put `signer`'s signature into the transaction's signature slot for it (the slot must exist: the signer is a required signer). */
export function attachSignature<T extends AnyTransaction>(tx: T, signer: PublicKey, signature: Uint8Array): T {
  if (isVersioned(tx)) tx.addSignature(signer, signature);
  else tx.addSignature(signer, Buffer.from(signature));
  return tx;
}

/** Ed25519 signature over `message` with a 32-byte seed (the first half of a Solana secret key). */
export const signWithSeed = (message: Uint8Array, seed: Uint8Array) => ed25519.sign(message, seed);

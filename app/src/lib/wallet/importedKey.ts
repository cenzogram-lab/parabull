/**
 * Path B, imported key: a Solana private key pasted into the app, the way trading terminals offer a "burner" wallet.
 * It lives only in this tab's memory (never localStorage or sessionStorage), so closing or reloading the tab forgets
 * it, and it signs without a wallet popup. That makes it fast and makes it a hot key: anything that runs in the page
 * can use it, so it is for small, disposable balances only, and the connect modal says so.
 */
import { utils } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { attachSignature, messageBytes, signWithSeed, type AnyTransaction } from "./signing";

export type ParsedKey = { ok: true; keypair: Keypair } | { ok: false; error: string };

/**
 * A private key as wallets export it: base58 of the 64-byte secret key (Phantom, Solflare, Backpack), or the JSON byte
 * array `solana-keygen` writes. The public half must match the private half (Keypair.fromSecretKey checks it).
 */
export function parseSecretKey(input: string): ParsedKey {
  const s = input.trim();
  if (!s) return { ok: false, error: "Paste a private key" };
  let bytes: Uint8Array;
  if (s.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(s);
    } catch {
      return { ok: false, error: "That isn't a valid key file (JSON byte array)" };
    }
    if (!Array.isArray(arr) || !arr.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return { ok: false, error: "A key file is an array of numbers from 0 to 255" };
    bytes = Uint8Array.from(arr as number[]);
  } else {
    try {
      bytes = Uint8Array.from(utils.bytes.bs58.decode(s));
    } catch {
      return { ok: false, error: "That isn't base58: check for a missing or extra character" };
    }
  }
  if (bytes.length !== 64) return { ok: false, error: `A Solana private key is 64 bytes; this is ${bytes.length}` };
  try {
    // fromSecretKey keeps the array it's given, so give it its own copy and wipe the decoded one below.
    return { ok: true, keypair: Keypair.fromSecretKey(bytes.slice()) };
  } catch {
    return { ok: false, error: "The key's public half doesn't match its private half" };
  } finally {
    bytes.fill(0);
  }
}

/** Signing with an in-memory key: no popup, no network. */
export class ImportedSigner {
  #keypair: Keypair | null;
  constructor(keypair: Keypair) {
    this.#keypair = keypair;
  }

  get publicKey(): PublicKey {
    if (!this.#keypair) throw new Error("The imported key was cleared");
    return this.#keypair.publicKey;
  }

  signBytes(message: Uint8Array): Uint8Array {
    if (!this.#keypair) throw new Error("The imported key was cleared");
    const secret = this.#keypair.secretKey;
    try {
      return signWithSeed(message, secret.subarray(0, 32));
    } finally {
      secret.fill(0);
    }
  }

  signTransaction<T extends AnyTransaction>(tx: T): T {
    return attachSignature(tx, this.publicKey, this.signBytes(messageBytes(tx)));
  }

  /** Drop the key. Keypair keeps its bytes internally, so this releases the only reference the app holds. */
  clear() {
    this.#keypair = null;
  }
}

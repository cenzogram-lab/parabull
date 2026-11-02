/** Port of state.rs `normalize_ticker` / `normalize_name_hash` and launch.rs `tweet_id_hash`. */
import { createHash } from "crypto";

export function canonicalTicker(input: string): string {
  let s = input.trim();
  if (s.startsWith("$")) s = s.slice(1);
  if (!/^[A-Za-z0-9]{1,10}$/.test(s)) throw new Error(`invalid ticker ${input}`);
  return s.toUpperCase();
}

/**
 * Name lock key (port of state.rs `normalize_name_hash`): sha256 of the name
 * reduced to lowercase ASCII letters/digits ("Pepe Coin" = "PepeCoin" =
 * "P.E.P.E-coin"). A name with no ASCII letters/digits falls back to its
 * trimmed raw UTF-8 bytes.
 */
export function nameHash(name: string): Buffer {
  const raw = Buffer.from(name.trim(), "utf8");
  if (raw.length === 0 || raw.length > 32) throw new Error("name must be 1-32 bytes");
  const stripped = Buffer.from(
    [...raw].filter((b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)).map((b) => (b >= 0x41 && b <= 0x5a ? b + 32 : b)),
  );
  return createHash("sha256").update(stripped.length > 0 ? stripped : raw).digest();
}

/**
 * Port of state.rs `metadata_commitment`: sha256 over length-prefixed
 * (u32 LE) UTF-8 name, symbol and URI. `create` only accepts metadata that
 * matches the hash stored on the ticket.
 */
export function metadataCommitment(name: string, symbol: string, uri: string): Buffer {
  const h = createHash("sha256");
  for (const field of [name, symbol, uri]) {
    const b = Buffer.from(field, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    h.update(len).update(b);
  }
  return h.digest();
}

/**
 * Lock key for an announcement tweet: sha256("parabull:tweet" || id as u64 LE).
 * The program computes this itself from `request_launch(..., tweet_id)`; this
 * port is for deriving the `["tweet", hash]` registry PDA client-side.
 */
export function tweetIdHash(tweetId: bigint): Buffer {
  if (tweetId <= 0n || tweetId >= 2n ** 64n) throw new Error("tweet id must be a non-zero u64");
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(tweetId);
  return createHash("sha256").update(Buffer.concat([Buffer.from("parabull:tweet"), id])).digest();
}

/** Numeric status ID from any x.com / twitter.com status URL (or a bare ID). */
export function parseTweetId(input: string): bigint {
  const m = input.trim().match(/^(\d{1,20})$/) ?? input.match(/(?:twitter\.com|x\.com)\/(?:[^/]+\/status(?:es)?|i\/web\/status)\/(\d{1,20})/i);
  if (!m) throw new Error(`not a tweet URL or ID: ${input}`);
  return BigInt(m[1]);
}

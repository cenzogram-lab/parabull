/** Port of state.rs `normalize_ticker` / `normalize_name_hash` and launch.rs `tweet_id_hash`. */
import { createHash } from "crypto";

export function canonicalTicker(input: string): string {
  let s = input.trim();
  if (s.startsWith("$")) s = s.slice(1);
  if (!/^[A-Za-z0-9]{1,10}$/.test(s)) throw new Error(`invalid ticker ${input}`);
  return s.toUpperCase();
}

/** sha256 of the name: trimmed, ASCII whitespace runs -> one space, ASCII lowercased. */
export function nameHash(name: string): Buffer {
  const raw = Buffer.from(name.trim(), "utf8");
  if (raw.length === 0 || raw.length > 32) throw new Error("name must be 1-32 bytes");
  const out: number[] = [];
  let prevSpace = false;
  for (const b of raw) {
    const ws = b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d;
    if (ws) {
      if (!prevSpace) out.push(0x20);
      prevSpace = true;
    } else {
      out.push(b >= 0x41 && b <= 0x5a ? b + 32 : b);
      prevSpace = false;
    }
  }
  return createHash("sha256").update(Buffer.from(out)).digest();
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

/**
 * Browser port of the launch rules (scripts/src/launch.ts, state.rs, launch.rs).
 * The program enforces all of these; the app mirrors them for live previews.
 */
import { concatBytes, sha256, toHex } from "./sha256";
import type { Locks } from "./types";

const utf8 = new TextEncoder();
const isAlnum = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);

export const MAX_NAME_BYTES = 32;
export const MAX_TICKER_LEN = 10;

export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

/** `$pepe` -> `PEPE`. 1-10 ASCII letters/digits. */
export function canonicalTicker(input: string): Check<string> {
  let s = input.trim();
  if (s.startsWith("$")) s = s.slice(1);
  if (s.length === 0) return { ok: false, error: "Ticker is required" };
  if (s.length > MAX_TICKER_LEN) return { ok: false, error: `Ticker is at most ${MAX_TICKER_LEN} characters` };
  if (!/^[A-Za-z0-9]+$/.test(s)) return { ok: false, error: "Letters and digits only" };
  return { ok: true, value: s.toUpperCase() };
}

/**
 * The name-lock key: lowercase ASCII letters/digits of the trimmed name, so
 * "Pepe Coin", "PepeCoin" and "P.E.P.E-coin" share one lock. A name with no
 * ASCII letters/digits falls back to its trimmed raw bytes.
 */
export function normalizeName(name: string): Check<{ key: string; bytes: Uint8Array; fallback: boolean }> {
  const raw = utf8.encode(name.trim());
  if (raw.length === 0) return { ok: false, error: "Name is required" };
  if (raw.length > MAX_NAME_BYTES) return { ok: false, error: `Name is at most ${MAX_NAME_BYTES} bytes` };
  const stripped = Uint8Array.from(Array.from(raw).filter(isAlnum).map((b) => (b >= 0x41 && b <= 0x5a ? b + 32 : b)));
  const fallback = stripped.length === 0;
  const bytes = fallback ? raw : stripped;
  return { ok: true, value: { key: fallback ? name.trim() : new TextDecoder().decode(stripped), bytes, fallback } };
}

/** sha256 of the normalized name: the `["name", hash]` registry seed. */
export function nameHash(name: string): Uint8Array | null {
  const n = normalizeName(name);
  return n.ok ? sha256(n.value.bytes) : null;
}

export const nameHashHex = (name: string) => {
  const h = nameHash(name);
  return h ? toHex(h) : null;
};

/** Numeric status ID from any x.com / twitter.com status URL, or a bare ID. */
export function parseTweetId(input: string): Check<bigint> {
  const s = input.trim();
  if (!s) return { ok: false, error: "Paste a tweet URL or ID" };
  const m = s.match(/^(\d{1,20})$/) ?? s.match(/(?:twitter\.com|x\.com)\/(?:[^/]+\/status(?:es)?|i\/web\/status)\/(\d{1,20})/i);
  if (!m) return { ok: false, error: "Not a tweet URL or ID" };
  const id = BigInt(m[1]);
  if (id <= 0n || id >= 2n ** 64n) return { ok: false, error: "Tweet ID must be a non-zero u64" };
  return { ok: true, value: id };
}

/** sha256("parabull:tweet" || id u64 LE): the `["tweet", hash]` registry seed. */
export function tweetIdHash(id: bigint): Uint8Array {
  const le = new Uint8Array(8);
  new DataView(le.buffer).setBigUint64(0, id, true);
  return sha256(concatBytes(utf8.encode("parabull:tweet"), le));
}

/** Byte length the program checks against MAX_URI_LEN. */
export const byteLength = (s: string) => utf8.encode(s).length;

/**
 * A coin's social link (website, X, Telegram): empty, or an absolute http(s) URL. Anything else (javascript:,
 * data:, a bare word) is refused at launch and never rendered as a link, since it comes from the creator.
 */
export function socialLink(input: string | undefined): Check<string> {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: true, value: "" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Use a full link, starting with https://" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "Links must start with https://" };
  return { ok: true, value: url.href };
}

/** The link to render, or undefined when it isn't a safe http(s) URL. */
export const safeLink = (input: string | undefined) => {
  const c = socialLink(input);
  return c.ok && c.value ? c.value : undefined;
};

/**
 * "Verified locks only": the ticker, name and announcement-tweet locks are all still held at `now` (ms). A coin
 * launched without a tweet has no tweet lock, so it doesn't qualify.
 */
export const fullyLocked = (locks: Locks, now: number) => locks.ticker > now && locks.name > now && locks.tweet !== null && locks.tweet > now;

/** Past the ticket's expiry, how long to keep watching for a `create` that landed just before it (clock skew, confirmation lag). */
export const LAUNCH_WAIT_GRACE_MS = 30_000;

/**
 * When to stop waiting for the launch worker, in ms: the ticket's on-chain `expires_at` (unix seconds) plus the grace
 * period. After `expires_at` the program refuses `create`, so the ticket can only be refunded.
 */
export const launchWaitDeadline = (expiresAtSec: number, graceMs = LAUNCH_WAIT_GRACE_MS) => expiresAtSec * 1000 + graceMs;

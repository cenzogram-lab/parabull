/**
 * Callouts: a wallet's public call on a coin it holds, stored by the edge Worker (services/parabull-edge/src/callouts.ts)
 * and shared through links that tag the buys they bring in. Shared by the app, the Worker, the indexer
 * (services/parabull-indexer reads the referral memo) and scripts/src/callerEpoch.ts, so it imports nothing.
 *
 *   share link   https://<app>/c/<calloutId>
 *   buy memo     parabull:ref:<calloutId>   (an SPL Memo instruction after `buy`, top level)
 */

/** Longest callout, in characters (code points). */
export const CALLOUT_MAX_CHARS = 280;
/** The smallest balance (raw units, 6 decimals: 1 token) that counts as holding the coin when posting. */
export const CALLOUT_MIN_HOLDING = 1_000_000n;
/** Callout ids: 12 base58 characters (about 70 bits), short enough for a memo and a link. */
export const CALLOUT_ID_LENGTH = 12;
export const REF_MEMO_PREFIX = "parabull:ref:";
/** How long a followed link keeps tagging buys of its coin. */
export const REFERRAL_TTL_MS = 24 * 3600_000;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ID = new RegExp(`^[${B58}]{${CALLOUT_ID_LENGTH}}$`);

export const isCalloutId = (s: unknown): s is string => typeof s === "string" && ID.test(s);

/** A fresh id from random bytes (rejection sampling keeps the 58 characters uniform). */
export function newCalloutId(randomBytes: (n: number) => Uint8Array): string {
  let id = "";
  while (id.length < CALLOUT_ID_LENGTH) {
    for (const b of randomBytes(32)) {
      if (b >= 232) continue; // 232 = 4 * 58
      id += B58[b % 58];
      if (id.length === CALLOUT_ID_LENGTH) break;
    }
  }
  return id;
}

export const refMemo = (calloutId: string) => `${REF_MEMO_PREFIX}${calloutId}`;

/** The callout id in a referral memo, or null for any other text. */
export function parseRefMemo(text: string): string | null {
  if (!text.startsWith(REF_MEMO_PREFIX)) return null;
  const id = text.slice(REF_MEMO_PREFIX.length);
  return isCalloutId(id) ? id : null;
}

/** Control characters, zero-width and bidi-override characters: never stored. Built from escapes so the source stays ASCII. */
const INVISIBLE = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]", "g");

/**
 * The text as stored: control characters removed, runs of whitespace (newlines included) collapsed to one space,
 * trimmed. null when empty or over CALLOUT_MAX_CHARS.
 */
export function normalizeCalloutText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!text || [...text].length > CALLOUT_MAX_CHARS) return null;
  return text;
}

/** A stored callout (GET /callouts, POST /callouts). Market cap and price are the coin's at posting, in SOL. */
export interface CalloutJson {
  id: string;
  wallet: string;
  mint: string;
  text: string;
  calledAtMcapSol: number;
  calledAtPriceSol: number;
  /** Raw token balance the wallet held when it posted. */
  holding: string;
  /** Milliseconds since the epoch. */
  ts: number;
}

export interface CalloutPage {
  callouts: CalloutJson[];
  /** Cursor for the next (older) page, or null. */
  next: string | null;
}

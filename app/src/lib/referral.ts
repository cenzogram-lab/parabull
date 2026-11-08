/**
 * Referrals from callout links (app/src/lib/callouts.ts). Opening /c/<calloutId> remembers that callout for its coin
 * for REFERRAL_TTL_MS; a buy of that coin within it carries a `parabull:ref:<calloutId>` Memo instruction, which the
 * indexer records and scripts/src/callerEpoch.ts pays the callout's author for.
 *
 * Never for your own callout: a buy by the callout's author carries no memo (the epoch script drops such buys too).
 * Kept in this browser only (localStorage, one entry per coin, the latest link wins); unreadable storage just means
 * no referral.
 */
import { Buffer } from "buffer";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { REFERRAL_TTL_MS, isCalloutId, refMemo } from "./callouts";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const KEY = "parabull:referrals";

export interface Referral {
  calloutId: string;
  mint: string;
  /** The callout author's wallet. */
  author: string;
  /** When the link was opened (ms). */
  at: number;
}

export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const browser: KeyValue = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private mode or full storage: no referral, nothing else breaks
    }
  },
};

function read(store: KeyValue, now: number): Record<string, Referral> {
  try {
    const all = JSON.parse(store.get(KEY) ?? "{}") as Record<string, Referral>;
    const live: Record<string, Referral> = {};
    for (const [mint, r] of Object.entries(all)) if (r && isCalloutId(r.calloutId) && r.mint === mint && typeof r.author === "string" && now - r.at < REFERRAL_TTL_MS) live[mint] = r;
    return live;
  } catch {
    return {};
  }
}

/** Remembers a followed callout link for its coin. */
export function rememberReferral(r: Referral, store: KeyValue = browser): void {
  const all = read(store, r.at);
  all[r.mint] = r;
  try {
    store.set(KEY, JSON.stringify(all));
  } catch {
    // unwritable storage: no referral
  }
}

/** The referral a buy of `mint` by `wallet` carries now, if any: unexpired, and never the buyer's own callout. */
export function referralFor(mint: string, wallet: string | null, now = Date.now(), store: KeyValue = browser): Referral | null {
  const r = read(store, now)[mint];
  if (!r || (wallet !== null && r.author === wallet)) return null;
  return r;
}

/** The SPL Memo instruction tagging a buy with its callout (no signer accounts: the fee payer signs the transaction). */
export function refMemoInstruction(calloutId: string): TransactionInstruction {
  if (!isCalloutId(calloutId)) throw new Error("not a callout id");
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(refMemo(calloutId), "utf8") });
}

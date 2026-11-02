/**
 * Launch-worker logic (docs/BACKEND_SPEC.md §1), kept free of network I/O
 * where possible so it can be unit-tested. The runnable loop is
 * scripts/launch_worker.ts.
 */
import { randomInt } from "crypto";
import { BorshCoder } from "@coral-xyz/anchor";
import { MessageV0, PublicKey, VersionedMessage, VersionedTransactionResponse } from "@solana/web3.js";
import { metadataCommitment, tweetIdHash } from "./launch";

export const DELAY_MIN_MS = 3_000;
export const DELAY_MAX_MS = 15_000;
/** Don't start a create this close to the ticket's expiry; the payer can refund instead. */
export const EXPIRY_MARGIN_SECONDS = 30;

/** Uniform over [3000, 15000] ms inclusive, from a CSPRNG (never Math.random). */
export function randomDelayMs(rand: (min: number, maxExclusive: number) => number = randomInt): number {
  return rand(DELAY_MIN_MS, DELAY_MAX_MS + 1);
}

export interface RequestArgs {
  nonce: bigint;
  name: string;
  symbol: string;
  uri: string;
  tweetId: bigint | null;
}

export interface RegistryState {
  mint: PublicKey;
  launchTimestamp: bigint;
}

export function isLocked(r: RegistryState | null, now: bigint, lockSeconds: bigint): boolean {
  return r !== null && !r.mint.equals(PublicKey.default) && now < r.launchTimestamp + lockSeconds;
}

export type Decision =
  | { action: "schedule" }
  /** Refund now with refund_ticket (launch authority). */
  | { action: "reject"; reason: string }
  /** Leave the ticket open and look again later. */
  | { action: "wait"; reason: string }
  /** Too close to expiry: stop; the payer refunds it themselves. */
  | { action: "abandon"; reason: string };

export interface DecisionInput {
  now: bigint;
  paused: boolean;
  expiresAt: bigint;
  lockSeconds: bigint;
  ticketMetadataHash: Buffer;
  ticketTweetHash: Buffer | null;
  args: RequestArgs | null;
  ticker: RegistryState | null;
  name: RegistryState | null;
  tweet: RegistryState | null;
}

/** The on-chain checks `create` will make, evaluated up front so a doomed ticket is refunded at once. */
export function decide(x: DecisionInput): Decision {
  if (x.now >= x.expiresAt - BigInt(EXPIRY_MARGIN_SECONDS)) return { action: "abandon", reason: "ticket expiring" };
  if (x.paused) return { action: "wait", reason: "program paused" };
  if (!x.args) return { action: "wait", reason: "request_launch transaction not found yet" };
  if (!metadataCommitment(x.args.name, x.args.symbol, x.args.uri).equals(x.ticketMetadataHash)) {
    return { action: "reject", reason: "metadata does not match the ticket commitment" };
  }
  const expectTweet = x.args.tweetId === null ? null : tweetIdHash(x.args.tweetId);
  if ((expectTweet === null) !== (x.ticketTweetHash === null) || (expectTweet && !expectTweet.equals(x.ticketTweetHash!))) {
    return { action: "reject", reason: "tweet does not match the ticket" };
  }
  if (isLocked(x.ticker, x.now, x.lockSeconds)) return { action: "reject", reason: "ticker locked" };
  if (isLocked(x.name, x.now, x.lockSeconds)) return { action: "reject", reason: "name locked" };
  if (isLocked(x.tweet, x.now, x.lockSeconds)) return { action: "reject", reason: "tweet locked" };
  return { action: "schedule" };
}

const toBig = (v: unknown): bigint => BigInt((v as { toString(): string }).toString());

/** Decode a `request_launch` instruction's arguments (null if it's another instruction). */
export function decodeRequestLaunch(coder: BorshCoder, data: Buffer): RequestArgs | null {
  const ix = coder.instruction.decode(data);
  if (!ix || ix.name.replace(/_/g, "").toLowerCase() !== "requestlaunch") return null;
  const d = ix.data as Record<string, unknown>;
  const tweet = d.tweetId ?? d.tweet_id;
  return {
    nonce: toBig(d.nonce),
    name: String(d.name),
    symbol: String(d.symbol),
    uri: String(d.uri),
    tweetId: tweet === null || tweet === undefined ? null : toBig(tweet),
  };
}

/** Find the top-level `request_launch` for `ticket` (accounts: payer, global, ticket, system) in a transaction. */
export function findRequestArgs(
  tx: Pick<VersionedTransactionResponse, "transaction" | "meta">,
  programId: PublicKey,
  ticket: PublicKey,
  coder: BorshCoder,
): RequestArgs | null {
  const message = tx.transaction.message as VersionedMessage;
  const keys = (message as MessageV0).getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  for (const ix of message.compiledInstructions) {
    if (!keys.get(ix.programIdIndex)?.equals(programId)) continue;
    const ticketKey = keys.get(ix.accountKeyIndexes[2]);
    if (!ticketKey?.equals(ticket)) continue;
    const args = decodeRequestLaunch(coder, Buffer.from(ix.data));
    if (args) return args;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Optional external checks (BACKEND_SPEC §1.2). Each returns null when fine,
// or a rejection reason.
// ---------------------------------------------------------------------------

const ALLOWED_URI = /^(https:\/\/|ipfs:\/\/|ar:\/\/)/i;

/** Metadata JSON must be reachable and name an image. `ipfs://` / `ar://` go through `gateway`. */
export async function checkMetadataUri(
  uri: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number; gateway?: (u: string) => string } = {},
): Promise<string | null> {
  if (!ALLOWED_URI.test(uri)) return "metadata URI must be https://, ipfs:// or ar://";
  const url = opts.gateway ? opts.gateway(uri) : uri.replace(/^ipfs:\/\//i, "https://ipfs.io/ipfs/").replace(/^ar:\/\//i, "https://arweave.net/");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) return `metadata URI returned ${res.status}`;
    const text = await res.text();
    if (text.length > (opts.maxBytes ?? 1_000_000)) return "metadata JSON too large";
    const json = JSON.parse(text) as { image?: unknown };
    if (typeof json.image !== "string" || json.image.length === 0) return "metadata JSON has no image";
    return null;
  } catch (e) {
    return `metadata URI unreachable: ${(e as Error)?.name === "AbortError" ? "timeout" : (e as Error)?.message ?? e}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * X API v2 check: the tweet exists, was posted within `maxAgeSeconds`, and
 * mentions `$SYMBOL`. Checking that its author is the creator's linked X
 * account needs the app's account-linking data; pass `expectedAuthorId` when
 * you have it. Without a bearer token the check is skipped (devnet).
 */
export async function verifyTweet(
  tweetId: bigint,
  symbol: string,
  opts: { bearer?: string; fetchImpl?: typeof fetch; nowMs?: number; maxAgeSeconds?: number; expectedAuthorId?: string },
): Promise<string | null> {
  if (!opts.bearer) return null;
  const url = `https://api.x.com/2/tweets/${tweetId}?tweet.fields=created_at,author_id,text`;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${opts.bearer}` } });
    if (!res.ok) return `X API returned ${res.status}`;
    const body = (await res.json()) as { data?: { text?: string; created_at?: string; author_id?: string } };
    const t = body.data;
    if (!t?.text || !t.created_at) return "tweet not found";
    if (!new RegExp(`\\$${symbol}\\b`, "i").test(t.text)) return `tweet does not mention $${symbol}`;
    const ageSeconds = ((opts.nowMs ?? Date.now()) - Date.parse(t.created_at)) / 1000;
    if (ageSeconds > (opts.maxAgeSeconds ?? 24 * 3600)) return "tweet is older than 24h";
    if (opts.expectedAuthorId && t.author_id !== opts.expectedAuthorId) return "tweet author is not the creator's linked account";
    return null;
  } catch (e) {
    return `X API error: ${(e as Error)?.message ?? e}`;
  }
}

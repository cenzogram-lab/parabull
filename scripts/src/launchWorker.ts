/**
 * Launch-worker logic (docs/BACKEND_SPEC.md §1), kept free of network I/O
 * where possible so it can be unit-tested. The runnable loop is
 * scripts/launch_worker.ts.
 */
import { randomInt } from "crypto";
import { LookupAddress, LookupAllOptions, lookup as dnsLookup } from "dns";
import { ClientRequest, RequestOptions, request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { BlockList, isIP } from "net";
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
  /** Too close to expiry to create: refund now with refund_ticket (the launch authority may refund at any time). */
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

/**
 * Whether an external check's failure may pass on a retry: a timeout, a dropped or refused connection, a DNS hiccup,
 * or an HTTP 408 / 425 / 429 / 5xx from the metadata host, the image host or the X API. The worker retries those
 * until the ticket nears expiry, then refunds. Everything else (bad JSON, a wrong content type, a 404, a blocked
 * private address, too many redirects, a tweet that doesn't mention the ticker) is final: refund at once.
 */
export function isTransientCheckFailure(reason: string): boolean {
  if (/refusing non-public address|EBLOCKED|too many redirects|response too large|refusing \w+: URL|bad URL/i.test(reason)) return false;
  if (/(returned|X API returned) (408|425|429|5\d\d)\b/.test(reason)) return true;
  // A body cut off mid-download surfaces as "aborted". ENOTFOUND (the name doesn't exist) is final; EAI_AGAIN (the
  // resolver didn't answer) is not.
  return /(unreachable|X API error):.*(timeout|timed out|aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|network)/i.test(reason);
}

const ALLOWED_URI = /^(https:\/\/|ipfs:\/\/|ar:\/\/)/i;

/** Ranges a user-supplied URL must never reach (private, loopback, link-local, metadata, multicast, reserved). */
const BLOCKED = (() => {
  const b = new BlockList();
  for (const [net, bits] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
    ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ] as const) b.addSubnet(net, bits, "ipv4");
  for (const [net, bits] of [
    ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ] as const) b.addSubnet(net, bits, "ipv6");
  return b;
})();

/** True only for a globally routable unicast address. IPv4-mapped IPv6 is judged by its IPv4 part. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !BLOCKED.check(ip, "ipv4");
  if (family !== 6) return false;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return !BLOCKED.check(mapped[1], "ipv4");
  if (/^::ffff:/i.test(ip)) return false;
  return !BLOCKED.check(ip, "ipv6");
}

type LookupFn = NonNullable<RequestOptions["lookup"]>;

/**
 * DNS lookup that refuses non-public answers. It's the lookup the socket
 * connects with, so the check and the connection use the same address (no
 * DNS-rebinding window between them).
 */
export const publicOnlyLookup: LookupFn = (hostname, options, callback) => {
  dnsLookup(hostname, { ...(options as LookupAllOptions), all: true }, (err, addrs) => {
    const cb = callback as unknown as (e: Error | null, a?: unknown, f?: number) => void;
    if (err) return cb(err);
    const list = addrs as LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad || list.length === 0) return cb(Object.assign(new Error(`refusing non-public address ${bad?.address ?? "(none)"} for ${hostname}`), { code: "EBLOCKED" }));
    if ((options as LookupAllOptions)?.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
};

export interface SafeGetOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Tests only: allow http: and a permissive lookup against a local server. */
  allowHttp?: boolean;
  lookup?: LookupFn;
}

/**
 * GET a user-supplied URL safely: https only, every hop's address checked by
 * `publicOnlyLookup`, at most `maxRedirects` redirects (each re-validated), an
 * overall timeout, and the body read as a stream that's cut off as soon as it
 * passes `maxBytes`.
 */
export interface SafeGetResult {
  status: number;
  body: string;
  contentType: string;
}

export function safeGet(url: string, opts: SafeGetOptions = {}): Promise<SafeGetResult> {
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  return new Promise((resolve, reject) => {
    let current: ClientRequest | undefined;
    const timer = setTimeout(() => {
      current?.destroy();
      reject(new Error("timeout"));
    }, opts.timeoutMs ?? 5_000);
    const fail = (e: Error) => {
      clearTimeout(timer);
      reject(e);
    };
    const hop = (target: string, redirects: number) => {
      let u: URL;
      try {
        u = new URL(target);
      } catch {
        return fail(new Error(`bad URL ${target}`));
      }
      const transport = u.protocol === "https:" ? httpsRequest : u.protocol === "http:" && opts.allowHttp ? httpRequest : null;
      if (!transport) return fail(new Error(`refusing ${u.protocol} URL`));
      current = transport(u, { method: "GET", lookup: opts.lookup ?? publicOnlyLookup, headers: { accept: "application/json" } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects >= maxRedirects) return fail(new Error("too many redirects"));
          return hop(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        const declared = Number(res.headers["content-length"] ?? "0");
        if (declared > maxBytes) {
          res.destroy();
          return fail(new Error("response too large"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            return fail(new Error("response too large"));
          }
          chunks.push(c);
        });
        res.on("end", () => {
          clearTimeout(timer);
          resolve({ status, body: Buffer.concat(chunks).toString("utf8"), contentType: String(res.headers["content-type"] ?? "") });
        });
        res.on("error", fail);
      });
      current.on("error", fail);
      current.end();
    };
    hop(url, 0);
  });
}

const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)\b/i;
const toGateway = (u: string) => u.replace(/^ipfs:\/\//i, "https://ipfs.io/ipfs/").replace(/^ar:\/\//i, "https://arweave.net/");

/**
 * Metadata JSON must be reachable and name an image that is itself reachable
 * and a PNG, JPEG, WebP or GIF of at most 5 MB (BACKEND_SPEC §3.1). Both
 * fetches go through `safeGet`; `ipfs://` / `ar://` go through `gateway`.
 */
export async function checkMetadataUri(
  uri: string,
  opts: { get?: (url: string, maxBytes: number) => Promise<SafeGetResult>; gateway?: (u: string) => string } & SafeGetOptions = {},
): Promise<string | null> {
  const gateway = opts.gateway ?? toGateway;
  const get = opts.get ?? ((u: string, maxBytes: number) => safeGet(u, { ...opts, maxBytes }));
  if (!ALLOWED_URI.test(uri)) return "metadata URI must be https://, ipfs:// or ar://";
  let image: string;
  try {
    const res = await get(gateway(uri), opts.maxBytes ?? 1_000_000);
    if (res.status < 200 || res.status >= 300) return `metadata URI returned ${res.status}`;
    const json = JSON.parse(res.body) as { image?: unknown };
    if (typeof json.image !== "string" || json.image.length === 0) return "metadata JSON has no image";
    image = json.image;
  } catch (e) {
    return `metadata URI unreachable: ${(e as Error)?.message ?? e}`;
  }
  if (!ALLOWED_URI.test(image)) return "image URI must be https://, ipfs:// or ar://";
  try {
    const res = await get(gateway(image), 5_000_000);
    if (res.status < 200 || res.status >= 300) return `image returned ${res.status}`;
    if (!IMAGE_TYPES.test(res.contentType)) return `image has unsupported content-type ${res.contentType || "(none)"}`;
    return null;
  } catch (e) {
    return `image unreachable: ${(e as Error)?.message ?? e}`;
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

/**
 * POST /live/input: a coin's creator gets their Cloudflare Stream live input, to go live from OBS or any encoder
 * (RTMPS / SRT). Not WebRTC (WHIP): Stream can't play a WHIP broadcast over HLS, which is what viewers here use.
 *
 * - Who: `Authorization: Bearer <chat session token>` (src/session.ts) proves the wallet; the coin's on-chain
 *   bonding curve (src/solana.ts) must name that wallet as `creator`. Nothing else qualifies, so demo coins (not on
 *   chain) and everyone but the creator get 403 or 404.
 * - What: one live input per coin, found by `meta.mint` and reused; created the first time with
 *   `meta {mint, creator, title}` and automatic recording. A new title updates `meta.title`. The answer carries the
 *   stream key, so it is never cached.
 * - Races: two first-time requests for a coin (a double click, two devices) both find no input. The create carries an
 *   `Idempotency-Key` for the mint and a 10-minute window, so Cloudflare makes one input and answers both with it. The
 *   window keeps a key from pointing at an input deleted long ago.
 * Needs CF_STREAM_TOKEN with Stream Write (create/update), plus CF_ACCOUNT_ID, STREAM_HOST and SOLANA_RPC_URL; without
 * them it answers 503. Fails closed on every upstream error.
 */
import { isAddress } from "../../../app/src/lib/chatMessage";
import { hlsUrl, resetLiveCache, streamHost, type LiveEnv } from "./live";
import { curveCreator, PARABULL_PROGRAM_ID } from "./solana";

export interface BroadcastEnv extends LiveEnv {
  /** Solana JSON-RPC for the cluster the program is on. */
  SOLANA_RPC_URL?: string;
  /** Overrides the IDL's program id (another cluster's deployment). */
  PARABULL_PROGRAM_ID?: string;
}

export interface BroadcastInput {
  input: string;
  mint: string;
  title: string | null;
  rtmps: { url: string; streamKey: string } | null;
  srt: { url: string; streamId: string; passphrase: string } | null;
  /** What viewers play (the same input id). */
  hls: string;
}

export type BroadcastResult = { ok: true; value: BroadcastInput } | { ok: false; status: number; error: string };

export const MAX_TITLE = 80;
/** How long one create key stays the same: long enough to cover racing requests, short enough to go stale quickly. */
export const CREATE_KEY_WINDOW_MS = 10 * 60_000;

export const createKey = (mint: string, now: number) => `parabull-live-input:${mint}:${Math.floor(now / CREATE_KEY_WINDOW_MS)}`;

type Fetch = typeof fetch;
interface CfInput {
  uid?: unknown;
  meta?: unknown;
  rtmps?: { url?: unknown; streamKey?: unknown };
  srt?: { url?: unknown; streamId?: unknown; passphrase?: unknown };
}

const s = (v: unknown) => (typeof v === "string" && v ? v : null);

function shape(i: CfInput, mint: string, host: string): BroadcastInput | null {
  const uid = s(i.uid);
  if (!uid || !/^[0-9a-f]{32}$/.test(uid)) return null;
  const meta = (typeof i.meta === "object" && i.meta !== null ? i.meta : {}) as Record<string, unknown>;
  const rtmps = s(i.rtmps?.url) && s(i.rtmps?.streamKey) ? { url: i.rtmps!.url as string, streamKey: i.rtmps!.streamKey as string } : null;
  const srt = s(i.srt?.url) && s(i.srt?.streamId) && s(i.srt?.passphrase) ? { url: i.srt!.url as string, streamId: i.srt!.streamId as string, passphrase: i.srt!.passphrase as string } : null;
  return { input: uid, mint, title: s(meta.title), rtmps, srt, hls: hlsUrl(host, uid) };
}

export async function broadcastInput(env: BroadcastEnv, wallet: string, body: unknown, fetchImpl: Fetch = fetch, now = Date.now()): Promise<BroadcastResult> {
  const host = streamHost(env.STREAM_HOST);
  if (!env.CF_ACCOUNT_ID || !/^[0-9a-f]{32}$/.test(env.CF_ACCOUNT_ID) || !env.CF_STREAM_TOKEN || !host || !env.SOLANA_RPC_URL) return { ok: false, status: 503, error: "going live is not configured" };
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!isAddress(b.mint)) return { ok: false, status: 400, error: "mint must be a Solana address" };
  const mint = b.mint;
  if (b.title !== undefined && typeof b.title !== "string") return { ok: false, status: 400, error: "title must be text" };
  const title = typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, MAX_TITLE) : null;

  // Only the coin's on-chain creator.
  const creator = await curveCreator(env.SOLANA_RPC_URL, mint, env.PARABULL_PROGRAM_ID || PARABULL_PROGRAM_ID, fetchImpl);
  if (!creator.ok) return creator;
  if (creator.creator !== wallet) return { ok: false, status: 403, error: "only the wallet that launched this coin can go live on it" };

  const api = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/live_inputs`;
  const auth = { authorization: `Bearer ${env.CF_STREAM_TOKEN}` };
  const call = async (url: string, init: RequestInit = {}, extra: Record<string, string> = {}): Promise<{ ok: boolean; result: unknown }> => {
    try {
      const res = await fetchImpl(url, { ...init, headers: { ...auth, ...(init.body ? { "content-type": "application/json" } : {}), ...extra } });
      const json = (await res.json()) as { success?: boolean; result?: unknown };
      return { ok: res.ok && json.success === true, result: json.result };
    } catch {
      return { ok: false, result: null };
    }
  };

  const list = await call(api);
  const inputs = (list.result as { liveInputs?: unknown } | null)?.liveInputs;
  if (!list.ok || !Array.isArray(inputs)) return { ok: false, status: 502, error: "Stream API unavailable" };
  const existing = (inputs as CfInput[]).find((i) => {
    const m = (typeof i.meta === "object" && i.meta !== null ? i.meta : {}) as Record<string, unknown>;
    return m.mint === mint && typeof i.uid === "string";
  });

  let got: { ok: boolean; result: unknown };
  if (!existing) {
    got = await call(
      api,
      { method: "POST", body: JSON.stringify({ meta: { mint, creator: wallet, ...(title ? { title } : {}) }, recording: { mode: "automatic" }, enabled: true }) },
      { "idempotency-key": createKey(mint, now) },
    );
  } else {
    const meta: Record<string, unknown> = { ...(existing.meta as Record<string, unknown>), mint, creator: wallet };
    if (title && meta.title !== title) {
      got = await call(`${api}/${existing.uid}`, { method: "PUT", body: JSON.stringify({ meta: { ...meta, title } }) });
      resetLiveCache();
    } else {
      // The list omits credentials; the single input has them.
      got = await call(`${api}/${existing.uid}`);
    }
  }
  const value = got.ok && got.result ? shape(got.result as CfInput, mint, host) : null;
  if (!value) return { ok: false, status: 502, error: "Stream API didn't return the live input" };
  return { ok: true, value };
}

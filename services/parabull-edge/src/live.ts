/**
 * GET /live: which coins are streaming right now, for the app's Stream player.
 *
 * Cloudflare Stream has one live input per broadcaster; an input created for a coin carries `meta.mint` (and
 * optionally `meta.title`, `meta.creator`). The list endpoint has no live status, so each input's public `lifecycle`
 * endpoint answers `{ isInput, videoUID, live }`, and only inputs with `live: true` are returned. A live input's id
 * plays its current broadcast directly: https://<STREAM_HOST>/<input id>/manifest/video.m3u8
 * (developers.cloudflare.com/stream/stream-live/watch-live-stream).
 *
 * The answer is cached for LIVE_TTL_MS per isolate (and for browsers/CDN by Cache-Control), so a busy page costs
 * one Stream API call and N lifecycle checks per 15 seconds, not per visitor. Fails closed: without CF_ACCOUNT_ID,
 * CF_STREAM_TOKEN and STREAM_HOST it answers 503, and an upstream failure answers 502 rather than "nobody is live".
 */
import { isAddress } from "../../../app/src/lib/chatMessage";

export const LIVE_TTL_MS = 15_000;
/** Inputs examined per refresh (the list isn't paginated beyond this; more inputs need a smarter index). */
export const MAX_INPUTS = 100;

export interface LiveEnv {
  CF_ACCOUNT_ID?: string;
  /** API token with Stream Read (wrangler secret put CF_STREAM_TOKEN). */
  CF_STREAM_TOKEN?: string;
  /** customer-<code>.cloudflarestream.com */
  STREAM_HOST?: string;
}

export interface LiveEntry {
  mint: string;
  /** Live input id: plays the input's current broadcast. */
  input: string;
  title: string | null;
  creator: string | null;
  hls: string;
}

export type LiveResult = { ok: true; streams: LiveEntry[] } | { ok: false; status: number; error: string };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const INPUT_ID = /^[0-9a-f]{32}$/;

/** The Stream host as a bare hostname (customer-<code>.cloudflarestream.com), or null. */
export function streamHost(raw: string | undefined): string | null {
  if (!raw) return null;
  const host = raw.replace(/^https:\/\//, "").replace(/\/+$/, "");
  return /^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(host) ? host : null;
}

export const hlsUrl = (host: string, input: string) => `https://${host}/${input}/manifest/video.m3u8`;

let cache: { at: number; key: string; result: LiveResult } | null = null;
export const resetLiveCache = () => void (cache = null);

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function liveStreams(env: LiveEnv, now: number, fetchImpl: Fetch = fetch): Promise<LiveResult> {
  const host = streamHost(env.STREAM_HOST);
  if (!env.CF_ACCOUNT_ID || !/^[0-9a-f]{32}$/.test(env.CF_ACCOUNT_ID) || !env.CF_STREAM_TOKEN || !host) return { ok: false, status: 503, error: "live streams are not configured" };
  const key = `${env.CF_ACCOUNT_ID}:${host}`;
  if (cache && cache.key === key && now - cache.at < LIVE_TTL_MS) return cache.result;

  let inputs: { uid?: unknown; meta?: unknown; enabled?: unknown }[];
  try {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/live_inputs`, { headers: { authorization: `Bearer ${env.CF_STREAM_TOKEN}` } });
    const json = (await res.json()) as { success?: boolean; result?: { liveInputs?: unknown } };
    if (!res.ok || !json.success || !Array.isArray(json.result?.liveInputs)) return { ok: false, status: 502, error: `Stream API answered ${res.status}` };
    inputs = json.result!.liveInputs as typeof inputs;
  } catch {
    return { ok: false, status: 502, error: "Stream API unreachable" };
  }

  const candidates = inputs
    .filter((i) => typeof i.uid === "string" && INPUT_ID.test(i.uid) && i.enabled !== false)
    .map((i) => {
      const meta = (typeof i.meta === "object" && i.meta !== null ? i.meta : {}) as Record<string, unknown>;
      return { input: i.uid as string, mint: meta.mint, title: str(meta.title ?? meta.name, 120), creator: isAddress(meta.creator) ? (meta.creator as string) : null };
    })
    .filter((c): c is typeof c & { mint: string } => isAddress(c.mint))
    .slice(0, MAX_INPUTS);

  // One lifecycle check per input, in parallel; an input whose check fails counts as not live.
  const checks = await Promise.all(
    candidates.map(async (c) => {
      try {
        const res = await fetchImpl(`https://${host}/${c.input}/lifecycle`, { headers: { authorization: `Bearer ${env.CF_STREAM_TOKEN}` } });
        if (!res.ok) return false;
        const j = (await res.json()) as { isInput?: unknown; live?: unknown };
        return j.isInput === true && j.live === true;
      } catch {
        return false;
      }
    }),
  );
  const streams: LiveEntry[] = candidates.filter((_, i) => checks[i]).map((c) => ({ mint: c.mint, input: c.input, title: c.title, creator: c.creator, hls: hlsUrl(host, c.input) }));
  const result: LiveResult = { ok: true, streams };
  cache = { at: now, key, result };
  return result;
}

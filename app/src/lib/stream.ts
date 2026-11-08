/**
 * Cloudflare Stream live playback: what the edge Worker's GET /live returns (services/parabull-edge/src/live.ts) and
 * how the app checks it. Pure, unit-tested (test/stream.test.ts).
 *
 * A live input's id plays its current broadcast: https://customer-<code>.cloudflarestream.com/<input>/manifest/video.m3u8.
 * The app rebuilds that URL from VITE_STREAM_HOST rather than trusting the one in the response, so the player only ever
 * loads from this deployment's Stream host (which the CSP allows, and nothing else).
 */
import { isAddress } from "./chatMessage";

export interface LiveStream {
  /** The coin being streamed. */
  mint: string;
  /** Cloudflare Stream live input id. */
  input: string;
  title: string | null;
  /** Wallet that streams, when the input names one. */
  creator: string | null;
  /** HLS manifest of the input's current broadcast. */
  hls: string;
}

/** VITE_STREAM_HOST as a bare customer-<code>.cloudflarestream.com, or null for anything else. */
export function streamHostOf(raw: string | undefined): string | null {
  if (!raw) return null;
  const host = raw.replace(/^https:\/\//, "").replace(/\/+$/, "");
  return /^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(host) ? host : null;
}

export const liveHlsUrl = (host: string, input: string) => `https://${host}/${input}/manifest/video.m3u8`;

/** The streams in a GET /live answer that are well formed and play from `host`; anything else is dropped. */
export function parseLiveList(json: unknown, host: string): LiveStream[] {
  const list = (json as { streams?: unknown } | null)?.streams;
  if (!Array.isArray(list)) return [];
  const out: LiveStream[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.input !== "string" || !/^[0-9a-f]{32}$/.test(s.input) || !isAddress(s.mint)) continue;
    if (out.some((o) => o.input === s.input)) continue;
    out.push({
      mint: s.mint,
      input: s.input,
      title: typeof s.title === "string" && s.title.trim() ? s.title.trim().slice(0, 120) : null,
      creator: isAddress(s.creator) ? s.creator : null,
      hls: liveHlsUrl(host, s.input),
    });
  }
  return out;
}

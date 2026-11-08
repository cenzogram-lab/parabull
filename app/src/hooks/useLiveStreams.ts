/**
 * Which coins are streaming now (the edge Worker's GET /live), shared by every component that asks: one poll for
 * the whole app, every 20 seconds while anything is subscribed and the tab is visible, at once when it becomes
 * visible again.
 *
 * Configured when the build has both the edge Worker (VITE_CHAT_URL, its origin) and a Stream host
 * (VITE_STREAM_HOST). Otherwise `configured` is false and the app shows its demo streams as before.
 */
import { useSyncExternalStore } from "react";
import { CONFIG } from "../config";
import { chatEndpoints } from "../lib/chatClient";
import { parseLiveList, streamHostOf, type LiveStream } from "../lib/stream";

export interface LiveState {
  configured: boolean;
  /** At least one answer has arrived. */
  loaded: boolean;
  streams: LiveStream[];
  error: string | null;
}

const POLL_MS = 20_000;
const endpoint = chatEndpoints(CONFIG.chatUrl)?.live ?? null;
const host = streamHostOf(CONFIG.streamHost);
const configured = !!(endpoint && host);

let state: LiveState = { configured, loaded: false, streams: [], error: null };
const listeners = new Set<() => void>();
let timer: number | undefined;
let inflight = false;

function set(next: Partial<LiveState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

async function refresh() {
  if (!configured || inflight || document.visibilityState === "hidden") return;
  inflight = true;
  try {
    const res = await fetch(endpoint!, { headers: { accept: "application/json" } });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) set({ loaded: true, error: (json as { error?: string } | null)?.error ?? `Live list unavailable (${res.status})` });
    else set({ loaded: true, error: null, streams: parseLiveList(json, host!) });
  } catch {
    set({ loaded: true, error: "Live list unreachable" });
  } finally {
    inflight = false;
  }
}

const onVisible = () => document.visibilityState === "visible" && void refresh();

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (configured && listeners.size === 1) {
    void refresh();
    timer = window.setInterval(() => void refresh(), POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      timer = undefined;
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

export const useLiveStreams = (): LiveState => useSyncExternalStore(subscribe, () => state);

/**
 * The callout feed for MarketState, one hook per mode.
 * - Chain mode: the edge Worker's GET /callouts (the newest 100, refreshed every minute, plus each coin page's own),
 *   and POST /callouts as the connected wallet after it signs in to the edge (the same session as chat).
 * - Demo mode: the seeded callouts, and ones you post this visit (nothing leaves the browser).
 */
import { useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONFIG } from "../config";
import { normalizeCalloutText, type CalloutJson } from "../lib/callouts";
import { chatEndpoints } from "../lib/chatClient";
import { CalloutsClient, CalloutsError, mergeCallouts, toCallout } from "../lib/calloutsClient";
import { dropSession, signInToEdge } from "../lib/edgeSession";
import type { Callout, Coin } from "../lib/types";

export interface CalloutFeed {
  callouts: Callout[];
  /** Posts a callout as the connected wallet. Throws with a message to show. */
  postCallout: (mint: string, text: string) => Promise<Callout>;
  /** Chain mode: loads a coin's own callouts too (the feed holds the newest 100). */
  loadCalloutsFor: (mint: string) => void;
  /** Chain mode: loads a wallet's own callouts too. */
  loadCalloutsBy: (wallet: string) => void;
  /** A callout by id (a /c/:id link): the loaded feed first, else the Worker. null: there's no such callout. */
  findCallout: (id: string) => Promise<Callout | null>;
  /** "demo": posts stay in this visit; "ready": posts go to the edge Worker; "unconfigured": no Worker (VITE_CHAT_URL). */
  calloutPosting: "demo" | "ready" | "unconfigured";
}

const REFRESH_MS = 60_000;
const noop = () => undefined;

export function useChainCallouts(solUsd: number): CalloutFeed {
  const client = useMemo(() => {
    const e = chatEndpoints(CONFIG.chatUrl);
    return e ? { api: new CalloutsClient(e.callouts), session: e.session } : null;
  }, []);
  const { publicKey, signMessage } = useWallet();
  const [raw, setRaw] = useState<CalloutJson[]>([]);
  const add = useCallback((list: CalloutJson[]) => setRaw((prev) => mergeCallouts(prev, list)), []);
  const loadedMints = useRef(new Set<string>());

  useEffect(() => {
    if (!client) return;
    let stop = false;
    const load = () => void client.api.list({ limit: 100 }).then((p) => !stop && add(p.callouts)).catch(() => undefined);
    load();
    const t = window.setInterval(load, REFRESH_MS);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [client, add]);

  /** One load per coin or author per visit (a failed one may be retried). */
  const loadOnce = useCallback(
    (key: string, q: { mint?: string; author?: string }) => {
      if (!client || loadedMints.current.has(key)) return;
      loadedMints.current.add(key);
      client.api.list({ ...q, limit: 100 }).then((p) => add(p.callouts), () => loadedMints.current.delete(key));
    },
    [client, add],
  );
  const loadCalloutsFor = useCallback((mint: string) => loadOnce(`mint:${mint}`, { mint }), [loadOnce]);
  const loadCalloutsBy = useCallback((wallet: string) => loadOnce(`author:${wallet}`, { author: wallet }), [loadOnce]);

  const postCallout = useCallback(
    async (mint: string, text: string) => {
      if (!client) throw new Error("Callouts aren't set up here");
      const wallet = publicKey?.toBase58();
      if (!wallet) throw new Error("Connect a wallet to post a callout");
      const clean = normalizeCalloutText(text);
      if (!clean) throw new Error("Write 1-280 characters");
      const session = await signInToEdge(client.session, wallet, signMessage);
      try {
        const c = await client.api.post(session.token, mint, clean);
        add([c]);
        return toCallout(c, solUsd);
      } catch (e) {
        if (e instanceof CalloutsError && e.status === 401) {
          dropSession(wallet);
          throw new Error("Your session expired: post again to sign in");
        }
        throw e;
      }
    },
    [client, publicKey, signMessage, add, solUsd],
  );

  const callouts = useMemo(() => raw.map((c) => toCallout(c, solUsd)), [raw, solUsd]);
  const rawRef = useRef(raw);
  rawRef.current = raw;
  const findCallout = useCallback(
    async (id: string) => {
      const known = rawRef.current.find((c) => c.id === id);
      if (known) return toCallout(known, solUsd);
      if (!client) return null;
      const c = await client.api.get(id);
      if (c) add([c]);
      return c && toCallout(c, solUsd);
    },
    [client, add, solUsd],
  );

  return { callouts, postCallout, loadCalloutsFor, loadCalloutsBy, findCallout, calloutPosting: client ? "ready" : "unconfigured" };
}

/** Demo: the seeded callouts plus this visit's own, which never leave the browser. */
export function useDemoCallouts(seeded: Callout[], byMint: Map<string, Coin>): CalloutFeed {
  const [mine, setMine] = useState<Callout[]>([]);
  const callouts = useMemo(() => [...mine, ...seeded], [mine, seeded]);
  const byMintRef = useRef(byMint);
  byMintRef.current = byMint;
  const postCallout = useCallback(async (mint: string, text: string) => {
    const clean = normalizeCalloutText(text);
    if (!clean) throw new Error("Write 1-280 characters");
    const coin = byMintRef.current.get(mint);
    if (!coin) throw new Error("Unknown coin");
    const c: Callout = { id: `demo-${Date.now().toString(36)}`, handle: "you", wallet: null, text: clean, mint, calledAtMcap: coin.mcapUsd, ts: Date.now(), position: null, engagement: { views: 0, comments: 0, likes: 0, shares: 0 } };
    setMine((m) => [c, ...m]);
    return c;
  }, []);
  const calloutsRef = useRef(callouts);
  calloutsRef.current = callouts;
  const findCallout = useCallback(async (id: string) => calloutsRef.current.find((c) => c.id === id) ?? null, []);
  return { callouts, postCallout, loadCalloutsFor: noop, loadCalloutsBy: noop, findCallout, calloutPosting: "demo" };
}

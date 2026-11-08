/**
 * The edge Worker's callouts API (services/parabull-edge/src/callouts.ts) from the browser, and the mapping from its
 * JSON to the app's Callout. Posting needs the wallet's edge session (src/lib/edgeSession.ts).
 */
import { shortAddr } from "./format";
import type { CalloutJson, CalloutPage } from "./callouts";
import type { Callout, Coin } from "./types";

export class CalloutsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function body<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !json) throw new CalloutsError(res.status, json?.error ?? `callouts answered ${res.status}`);
  return json;
}

export class CalloutsClient {
  /** `base` is the Worker's /callouts URL (chatEndpoints(...).callouts). */
  constructor(readonly base: string) {}

  async list(q: { mint?: string; author?: string; ids?: string[]; limit?: number } = {}): Promise<CalloutPage> {
    const p = new URLSearchParams();
    if (q.mint) p.set("mint", q.mint);
    if (q.author) p.set("author", q.author);
    if (q.ids?.length) p.set("ids", q.ids.join(","));
    p.set("limit", String(q.limit ?? 100));
    return body<CalloutPage>(await fetch(`${this.base}?${p}`, { signal: AbortSignal.timeout(15_000) }));
  }

  /** null when there's no such callout. */
  async get(id: string): Promise<CalloutJson | null> {
    const res = await fetch(`${this.base}/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    return (await body<{ callout: CalloutJson }>(res)).callout;
  }

  async post(token: string, mint: string, text: string): Promise<CalloutJson> {
    const res = await fetch(this.base, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ mint, text }), signal: AbortSignal.timeout(20_000) });
    return (await body<{ callout: CalloutJson }>(res)).callout;
  }
}

/** A stored callout as the views show it: market cap at the call in USD at today's SOL price; no position or engagement. */
export function toCallout(c: CalloutJson, solUsd: number): Callout {
  return { id: c.id, handle: shortAddr(c.wallet, 4), wallet: c.wallet, text: c.text, mint: c.mint, calledAtMcap: c.calledAtMcapSol * solUsd, ts: c.ts, position: null, engagement: null };
}

/** Newest first, one of each id. */
export function mergeCallouts(...lists: CalloutJson[][]): CalloutJson[] {
  const by = new Map<string, CalloutJson>();
  for (const list of lists) for (const c of list) by.set(c.id, c);
  return [...by.values()].sort((a, b) => b.ts - a.ts);
}

/** The coin's market-cap move since the call (0.5 = up 50%). */
export const calloutMove = (c: Pick<Callout, "calledAtMcap">, coin: Pick<Coin, "mcapUsd">) => (c.calledAtMcap > 0 ? coin.mcapUsd / c.calledAtMcap - 1 : 0);

/** Best callouts first: by the caller's PnL when there's a position (demo), else by the move since the call. */
export function byCalloutResult(byMint: Map<string, Coin>) {
  const score = (c: Callout) => {
    const coin = byMint.get(c.mint);
    return c.position ? c.position.pnlUsd : coin ? calloutMove(c, coin) : -Infinity;
  };
  return (a: Callout, b: Callout) => score(b) - score(a);
}

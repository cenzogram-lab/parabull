/**
 * Callouts (app/src/lib/callouts.ts): a wallet's public call on a coin it holds.
 *
 *   POST /callouts      { mint, text } with a session token (src/session.ts). The Worker checks, before storing:
 *                       the wallet holds at least CALLOUT_MIN_HOLDING of the coin (Solana RPC, getTokenAccountsByOwner),
 *                       and the coin's market cap and price now (the indexer's GET /coins/:mint), which become the
 *                       "called at" figures. Then the CalloutStore object stores it, unless the wallet is over its limits.
 *   GET  /callouts      newest first; filters mint=, author=, ids=a,b,c (at most 100); paged by before=<cursor>.
 *   GET  /callouts/:id  one callout.
 *
 * Storage is one Durable Object (CALLOUT_STORE, src/calloutStoreDO.ts) with SQLite, so the per-wallet limits are
 * checked and applied in one place, one request at a time. CalloutStoreCore is that object's logic; the tests drive it
 * with node:sqlite. Fails closed: without SOLANA_RPC_URL, INDEXER_URL or the binding, posting answers 503.
 */
import { CALLOUT_MIN_HOLDING, isCalloutId, newCalloutId, type CalloutJson, type CalloutPage } from "../../../app/src/lib/callouts";
import { isAddress } from "../../../app/src/lib/chatMessage";
import type { SqlStorage } from "./chatRoom";

/** The one CalloutStore object's name. */
export const CALLOUT_STORE = "callouts";
/** At most one callout per wallet every 30 seconds, 20 a day, and one per coin an hour. */
export const POST_GAP_MS = 30_000;
export const DAILY_LIMIT = 20;
export const SAME_COIN_GAP_MS = 3_600_000;
export const PAGE_MAX = 100;

export interface CalloutStoreDeps {
  now(): number;
  randomBytes(n: number): Uint8Array;
}

type Row = { seq: number; id: string; wallet: string; mint: string; text: string; mcap: number; price: number; holding: string; ts: number };

const toJson = (r: Row): CalloutJson => ({ id: r.id, wallet: r.wallet, mint: r.mint, text: r.text, calledAtMcapSol: Number(r.mcap), calledAtPriceSol: Number(r.price), holding: r.holding, ts: Number(r.ts) });

export type StoreResult = { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string };

/** What the Worker forwards to the store after its checks: who posted, and the coin's figures it looked up. */
export interface NewCallout {
  wallet: string;
  mint: string;
  text: string;
  calledAtMcapSol: number;
  calledAtPriceSol: number;
  holding: string;
}

export class CalloutStoreCore {
  private ready = false;

  constructor(
    private readonly storage: { sql: SqlStorage },
    private readonly deps: CalloutStoreDeps,
  ) {}

  private sql<T = Record<string, unknown>>(q: string, ...b: unknown[]): T[] {
    return this.storage.sql.exec<T>(q, ...b).toArray();
  }

  private schema(): void {
    if (this.ready) return;
    this.sql(
      "CREATE TABLE IF NOT EXISTS callouts (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, wallet TEXT NOT NULL, mint TEXT NOT NULL, text TEXT NOT NULL, mcap REAL NOT NULL, price REAL NOT NULL, holding TEXT NOT NULL, ts INTEGER NOT NULL)",
    );
    this.sql("CREATE INDEX IF NOT EXISTS callouts_wallet ON callouts (wallet, ts)");
    this.sql("CREATE INDEX IF NOT EXISTS callouts_mint ON callouts (mint, seq)");
    this.ready = true;
  }

  /** Stores a callout the Worker has checked, unless the wallet is over a limit. */
  post(c: NewCallout): StoreResult {
    this.schema();
    const now = this.deps.now();
    const last = this.sql<{ ts: number }>("SELECT ts FROM callouts WHERE wallet = ? ORDER BY ts DESC LIMIT 1", c.wallet)[0];
    if (last && now - Number(last.ts) < POST_GAP_MS) return { ok: false, status: 429, error: "one callout every 30 seconds" };
    const today = this.sql<{ n: number }>("SELECT COUNT(*) AS n FROM callouts WHERE wallet = ? AND ts > ?", c.wallet, now - 86_400_000)[0];
    if (Number(today?.n ?? 0) >= DAILY_LIMIT) return { ok: false, status: 429, error: `at most ${DAILY_LIMIT} callouts a day` };
    const sameCoin = this.sql<{ ts: number }>("SELECT ts FROM callouts WHERE wallet = ? AND mint = ? AND ts > ? LIMIT 1", c.wallet, c.mint, now - SAME_COIN_GAP_MS)[0];
    if (sameCoin) return { ok: false, status: 429, error: "one callout per coin an hour" };
    let id = newCalloutId(this.deps.randomBytes);
    while (this.sql("SELECT 1 FROM callouts WHERE id = ?", id).length) id = newCalloutId(this.deps.randomBytes);
    this.sql("INSERT INTO callouts (id, wallet, mint, text, mcap, price, holding, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, c.wallet, c.mint, c.text, c.calledAtMcapSol, c.calledAtPriceSol, c.holding, now);
    return { ok: true, status: 201, body: { callout: { id, wallet: c.wallet, mint: c.mint, text: c.text, calledAtMcapSol: c.calledAtMcapSol, calledAtPriceSol: c.calledAtPriceSol, holding: c.holding, ts: now } satisfies CalloutJson } };
  }

  /** GET /callouts: newest first, filtered and paged. Readers never create tables. */
  list(params: URLSearchParams): StoreResult {
    const where: string[] = [];
    const args: unknown[] = [];
    const mint = params.get("mint");
    const author = params.get("author");
    const ids = params.get("ids");
    const before = params.get("before");
    const limitRaw = params.get("limit") ?? "50";
    if (mint !== null) {
      if (!isAddress(mint)) return { ok: false, status: 400, error: "mint must be a Solana address" };
      where.push("mint = ?");
      args.push(mint);
    }
    if (author !== null) {
      if (!isAddress(author)) return { ok: false, status: 400, error: "author must be a Solana address" };
      where.push("wallet = ?");
      args.push(author);
    }
    if (ids !== null) {
      const list = ids.split(",").filter(Boolean);
      if (!list.length || list.length > PAGE_MAX || !list.every(isCalloutId)) return { ok: false, status: 400, error: `ids must be 1-${PAGE_MAX} callout ids` };
      where.push(`id IN (${list.map(() => "?").join(",")})`);
      args.push(...list);
    }
    if (before !== null) {
      if (!/^\d{1,15}$/.test(before)) return { ok: false, status: 400, error: "bad cursor" };
      where.push("seq < ?");
      args.push(Number(before));
    }
    if (!/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > PAGE_MAX) return { ok: false, status: 400, error: `limit must be 1-${PAGE_MAX}` };
    const limit = Number(limitRaw);
    if (!this.hasTable()) return { ok: true, status: 200, body: { callouts: [], next: null } satisfies CalloutPage };
    const rows = this.sql<Row>(`SELECT * FROM callouts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`, ...args, limit + 1);
    const page = rows.slice(0, limit);
    return { ok: true, status: 200, body: { callouts: page.map(toJson), next: rows.length > limit ? String(page[page.length - 1].seq) : null } satisfies CalloutPage };
  }

  get(id: string): StoreResult {
    if (!isCalloutId(id)) return { ok: false, status: 400, error: "not a callout id" };
    const row = this.hasTable() ? this.sql<Row>("SELECT * FROM callouts WHERE id = ?", id)[0] : undefined;
    return row ? { ok: true, status: 200, body: { callout: toJson(row) } } : { ok: false, status: 404, error: "no such callout" };
  }

  private hasTable(): boolean {
    if (this.ready) return true;
    return this.sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'callouts'").length > 0;
  }

  /** The object's fetch: the Worker's internal requests (POST /post, GET /list, GET /get). */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let r: StoreResult;
    if (request.method === "POST" && url.pathname === "/post") r = this.post((await request.json()) as NewCallout);
    else if (request.method === "GET" && url.pathname === "/list") r = this.list(url.searchParams);
    else if (request.method === "GET" && url.pathname === "/get") r = this.get(url.searchParams.get("id") ?? "");
    else r = { ok: false, status: 404, error: "not found" };
    return Response.json(r, { status: r.status });
  }
}

// ---- The Worker's checks before storing --------------------------------------------------------------------------

export type Lookup<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

/** The wallet's balance of `mint` across its token accounts (either token program), from the RPC. */
export async function walletHolding(rpcUrl: string, wallet: string, mint: string, fetchImpl: typeof fetch = fetch): Promise<Lookup<{ amount: bigint }>> {
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [wallet, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }] }),
    });
    const json = (await res.json()) as { result?: { value: { account: { data: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } } } }[] }; error?: unknown };
    if (!res.ok || json.error || !json.result || !Array.isArray(json.result.value)) return { ok: false, status: 502, error: "Solana RPC error" };
    let amount = 0n;
    for (const a of json.result.value) {
      const info = a.account?.data?.parsed?.info;
      if (info?.mint !== mint || !/^\d{1,20}$/.test(info.tokenAmount?.amount ?? "")) continue;
      amount += BigInt(info.tokenAmount!.amount!);
    }
    return { ok: true, amount };
  } catch {
    return { ok: false, status: 502, error: "Solana RPC unreachable" };
  }
}

/** The coin's market cap and price in SOL now, from the indexer (404: not a Parabull coin). */
export async function coinNow(indexerUrl: string, mint: string, fetchImpl: typeof fetch = fetch): Promise<Lookup<{ mcapSol: number; priceSol: number }>> {
  try {
    const res = await fetchImpl(`${indexerUrl.replace(/\/+$/, "")}/coins/${mint}`, { headers: { accept: "application/json" } });
    if (res.status === 404) return { ok: false, status: 404, error: "not a Parabull coin" };
    const json = (await res.json()) as { mint?: string; mcapSol?: unknown; priceSol?: unknown };
    if (!res.ok || json.mint !== mint || typeof json.mcapSol !== "number" || typeof json.priceSol !== "number" || !Number.isFinite(json.mcapSol) || !Number.isFinite(json.priceSol)) {
      return { ok: false, status: 502, error: "the indexer didn't answer" };
    }
    return { ok: true, mcapSol: json.mcapSol, priceSol: json.priceSol };
  } catch {
    return { ok: false, status: 502, error: "the indexer is unreachable" };
  }
}

export interface CalloutEnv {
  SOLANA_RPC_URL?: string;
  INDEXER_URL?: string;
}

/** Everything POST /callouts checks before the store sees it. */
export async function checkCallout(env: CalloutEnv, wallet: string, mint: string, text: string, fetchImpl: typeof fetch = fetch): Promise<Lookup<{ callout: NewCallout }>> {
  if (!env.SOLANA_RPC_URL || !env.INDEXER_URL) return { ok: false, status: 503, error: "callouts are not configured" };
  const [held, coin] = await Promise.all([walletHolding(env.SOLANA_RPC_URL, wallet, mint, fetchImpl), coinNow(env.INDEXER_URL, mint, fetchImpl)]);
  if (!coin.ok) return coin;
  if (!held.ok) return held;
  if (held.amount < CALLOUT_MIN_HOLDING) return { ok: false, status: 403, error: "you can only call out a coin you hold" };
  return { ok: true, callout: { wallet, mint, text, calledAtMcapSol: coin.mcapSol, calledAtPriceSol: coin.priceSol, holding: held.amount.toString() } };
}

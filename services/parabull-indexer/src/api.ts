/**
 * The indexer's HTTP API and push stream (docs/BACKEND_SPEC.md §5). All reads; nothing here signs or writes.
 *
 *   GET /health                         { ok, coins, tickets, newestSignature }
 *   GET /coins?status=&sort=&limit=&cursor=   { coins: CoinJson[], next }
 *   GET /coins/:mint                     CoinJson (looked up on-chain if not indexed yet; 404 if it isn't a Parabull coin)
 *   GET /coins/:mint/trades?limit=&before=    { trades: TradeJson[], next } newest first
 *   GET /coins/:mint/candles?interval=&limit=  { mint, interval, candles: CandleJson[], partial } oldest first
 *   GET /coins/:mint/holders?limit=      { mint, totalSupply, count, holders: HolderJson[] }
 *   GET /portfolio/:wallet?limit=&before=     { wallet, lamports, holdings: [{ mint, amount, valueSol, coin }], trades, next }
 *   GET /tickets/:ticket                 TicketJson
 *   GET /tickets?payer=                  { tickets: TicketJson[] } most recent first
 *   GET /referrals/:calloutId            { calloutId, buys, volumeLamports, feeLamports, traders, byTrader, byMint, firstAt, lastAt }
 *   GET /referrals?since=&until=&cursor=&limit=   { events, next, coveredFrom } referred buys, oldest first (unix seconds;
 *                                        `next` is the last event's key, so paging never skips events)
 *   GET /rewards                         { epochs, totals, vault } every reward epoch and its artifact's state
 *   GET /rewards/:wallet                 { wallet, allocations, unclaimedLamports, unverifiedEpochs } with proofs
 *   GET /stream[?mint=]                  WebSocket: { type: "coin", coin } | { type: "trade", trade } | { type: "ticket", ticket }
 *
 * Addresses are checked (base58, 32 bytes) before anything else. Requests that reach the RPC (holders, portfolio, a
 * coin not indexed yet) are limited per IP. CORS: ALLOWED_ORIGINS if set, else any origin (the data is public).
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { isAddress } from "../../../app/src/lib/chatMessage";
import { isCalloutId } from "../../../app/src/lib/callouts";
import { parseReferralCursor, referralJson } from "./referrals";
import type { Indexer } from "./indexer";
import { CANDLE_INTERVALS, candlesOf, coinJson, mcapOf, progressOf, statusOf, ticketJson, tradeCursor, tradeJson, type CoinJson, type CoinRecord, type CoinStatus, type TradeRecord } from "./model";
import { RpcError } from "./rpc";
import { page } from "./store";
import { acceptWebSocket, type WsConn } from "./ws";

export interface ApiOptions {
  /** Origins allowed by CORS and on the stream; empty allows any. */
  allowedOrigins?: string[];
  /** RPC-backed requests per IP per minute. */
  rpcRequestsPerMinute?: number;
  /** Take the client IP from X-Forwarded-For (only behind a proxy you trust). */
  trustProxy?: boolean;
  maxStreams?: number;
}

const STATUSES: (CoinStatus | "all")[] = ["all", "new", "active", "graduating", "graduated"];
const SORTS = ["new", "mcap", "volume", "progress", "last_trade"] as const;
type Sort = (typeof SORTS)[number];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function intParam(v: string | null, def: number, max: number): number {
  if (v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "limit must be a positive integer");
  return Math.min(n, max);
}

export class Api {
  private readonly streams = new Set<{ conn: WsConn; mint: string | null }>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly allowed: Set<string>;

  constructor(
    private readonly ix: Indexer,
    private readonly opts: ApiOptions = {},
  ) {
    this.allowed = new Set(opts.allowedOrigins ?? []);
    ix.on("coin", (mint: string) => this.push(mint, () => {
      const c = ix.store.coins.get(mint);
      return c ? { type: "coin", coin: this.coin(c) } : null;
    }));
    ix.on("trade", (t: TradeRecord) => this.push(t.mint, () => {
      const c = ix.store.coins.get(t.mint);
      return { type: "trade", trade: tradeJson(t, c?.totalSupply ?? 0n) };
    }));
    ix.on("ticket", (t) => this.push(null, () => ({ type: "ticket", ticket: ticketJson(t) })));
  }

  private coin(c: CoinRecord): CoinJson {
    return coinJson(c, this.ix.store.trades(c.mint), this.ix.nowSec(), this.ix.coveredFrom(c.mint));
  }

  private push(mint: string | null, build: () => object | null) {
    if (!this.streams.size) return;
    let text: string | undefined;
    for (const s of this.streams) {
      if (s.mint && mint && s.mint !== mint) continue;
      if (s.mint && !mint) continue;
      if (text === undefined) {
        const msg = build();
        if (!msg) return;
        text = JSON.stringify(msg);
      }
      s.conn.send(text);
    }
  }

  private ip(req: IncomingMessage): string {
    if (this.opts.trustProxy) {
      const fwd = req.headers["x-forwarded-for"];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  /** Token bucket per IP for requests that reach the RPC. */
  private allowRpc(req: IncomingMessage): boolean {
    const perMinute = this.opts.rpcRequestsPerMinute ?? 60;
    const now = Date.now();
    const key = this.ip(req);
    const b = this.buckets.get(key) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (this.buckets.size > 50_000) this.buckets.clear();
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private corsOrigin(req: IncomingMessage): string | null {
    const origin = req.headers.origin;
    if (!this.allowed.size) return "*";
    return origin && this.allowed.has(origin) ? origin : null;
  }

  private send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, cache = "no-store") {
    const origin = this.corsOrigin(req);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cache,
      "x-content-type-options": "nosniff",
      ...(origin ? { "access-control-allow-origin": origin } : {}),
      ...(this.allowed.size ? { vary: "origin" } : {}),
    });
    res.end(JSON.stringify(body));
  }

  readonly handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method === "OPTIONS") {
        const origin = this.corsOrigin(req);
        res.writeHead(204, { ...(origin ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "86400" } : {}) });
        return void res.end();
      }
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      const url = new URL(req.url ?? "/", "http://indexer");
      const parts = url.pathname.split("/").filter(Boolean);
      const q = url.searchParams;
      const ix = this.ix;

      if (url.pathname === "/health") return this.send(req, res, 200, { ok: true, coins: ix.store.coins.size, tickets: ix.store.tickets.size, newestSignature: ix.newestSignature });

      if (parts[0] === "coins" && parts.length === 1) {
        const status = (q.get("status") ?? "all") as CoinStatus | "all";
        const sort = (q.get("sort") ?? "new") as Sort;
        if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}`);
        if (!SORTS.includes(sort)) throw new HttpError(400, `sort must be one of ${SORTS.join(", ")}`);
        const limit = intParam(q.get("limit"), 50, 200);
        const cursor = q.get("cursor");
        const offset = cursor === null ? 0 : Number(cursor);
        if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, "bad cursor");
        const now = ix.nowSec();
        const all = [...ix.store.coins.values()].filter((c) => c.name || c.symbol).filter((c) => status === "all" || statusOf(c, now) === status);
        // Sort on cheap keys first; only the page is rendered in full.
        const json = new Map<string, CoinJson>();
        const full = (c: CoinRecord) => json.get(c.mint) ?? (json.set(c.mint, this.coin(c)), json.get(c.mint)!);
        const key: Record<Sort, (c: CoinRecord) => number> = {
          new: (c) => c.launchTimestamp,
          mcap: (c) => mcapOf(c),
          progress: (c) => progressOf(c),
          volume: (c) => Number(full(c).stats.volume24hLamports),
          last_trade: (c) => ix.store.trades(c.mint)[0]?.timestamp ?? 0,
        };
        const sorted = all.sort((a, b) => key[sort](b) - key[sort](a) || (a.mint < b.mint ? -1 : 1));
        const slice = sorted.slice(offset, offset + limit).map(full);
        return this.send(req, res, 200, { coins: slice, next: offset + limit < sorted.length ? String(offset + limit) : null }, "public, max-age=2");
      }

      if (parts[0] === "coins" && parts.length >= 2) {
        const mint = parts[1];
        if (!isAddress(mint)) throw new HttpError(400, "mint must be a Solana address");
        let coin = ix.store.coins.get(mint) ?? null;
        if (!coin) {
          if (!this.allowRpc(req)) throw new HttpError(429, "too many requests");
          coin = await ix.coin(mint);
        }
        if (!coin) throw new HttpError(404, "not a Parabull coin");
        if (parts.length === 2) return this.send(req, res, 200, this.coin(coin), "public, max-age=2");
        if (parts.length === 3 && parts[2] === "trades") {
          const limit = intParam(q.get("limit"), 50, 100);
          const p = page(ix.store.trades(mint), tradeCursor, q.get("before"), limit);
          if (!p) throw new HttpError(400, "unknown `before` cursor");
          return this.send(req, res, 200, { trades: p.items.map((t) => tradeJson(t, coin!.totalSupply)), next: p.next });
        }
        if (parts.length === 3 && parts[2] === "candles") {
          const interval = Number(q.get("interval") ?? 300);
          if (!(CANDLE_INTERVALS as readonly number[]).includes(interval)) throw new HttpError(400, `interval must be one of ${CANDLE_INTERVALS.join(", ")} (seconds)`);
          const candles = candlesOf(ix.store.trades(mint), interval, intParam(q.get("limit"), 300, 1000));
          return this.send(req, res, 200, { mint, interval, candles, partial: ix.coveredFrom(mint) > coin.launchTimestamp }, "public, max-age=2");
        }
        if (parts.length === 3 && parts[2] === "holders") {
          if (!this.allowRpc(req)) throw new HttpError(429, "too many requests");
          return this.send(req, res, 200, await ix.holders(mint, intParam(q.get("limit"), 50, 100)), "public, max-age=10");
        }
      }

      if (parts[0] === "portfolio" && parts.length === 2) {
        const wallet = parts[1];
        if (!isAddress(wallet)) throw new HttpError(400, "wallet must be a Solana address");
        if (!this.allowRpc(req)) throw new HttpError(429, "too many requests");
        const p = await ix.portfolio(wallet);
        const t = page(ix.store.userTrades(wallet), tradeCursor, q.get("before"), intParam(q.get("limit"), 50, 100));
        if (!t) throw new HttpError(400, "unknown `before` cursor");
        return this.send(req, res, 200, {
          ...p,
          holdings: p.holdings.map((h) => ({ ...h, coin: this.coin(ix.store.coins.get(h.mint)!) })),
          trades: t.items.map((x) => tradeJson(x, ix.store.coins.get(x.mint)?.totalSupply ?? 0n)),
          next: t.next,
        });
      }

      if (parts[0] === "referrals" && parts.length === 2) {
        if (!isCalloutId(parts[1])) throw new HttpError(400, "not a callout id");
        return this.send(req, res, 200, ix.referrals.forCallout(parts[1]), "public, max-age=5");
      }
      if (parts[0] === "referrals" && parts.length === 1) {
        const time = (v: string | null, def: number) => {
          if (v === null) return def;
          if (!/^\d{1,12}$/.test(v)) throw new HttpError(400, "since and until are unix seconds");
          return Number(v);
        };
        const since = time(q.get("since"), 0);
        const until = time(q.get("until"), Number.MAX_SAFE_INTEGER);
        const cursor = q.get("cursor");
        if (cursor !== null && !parseReferralCursor(cursor)) throw new HttpError(400, "bad cursor");
        const w = ix.referrals.window(since, until, cursor, intParam(q.get("limit"), 1000, 5000));
        return this.send(req, res, 200, { events: w.events.map(referralJson), next: w.next, coveredFrom: ix.referralsCoveredFrom() });
      }
      if (parts[0] === "rewards" && parts.length === 1) return this.send(req, res, 200, ix.rewards.summary(), "public, max-age=10");
      if (parts[0] === "rewards" && parts.length === 2) {
        if (!isAddress(parts[1])) throw new HttpError(400, "wallet must be a Solana address");
        return this.send(req, res, 200, ix.rewards.forWallet(parts[1]));
      }

      if (parts[0] === "tickets" && parts.length === 2) {
        if (!isAddress(parts[1])) throw new HttpError(400, "ticket must be a Solana address");
        const t = ix.store.tickets.get(parts[1]);
        if (!t) throw new HttpError(404, "unknown ticket");
        return this.send(req, res, 200, ticketJson(t));
      }
      if (parts[0] === "tickets" && parts.length === 1) {
        const payer = q.get("payer");
        if (!isAddress(payer)) throw new HttpError(400, "payer must be a Solana address");
        const tickets = [...ix.store.tickets.values()].filter((t) => t.payer === payer).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(ticketJson);
        return this.send(req, res, 200, { tickets });
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) return this.send(req, res, e.status, { error: e.message });
      if (e instanceof RpcError) return this.send(req, res, 502, { error: "Solana RPC unavailable" });
      return this.send(req, res, 500, { error: "internal error" });
    }
  };

  /** WebSocket upgrades on /stream (optionally ?mint= for one coin's events). */
  readonly upgrade = (req: IncomingMessage, socket: Duplex): void => {
    const url = new URL(req.url ?? "/", "http://indexer");
    const mint = url.searchParams.get("mint");
    const origin = req.headers.origin;
    const refuse = (status: string): void => void socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`);
    if (url.pathname !== "/stream") return refuse("404 Not Found");
    if (this.allowed.size && !(origin && this.allowed.has(origin))) return refuse("403 Forbidden");
    if (mint !== null && !isAddress(mint)) return refuse("400 Bad Request");
    if (this.streams.size >= (this.opts.maxStreams ?? 2_000)) return refuse("503 Service Unavailable");
    const conn = acceptWebSocket(req, socket);
    if (!conn) return;
    const s = { conn, mint };
    this.streams.add(s);
    conn.onClose(() => this.streams.delete(s));
  };

  get streamCount() {
    return this.streams.size;
  }

  /** Closes every stream (shutdown). */
  closeStreams() {
    for (const s of this.streams) s.conn.close(1001);
    this.streams.clear();
  }

  attach(server: Server): Server {
    server.on("request", (req, res) => void this.handle(req, res));
    server.on("upgrade", (req, socket) => this.upgrade(req, socket));
    return server;
  }
}

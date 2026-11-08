/**
 * The Parabull indexer (services/parabull-indexer, docs/BACKEND_SPEC.md §5) from the browser: its REST endpoints, its
 * /stream websocket, and the mapping from its JSON (SOL amounts, u64 as strings) into the app's Coin / Trade / Holder
 * shapes (USD at the current SOL/USD).
 */
import { coinArt } from "./art";
import { shortAddr } from "./format";
import type { RewardsSummaryJson, WalletRewardsJson } from "./rewardsClaim";
import type { Candle, Coin, Holder, Stage, Trade } from "./types";

export interface CoinJson {
  mint: string;
  curve: string;
  creator: string;
  ticket: string | null;
  name: string;
  symbol: string;
  uri: string;
  image: string | null;
  description: string | null;
  socials: { x?: string; website?: string; telegram?: string };
  createdAt: number;
  createdSlot: string;
  tradingOpenSlot: string;
  status: "new" | "active" | "graduating" | "graduated";
  complete: boolean;
  migrated: boolean;
  escrowReleased: boolean;
  reserves: { virtualToken: string; virtualSol: string; realToken: string; realSol: string };
  totalSupply: string;
  priceSol: number;
  mcapSol: number;
  athMcapSol: number;
  progress: number;
  escrowAccruedLamports: string;
  raydiumPool: string | null;
  tweetLocked: boolean;
  holders: number | null;
  stats: {
    volume24hLamports: string;
    buyVolume24hLamports: string;
    sellVolume24hLamports: string;
    trades24h: number;
    buys24h: number;
    sells24h: number;
    traders24h: number;
    change1h: number | null;
    change6h: number | null;
    change24h: number | null;
    spark: number[];
    lastTradeAt: number | null;
    /** The coin traded past the indexer's per-coin limit in a day: the 24h totals are a floor. */
    partial?: boolean;
  };
}

export interface TradeJson {
  signature: string;
  index: number;
  mint: string;
  user: string;
  side: "buy" | "sell";
  tokenAmount: string;
  solAmount: string;
  fee: string;
  slot: number;
  timestamp: number;
  priceSol: number;
  mcapSol: number;
}

export interface HoldersJson {
  mint: string;
  totalSupply: string;
  count: number;
  holders: { owner: string; amount: string; pct: number; label: "bonding_curve" | "migration" | "raydium_pool" | "creator" | null }[];
}

export interface CandleJson {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeSol: number;
}

export interface PortfolioJson {
  wallet: string;
  lamports: string;
  /** costSol: the held amount at the wallet's average indexed buy price (null when no buy is indexed). */
  holdings: { mint: string; amount: string; valueSol: number; costSol: number | null; coin: CoinJson }[];
  trades: TradeJson[];
  next: string | null;
}

export type StreamMessage = { type: "coin"; coin: CoinJson } | { type: "trade"; trade: TradeJson } | { type: "ticket"; ticket: unknown };

export class IndexerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const lamports = (s: string) => Number(s) / 1e9;

export class IndexerClient {
  readonly base: string;
  constructor(base: string) {
    this.base = base.replace(/\/+$/, "");
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.base + path, { signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !json) throw new IndexerError(res.status, json?.error ?? `indexer answered ${res.status}`);
    return json;
  }

  /** Every coin, newest first, page by page: at most `maxPages` pages of 200 (older coins load when opened). */
  async coins(maxPages = 5): Promise<CoinJson[]> {
    const out: CoinJson[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const r: { coins: CoinJson[]; next: string | null } = await this.get(`/coins?sort=new&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      out.push(...r.coins);
      cursor = r.next;
      if (!cursor) break;
    }
    return out;
  }
  /** null when the address isn't a Parabull coin. */
  async coin(mint: string): Promise<CoinJson | null> {
    try {
      return await this.get<CoinJson>(`/coins/${mint}`);
    } catch (e) {
      if (e instanceof IndexerError && e.status === 404) return null;
      throw e;
    }
  }
  async trades(mint: string, limit = 100): Promise<TradeJson[]> {
    return (await this.get<{ trades: TradeJson[] }>(`/coins/${mint}/trades?limit=${limit}`)).trades;
  }
  /** Chart bars built by the indexer from every trade it holds for the coin. */
  async candles(mint: string, intervalSec: number): Promise<CandleJson[]> {
    return (await this.get<{ candles: CandleJson[] }>(`/coins/${mint}/candles?interval=${intervalSec}&limit=500`)).candles;
  }
  holders(mint: string): Promise<HoldersJson> {
    return this.get<HoldersJson>(`/coins/${mint}/holders?limit=50`);
  }
  portfolio(wallet: string): Promise<PortfolioJson> {
    return this.get<PortfolioJson>(`/portfolio/${wallet}?limit=100`);
  }
  /** The wallet's reward allocations (holder and caller epochs) with proofs and on-chain claimed state. */
  rewards(wallet: string): Promise<WalletRewardsJson> {
    return this.get<WalletRewardsJson>(`/rewards/${wallet}`);
  }
  rewardsSummary(): Promise<RewardsSummaryJson> {
    return this.get<RewardsSummaryJson>("/rewards");
  }

  get streamUrl(): string {
    return `${this.base.replace(/^http/, "ws")}/stream`;
  }

  /** The push stream, reconnecting with backoff; returns a stop function. `onOpen` runs on every (re)connect. */
  stream(onMessage: (m: StreamMessage) => void, onOpen?: () => void): () => void {
    let ws: WebSocket | null = null;
    let stopped = false;
    let delay = 1_000;
    let timer: number | undefined;
    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(this.streamUrl);
      ws.onopen = () => {
        delay = 1_000;
        onOpen?.();
      };
      ws.onmessage = (e) => {
        try {
          onMessage(JSON.parse(String(e.data)) as StreamMessage);
        } catch {
          // ignore a malformed frame
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        timer = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }
}

const safeImage = (j: CoinJson) => (j.image && /^https:\/\//.test(j.image) ? j.image : coinArt(j.mint, j.symbol || "?"));

/** The board's stage: graduated, new (first hour), soon (72% sold, or complete and awaiting migration), live. */
export function stageOf(j: CoinJson): Stage {
  if (j.migrated) return "graduated";
  if (j.status === "new") return "new";
  return j.complete || j.progress >= 0.72 ? "soon" : "live";
}

export function toCoin(j: CoinJson, solUsd: number, registryLockSeconds: number): Coin {
  const lock = (j.createdAt + registryLockSeconds) * 1000;
  const priceUsd = j.priceSol * solUsd;
  // Unknown changes stay null: the views show them as unavailable, never as a flat 0%.
  const change1h = j.stats.change1h;
  return {
    mint: j.mint,
    name: j.name || shortAddr(j.mint, 4),
    ticker: j.symbol || "?",
    image: safeImage(j),
    description: j.description ?? "",
    creator: j.creator,
    creatorHandle: shortAddr(j.creator, 4),
    createdAt: j.createdAt * 1000,
    stage: stageOf(j),
    reserves: { virtualToken: BigInt(j.reserves.virtualToken), virtualSol: BigInt(j.reserves.virtualSol), realToken: BigInt(j.reserves.realToken), realSol: BigInt(j.reserves.realSol) },
    complete: j.complete,
    migrated: j.migrated,
    priceUsd,
    mcapUsd: j.mcapSol * solUsd,
    athUsd: j.athMcapSol * solUsd,
    vol24hUsd: lamports(j.stats.volume24hLamports) * solUsd,
    buyVolUsd: lamports(j.stats.buyVolume24hLamports) * solUsd,
    sellVolUsd: lamports(j.stats.sellVolume24hLamports) * solUsd,
    buys24h: j.stats.buys24h,
    sells24h: j.stats.sells24h,
    traders24h: j.stats.traders24h,
    change1h,
    change6h: j.stats.change6h,
    change24h: j.stats.change24h,
    holders: j.holders ?? 0,
    devPct: 0,
    replies: 0,
    locks: { ticker: lock, name: lock, tweet: j.tweetLocked ? lock : null },
    tweetId: null,
    escrowUsd: lamports(j.escrowAccruedLamports) * solUsd,
    escrowReleased: j.escrowReleased,
    spark: j.stats.spark.map((p) => p * solUsd),
    socials: j.socials,
    hot: (change1h ?? 0) > 0.25,
    ...(j.raydiumPool && j.migrated ? { pool: { address: j.raydiumPool, lpLocked: true, feeNft: "", lpFeesUsd: 0 } } : {}),
  };
}

/** A buy's `sol` includes the fee and a sell's is the net payout, as the demo's trades are. */
export function toTrade(t: TradeJson, solUsd: number): Trade {
  const gross = Number(t.solAmount) / 1e9;
  const fee = Number(t.fee) / 1e9;
  return {
    id: `${t.signature}:${t.index}`,
    mint: t.mint,
    side: t.side,
    trader: t.user,
    handle: shortAddr(t.user, 4),
    sol: t.side === "buy" ? gross + fee : gross - fee,
    tokens: Number(t.tokenAmount) / 1e6,
    priceUsd: t.priceSol * solUsd,
    mcapUsd: t.mcapSol * solUsd,
    ts: t.timestamp * 1000,
    sig: t.signature,
  };
}

const LABELS = { bonding_curve: "Bonding curve", migration: "Bonding curve", raydium_pool: "Raydium pool", creator: "Dev" } as const;

/** Holders as the tables show them; PnL isn't known for on-chain holders (null). */
export function toHolders(h: HoldersJson, coin: Pick<Coin, "priceUsd">): Holder[] {
  return h.holders.map((x) => {
    const tokens = Number(x.amount) / 1e6;
    return { address: x.owner, ...(x.label ? { label: LABELS[x.label] } : {}), pct: x.pct, tokens, valueUsd: tokens * coin.priceUsd, pnlUsd: null };
  });
}

/** The indexer's bars in USD; a coin with no trades yet is one flat bar at its current price. */
export function toCandles(bars: CandleJson[], solUsd: number, current: Pick<Coin, "priceUsd">, intervalSec: number, now = Date.now()): Candle[] {
  if (!bars.length) {
    const p = current.priceUsd;
    return [{ time: Math.floor(now / 1000 / intervalSec) * intervalSec, open: p, high: p, low: p, close: p, volume: 0 }];
  }
  return bars.map((b) => ({ time: b.time, open: b.open * solUsd, high: b.high * solUsd, low: b.low * solUsd, close: b.close * solUsd, volume: b.volumeSol * solUsd }));
}

/** Each held coin's token balance and its cost basis (the indexer's average over the wallet's buys; USD at today's SOL price). */
export function positionsFrom(p: PortfolioJson, solUsd: number): Record<string, { tokens: bigint; costUsd: number; basisUsd: number }> {
  const out: Record<string, { tokens: bigint; costUsd: number; basisUsd: number }> = {};
  for (const h of p.holdings) {
    const tokens = BigInt(h.amount);
    // The indexer averages every indexed buy; without one (an airdrop, or older than the index), today's value.
    const cost = (h.costSol ?? h.valueSol) * solUsd;
    out[h.mint] = { tokens, costUsd: cost, basisUsd: cost };
  }
  return out;
}

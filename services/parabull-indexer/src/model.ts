/**
 * What the indexer keeps, and what the API serves (docs/BACKEND_SPEC.md §5).
 *
 * JSON conventions: u64 amounts (lamports, token base units, slots) are decimal strings, so no client loses precision;
 * prices and market caps are SOL as numbers (SOL per whole token, 6 decimals); times are Unix seconds.
 */
export const LAMPORTS_PER_SOL = 1e9;
export const TOKEN_UNIT = 1e6;
/** A coin is "new" for its first hour. */
export const NEW_FOR_SECONDS = 3600;

export interface Socials {
  x?: string;
  website?: string;
  telegram?: string;
}

export interface CoinRecord {
  mint: string;
  curve: string;
  creator: string;
  ticket: string | null;
  name: string;
  symbol: string;
  uri: string;
  /** From the metadata JSON at `uri`, when its host is allowed (METADATA_ORIGINS). */
  image: string | null;
  description: string | null;
  socials: Socials;
  createdSlot: bigint;
  tradingOpenSlot: bigint;
  /** Unix seconds. */
  launchTimestamp: number;
  complete: boolean;
  migrated: boolean;
  escrowReleased: boolean;
  virtualToken: bigint;
  virtualSol: bigint;
  realToken: bigint;
  realSol: bigint;
  totalSupply: bigint;
  /** The curve's real token reserves at launch (Global.initial_real_token_reserves then): progress is measured against it. */
  initialRealToken: bigint;
  /** SOL per whole token at launch, the baseline for price changes older than the first indexed trade. */
  initialPriceSol: number;
  escrowAccrued: bigint;
  raydiumPool: string | null;
  /** SOL per whole token on the Raydium pool, once graduated (read from the pool's vaults). */
  poolPriceSol: number | null;
  tweetLocked: boolean;
  /** The slot the reserves above are as of, so an older snapshot never overwrites a newer trade. */
  reservesSlot: number;
  athMcapSol: number;
  holderCount: number | null;
}

export interface TradeRecord {
  signature: string;
  /** The event's position among this transaction's Parabull events. */
  index: number;
  mint: string;
  user: string;
  isBuy: boolean;
  tokenAmount: bigint;
  solAmount: bigint;
  fee: bigint;
  slot: number;
  timestamp: number;
  /** Curve reserves after the trade. */
  virtualToken: bigint;
  virtualSol: bigint;
  realToken: bigint;
  realSol: bigint;
}

export type TicketState = "pending" | "created" | "refunded" | "closed";
export interface TicketRecord {
  ticket: string;
  payer: string;
  ticker: string;
  depositLamports: bigint;
  createdAt: number;
  expiresAt: number;
  state: TicketState;
  mint: string | null;
}

export const priceSol = (virtualToken: bigint, virtualSol: bigint) => (virtualToken > 0n ? Number(virtualSol) / LAMPORTS_PER_SOL / (Number(virtualToken) / TOKEN_UNIT) : 0);

export const currentPrice = (c: CoinRecord) => (c.migrated && c.poolPriceSol !== null ? c.poolPriceSol : priceSol(c.virtualToken, c.virtualSol));
export const mcapOf = (c: CoinRecord, price = currentPrice(c)) => price * (Number(c.totalSupply) / TOKEN_UNIT);

export function progressOf(c: CoinRecord): number {
  if (c.complete || c.migrated) return 1;
  if (c.initialRealToken <= 0n) return 0;
  const sold = c.initialRealToken - c.realToken;
  return Math.max(0, Math.min(1, Number(sold) / Number(c.initialRealToken)));
}

export type CoinStatus = "new" | "active" | "graduating" | "graduated";
export function statusOf(c: CoinRecord, now: number): CoinStatus {
  if (c.migrated) return "graduated";
  if (c.complete) return "graduating";
  return now - c.launchTimestamp < NEW_FOR_SECONDS ? "new" : "active";
}

export interface CoinStats {
  volume24hLamports: string;
  buyVolume24hLamports: string;
  sellVolume24hLamports: string;
  trades24h: number;
  buys24h: number;
  sells24h: number;
  traders24h: number;
  /** Fractions (0.1 = +10%); null when the indexed history doesn't reach back that far. */
  change1h: number | null;
  change6h: number | null;
  change24h: number | null;
  /** Price (SOL per token) at the end of each of the last 24 hours, oldest first. */
  spark: number[];
  lastTradeAt: number | null;
  /**
   * True when the index doesn't hold every trade of the last 24 h (the startup backfill didn't reach that far, or a
   * coin past 50,000 trades a day had some evicted): the totals are a floor.
   */
  partial: boolean;
}

/**
 * The price at time `t`: after the last indexed trade at or before `t`; else the launch price, if nothing traded
 * before `t` (it launched after `t`, or every trade since launch is held); else null (the history doesn't reach `t`).
 * `coveredFrom`: the index holds every trade of this coin from this time on (-Infinity: since launch).
 */
function priceAt(c: CoinRecord, newestFirst: TradeRecord[], t: number, coveredFrom: number): number | null {
  for (const tr of newestFirst) if (tr.timestamp <= t) return priceSol(tr.virtualToken, tr.virtualSol);
  if (c.launchTimestamp >= t || coveredFrom <= c.launchTimestamp) return c.initialPriceSol;
  return null;
}

/** 24h numbers from the coin's indexed trades (`newestFirst`), given what the index holds (`coveredFrom`, see priceAt). */
export function statsOf(c: CoinRecord, newestFirst: TradeRecord[], now: number, coveredFrom: number): CoinStats {
  const since = now - 86_400;
  let buy = 0n;
  let sell = 0n;
  let buys = 0;
  let sells = 0;
  const traders = new Set<string>();
  for (const t of newestFirst) {
    if (t.timestamp < since) break;
    if (t.isBuy) {
      buy += t.solAmount;
      buys++;
    } else {
      sell += t.solAmount;
      sells++;
    }
    traders.add(t.user);
  }
  const price = currentPrice(c);
  const change = (hours: number) => {
    const then = priceAt(c, newestFirst, now - hours * 3600, coveredFrom);
    return then && then > 0 ? price / then - 1 : null;
  };
  const spark: number[] = [];
  for (let h = 23; h >= 0; h--) {
    const p = priceAt(c, newestFirst, now - h * 3600, coveredFrom);
    spark.push(p ?? spark[spark.length - 1] ?? price);
  }
  // Graduated coins trade on Raydium, which isn't indexed: the last point is the pool's price.
  spark[spark.length - 1] = price;
  return {
    volume24hLamports: String(buy + sell),
    buyVolume24hLamports: String(buy),
    sellVolume24hLamports: String(sell),
    trades24h: buys + sells,
    buys24h: buys,
    sells24h: sells,
    traders24h: traders.size,
    change1h: change(1),
    change6h: change(6),
    change24h: change(24),
    spark,
    lastTradeAt: newestFirst[0]?.timestamp ?? null,
    // The window starts at `since`, or at launch for a younger coin; anything not held from then on is missing.
    partial: coveredFrom > Math.max(since, c.launchTimestamp),
  };
}

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
  socials: Socials;
  createdAt: number;
  createdSlot: string;
  tradingOpenSlot: string;
  status: CoinStatus;
  complete: boolean;
  migrated: boolean;
  escrowReleased: boolean;
  reserves: { virtualToken: string; virtualSol: string; realToken: string; realSol: string };
  totalSupply: string;
  priceSol: number;
  mcapSol: number;
  athMcapSol: number;
  /** Share of the curve's sellable tokens sold, 0..1 (1 once complete). */
  progress: number;
  escrowAccruedLamports: string;
  raydiumPool: string | null;
  tweetLocked: boolean;
  holders: number | null;
  stats: CoinStats;
}

export function coinJson(c: CoinRecord, trades: TradeRecord[], now: number, coveredFrom: number): CoinJson {
  const price = currentPrice(c);
  const mcap = mcapOf(c, price);
  return {
    mint: c.mint,
    curve: c.curve,
    creator: c.creator,
    ticket: c.ticket,
    name: c.name,
    symbol: c.symbol,
    uri: c.uri,
    image: c.image,
    description: c.description,
    socials: c.socials,
    createdAt: c.launchTimestamp,
    createdSlot: String(c.createdSlot),
    tradingOpenSlot: String(c.tradingOpenSlot),
    status: statusOf(c, now),
    complete: c.complete,
    migrated: c.migrated,
    escrowReleased: c.escrowReleased,
    reserves: { virtualToken: String(c.virtualToken), virtualSol: String(c.virtualSol), realToken: String(c.realToken), realSol: String(c.realSol) },
    totalSupply: String(c.totalSupply),
    priceSol: price,
    mcapSol: mcap,
    athMcapSol: Math.max(c.athMcapSol, mcap),
    progress: progressOf(c),
    escrowAccruedLamports: String(c.escrowAccrued),
    raydiumPool: c.raydiumPool,
    tweetLocked: c.tweetLocked,
    holders: c.holderCount,
    stats: statsOf(c, trades, now, coveredFrom),
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
  /** Price and market cap right after the trade. */
  priceSol: number;
  mcapSol: number;
}

export function tradeJson(t: TradeRecord, totalSupply: bigint): TradeJson {
  const price = priceSol(t.virtualToken, t.virtualSol);
  return {
    signature: t.signature,
    index: t.index,
    mint: t.mint,
    user: t.user,
    side: t.isBuy ? "buy" : "sell",
    tokenAmount: String(t.tokenAmount),
    solAmount: String(t.solAmount),
    fee: String(t.fee),
    slot: t.slot,
    timestamp: t.timestamp,
    priceSol: price,
    mcapSol: price * (Number(totalSupply) / TOKEN_UNIT),
  };
}

export const tradeCursor = (t: Pick<TradeRecord, "signature" | "index">) => `${t.signature}:${t.index}`;

export const CANDLE_INTERVALS = [1, 60, 300, 3600, 14400, 86400] as const;
export interface CandleJson {
  /** Unix seconds at the bar's start. */
  time: number;
  /** SOL per whole token. */
  open: number;
  high: number;
  low: number;
  close: number;
  /** SOL traded (curve side). */
  volumeSol: number;
}

/**
 * OHLCV from a coin's trades (given newest first), oldest bar first, the last `limit` bars: each trade's post-trade
 * price bucketed by `intervalSec`; a bar opens at the previous bar's close, and quiet intervals have no bar.
 */
export function candlesOf(newestFirst: TradeRecord[], intervalSec: number, limit: number): CandleJson[] {
  const bars: CandleJson[] = [];
  for (let i = newestFirst.length - 1; i >= 0; i--) {
    const t = newestFirst[i];
    const time = Math.floor(t.timestamp / intervalSec) * intervalSec;
    const p = priceSol(t.virtualToken, t.virtualSol);
    const volumeSol = Number(t.solAmount) / LAMPORTS_PER_SOL;
    const last = bars[bars.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, p);
      last.low = Math.min(last.low, p);
      last.close = p;
      last.volumeSol += volumeSol;
    } else {
      const open = last ? last.close : p;
      bars.push({ time, open, high: Math.max(open, p), low: Math.min(open, p), close: p, volumeSol });
    }
  }
  return bars.slice(-limit);
}

export type HolderLabel = "bonding_curve" | "migration" | "raydium_pool" | "creator";
export interface HolderJson {
  owner: string;
  amount: string;
  /** Share of total supply, 0..1. */
  pct: number;
  label: HolderLabel | null;
}

export interface TicketJson {
  ticket: string;
  payer: string;
  ticker: string;
  depositLamports: string;
  createdAt: number;
  expiresAt: number;
  state: TicketState;
  mint: string | null;
}
export const ticketJson = (t: TicketRecord): TicketJson => ({ ...t, depositLamports: String(t.depositLamports) });

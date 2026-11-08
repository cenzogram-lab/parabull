/**
 * The indexer's state, in memory. It is rebuilt from the chain on start (current curves and tickets by
 * getProgramAccounts, recent trades by backfilling the program's transactions), so a restart loses only trades older
 * than the backfill reaches. Swapping this for SQLite or Postgres means implementing the same methods.
 */
import { tradeCursor, type CoinRecord, type TicketRecord, type TradeRecord } from "./model";

/** Trades kept per coin beyond the last day (older ones go first). */
export const MAX_TRADES_PER_COIN = 5_000;
/** The absolute per-coin limit, reached only by a coin with more trades than this in a day. */
export const MAX_TRADES_PER_COIN_HARD = 50_000;
export const MAX_TRADES_PER_USER = 1_000;
/** Trades this recent (against the coin's newest) stay past MAX_TRADES_PER_COIN: the 24h stats need them. */
const KEEP_RECENT_SECONDS = 25 * 3600;
const MAX_SEEN_SIGNATURES = 50_000;

/** Newest first: by slot, then by arrival within a slot. */
function insertNewestFirst(list: TradeRecord[], t: TradeRecord) {
  let i = 0;
  while (i < list.length && (list[i].slot > t.slot || (list[i].slot === t.slot && list[i].timestamp > t.timestamp))) i++;
  list.splice(i, 0, t);
}

export interface StoreLimits {
  perCoin: number;
  perCoinHard: number;
  perUser: number;
}

export class Store {
  readonly coins = new Map<string, CoinRecord>();
  readonly tickets = new Map<string, TicketRecord>();
  private readonly tradesByMint = new Map<string, TradeRecord[]>();
  private readonly tradesByUser = new Map<string, TradeRecord[]>();
  private readonly tradeKeys = new Set<string>();
  private readonly seen = new Set<string>();
  /** Mints whose every trade since launch is indexed (the backfill reached their launch, and nothing was evicted). */
  readonly fullHistory = new Set<string>();
  /** Per coin, the newest timestamp among its evicted trades: stats over a window reaching back past it are partial. */
  readonly evictedThrough = new Map<string, number>();

  constructor(readonly limits: StoreLimits = { perCoin: MAX_TRADES_PER_COIN, perCoinHard: MAX_TRADES_PER_COIN_HARD, perUser: MAX_TRADES_PER_USER }) {}

  /** Records a processed transaction; false if it was already processed (the websocket and the poller overlap). */
  markSeen(signature: string): boolean {
    if (this.seen.has(signature)) return false;
    this.seen.add(signature);
    if (this.seen.size > MAX_SEEN_SIGNATURES) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }
  hasSeen(signature: string) {
    return this.seen.has(signature);
  }

  /** False if this exact event (signature + index) is already stored. */
  addTrade(t: TradeRecord): boolean {
    const key = tradeCursor(t);
    if (this.tradeKeys.has(key)) return false;
    this.tradeKeys.add(key);
    const byMint = this.tradesByMint.get(t.mint) ?? [];
    insertNewestFirst(byMint, t);
    this.trimCoin(t.mint, byMint);
    this.tradesByMint.set(t.mint, byMint);
    const byUser = this.tradesByUser.get(t.user) ?? [];
    insertNewestFirst(byUser, t);
    if (byUser.length > this.limits.perUser) byUser.length = this.limits.perUser;
    this.tradesByUser.set(t.user, byUser);
    return true;
  }

  /**
   * Past `perCoin`, drops the coin's oldest trades, but only those older than the last day (the 24h stats need the
   * rest), and past `perCoinHard`, any. An evicted trade is forgotten entirely (its dedupe key too, so memory stays
   * bounded); the coin no longer has its full history, and the newest evicted time is kept to flag partial stats.
   */
  private trimCoin(mint: string, list: TradeRecord[]) {
    if (list.length <= this.limits.perCoin) return;
    const keepFrom = list[0].timestamp - KEEP_RECENT_SECONDS;
    const evicted: TradeRecord[] = [];
    while (list.length > this.limits.perCoin && list[list.length - 1].timestamp < keepFrom) evicted.push(list.pop()!);
    while (list.length > this.limits.perCoinHard) evicted.push(list.pop()!);
    if (!evicted.length) return;
    for (const old of evicted) this.tradeKeys.delete(tradeCursor(old));
    this.fullHistory.delete(mint);
    this.evictedThrough.set(mint, Math.max(this.evictedThrough.get(mint) ?? 0, ...evicted.map((x) => x.timestamp)));
  }

  /** How many trade keys are held (bounded by the per-coin caps). */
  get tradeKeyCount() {
    return this.tradeKeys.size;
  }

  trades(mint: string): TradeRecord[] {
    return this.tradesByMint.get(mint) ?? [];
  }
  userTrades(user: string): TradeRecord[] {
    return this.tradesByUser.get(user) ?? [];
  }
}

/** A page of `items` (newest first) after `cursor`, and the cursor for the next page. */
export function page<T>(items: T[], cursorOf: (t: T) => string, cursor: string | null, limit: number): { items: T[]; next: string | null } | null {
  let start = 0;
  if (cursor) {
    const i = items.findIndex((t) => cursorOf(t) === cursor);
    if (i < 0) return null;
    start = i + 1;
  }
  const slice = items.slice(start, start + limit);
  const more = start + limit < items.length;
  return { items: slice, next: more && slice.length ? cursorOf(slice[slice.length - 1]) : null };
}

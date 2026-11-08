/**
 * The indexer's state, in memory. It is rebuilt from the chain on start (current curves and tickets by
 * getProgramAccounts, recent trades by backfilling the program's transactions), so a restart loses only trades older
 * than the backfill reaches. Swapping this for SQLite or Postgres means implementing the same methods.
 */
import { tradeCursor, type CoinRecord, type TicketRecord, type TradeRecord } from "./model";

export const MAX_TRADES_PER_COIN = 5_000;
export const MAX_TRADES_PER_USER = 1_000;
const MAX_SEEN_SIGNATURES = 50_000;

/** Newest first: by slot, then by arrival within a slot (a later event in the same transaction comes first). */
function insertNewestFirst(list: TradeRecord[], t: TradeRecord, cap: number) {
  let i = 0;
  while (i < list.length && (list[i].slot > t.slot || (list[i].slot === t.slot && list[i].timestamp > t.timestamp))) i++;
  list.splice(i, 0, t);
  if (list.length > cap) list.length = cap;
}

export class Store {
  readonly coins = new Map<string, CoinRecord>();
  readonly tickets = new Map<string, TicketRecord>();
  private readonly tradesByMint = new Map<string, TradeRecord[]>();
  private readonly tradesByUser = new Map<string, TradeRecord[]>();
  private readonly tradeKeys = new Set<string>();
  private readonly seen = new Set<string>();
  /** Mints whose every trade since launch is indexed (the backfill reached their launch). */
  readonly fullHistory = new Set<string>();

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
    insertNewestFirst(byMint, t, MAX_TRADES_PER_COIN);
    this.tradesByMint.set(t.mint, byMint);
    const byUser = this.tradesByUser.get(t.user) ?? [];
    insertNewestFirst(byUser, t, MAX_TRADES_PER_USER);
    this.tradesByUser.set(t.user, byUser);
    return true;
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

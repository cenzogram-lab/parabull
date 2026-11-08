/**
 * Referred buys: a buy whose transaction carries a top-level `parabull:ref:<calloutId>` memo (app/src/lib/callouts.ts).
 * The indexer doesn't know who wrote a callout (the edge Worker does), so it records every tagged buy as it is and
 * leaves the rules to whoever pays (scripts/src/callerEpoch.ts drops self-referrals, buys of another coin than the
 * callout's, and buys from before the callout). Per-callout totals are kept for the app, with a per-trader breakdown
 * so a reader that knows the author can take its own buys out.
 *
 * Memory is bounded: at most `maxEvents` events (the oldest go first, and `evictedThrough` says up to when) and
 * `maxCallouts` callouts' totals (the least recently referred go first).
 */
export interface ReferralEvent {
  calloutId: string;
  signature: string;
  /** The TradeEvent's index in its transaction. */
  index: number;
  mint: string;
  trader: string;
  /** SOL the buy cost before the fee (TradeEvent.sol_amount) and the fee, in lamports. */
  solLamports: bigint;
  feeLamports: bigint;
  tokenAmount: bigint;
  slot: number;
  /** Unix seconds (the trade's on-chain clock). */
  timestamp: number;
}

interface Totals {
  buys: number;
  volume: bigint;
  fee: bigint;
}

interface CalloutTotals extends Totals {
  traders: Map<string, Totals>;
  mints: Map<string, Totals>;
  firstAt: number;
  lastAt: number;
}

export interface ReferralEventJson {
  calloutId: string;
  signature: string;
  index: number;
  mint: string;
  trader: string;
  solLamports: string;
  feeLamports: string;
  tokenAmount: string;
  slot: number;
  timestamp: number;
}

type EventKey = Pick<ReferralEvent, "timestamp" | "slot" | "signature" | "index">;

/** The events' order: time, slot, signature, index. */
export const compareEvents = (a: EventKey, b: EventKey) => a.timestamp - b.timestamp || a.slot - b.slot || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : a.index - b.index);

/** A page cursor: the last event's key, `<timestamp>.<slot>.<signature>.<index>`. */
export const referralCursor = (e: EventKey) => `${e.timestamp}.${e.slot}.${e.signature}.${e.index}`;

export function parseReferralCursor(s: string): EventKey | null {
  const m = /^(\d{1,12})\.(\d{1,15})\.([1-9A-HJ-NP-Za-km-z]{32,90})\.(\d{1,5})$/.exec(s);
  return m ? { timestamp: Number(m[1]), slot: Number(m[2]), signature: m[3], index: Number(m[4]) } : null;
}

export const referralJson = (e: ReferralEvent): ReferralEventJson => ({ ...e, solLamports: e.solLamports.toString(), feeLamports: e.feeLamports.toString(), tokenAmount: e.tokenAmount.toString() });

const add = (t: Totals, e: ReferralEvent) => {
  t.buys += 1;
  t.volume += e.solLamports;
  t.fee += e.feeLamports;
};
const zero = (): Totals => ({ buys: 0, volume: 0n, fee: 0n });
const totalsJson = (t: Totals) => ({ buys: t.buys, volumeLamports: t.volume.toString(), feeLamports: t.fee.toString() });

export class Referrals {
  private events: ReferralEvent[] = [];
  private sorted = true;
  private readonly keys = new Set<string>();
  private readonly totals = new Map<string, CalloutTotals>();
  /** The newest timestamp of an event dropped for space: windows before it are incomplete. */
  evictedThrough: number | null = null;

  constructor(private readonly limits = { maxEvents: 200_000, maxCallouts: 100_000 }) {}

  get size() {
    return this.events.length;
  }

  /** Records one referred buy; false if it was already recorded. */
  add(e: ReferralEvent): boolean {
    const key = `${e.signature}:${e.index}`;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    const last = this.events[this.events.length - 1];
    if (last && (last.timestamp > e.timestamp || (last.timestamp === e.timestamp && last.slot > e.slot))) this.sorted = false;
    this.events.push(e);
    const t = this.totals.get(e.calloutId) ?? { ...zero(), traders: new Map(), mints: new Map(), firstAt: e.timestamp, lastAt: e.timestamp };
    add(t, e);
    const tr = t.traders.get(e.trader) ?? zero();
    add(tr, e);
    t.traders.set(e.trader, tr);
    const m = t.mints.get(e.mint) ?? zero();
    add(m, e);
    t.mints.set(e.mint, m);
    t.firstAt = Math.min(t.firstAt, e.timestamp);
    t.lastAt = Math.max(t.lastAt, e.timestamp);
    // Re-inserted so the map's order is least recently referred first.
    this.totals.delete(e.calloutId);
    this.totals.set(e.calloutId, t);
    if (this.totals.size > this.limits.maxCallouts) this.totals.delete(this.totals.keys().next().value!);
    if (this.events.length > this.limits.maxEvents) this.evict(this.events.length - this.limits.maxEvents);
    return true;
  }

  private ordered(): ReferralEvent[] {
    if (!this.sorted) {
      this.events.sort(compareEvents);
      this.sorted = true;
    }
    return this.events;
  }

  private evict(n: number) {
    const gone = this.ordered().splice(0, n);
    for (const e of gone) this.keys.delete(`${e.signature}:${e.index}`);
    this.evictedThrough = Math.max(this.evictedThrough ?? -Infinity, gone[gone.length - 1].timestamp);
  }

  /**
   * Events with since <= timestamp < until, oldest first, after `cursor` (the key of the last event of the previous
   * page). A key, not an offset: evictions and late inserts between pages can't shift events past the reader.
   */
  window(since: number, until: number, cursor: string | null, limit: number): { events: ReferralEvent[]; next: string | null } {
    const after = cursor === null ? null : parseReferralCursor(cursor);
    if (cursor !== null && after === null) throw new Error("bad cursor");
    const all = this.ordered().filter((e) => e.timestamp >= since && e.timestamp < until && (after === null || compareEvents(e, after) > 0));
    const events = all.slice(0, limit);
    return { events, next: all.length > limit ? referralCursor(events[events.length - 1]) : null };
  }

  /** One callout's totals: every recorded referred buy, by trader (largest first, at most 50) and by coin. */
  forCallout(calloutId: string) {
    const t = this.totals.get(calloutId);
    if (!t) return { calloutId, ...totalsJson(zero()), traders: 0, byTrader: [] as { wallet: string; buys: number; volumeLamports: string; feeLamports: string }[], byMint: [] as { mint: string; buys: number; volumeLamports: string; feeLamports: string }[], firstAt: null as number | null, lastAt: null as number | null };
    const largest = (m: Map<string, Totals>) => [...m].sort((a, b) => (b[1].volume > a[1].volume ? 1 : b[1].volume < a[1].volume ? -1 : 0));
    return {
      calloutId,
      ...totalsJson(t),
      traders: t.traders.size,
      byTrader: largest(t.traders).slice(0, 50).map(([wallet, v]) => ({ wallet, ...totalsJson(v) })),
      byMint: largest(t.mints).map(([mint, v]) => ({ mint, ...totalsJson(v) })),
      firstAt: t.firstAt,
      lastAt: t.lastAt,
    };
  }
}

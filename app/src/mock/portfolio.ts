/**
 * Demo portfolio for the wallet in use: an equity curve that ends at today's
 * equity, a few closed positions, and the trade-thesis notes attached to open
 * positions. Pure and seeded, so every load (and screenshot) is identical.
 */
import { Rng } from "../lib/rng";
import type { Coin } from "../lib/types";

export type PortfolioPeriod = "1D" | "1W" | "1M" | "ALL";

/** SOL the demo wallet holds next to its coin positions. */
export const DEMO_CASH_SOL = 1.84;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Daily volatility of the equity curve's noise (log space). */
const DAILY_VOL = 0.1;

/**
 * Sample spacing per period. Each window is an exact multiple of its step, so
 * the 1D, 1W and 1M anchors below always land on a sample.
 */
const SAMPLING: Record<PortfolioPeriod, { step: number; points: number }> = {
  "1D": { step: 15 * 60_000, points: 97 }, // 24 hours
  "1W": { step: 2 * HOUR, points: 85 }, // 7 days
  "1M": { step: 8 * HOUR, points: 91 }, // 30 days
  ALL: { step: DAY, points: 91 }, // 90 days
};

/** [ms before now, equity] from oldest to newest; the last day matches the 24h change exactly. */
function anchors(equityUsd: number, change24hPct: number): [number, number][] {
  const rng = new Rng("equity:anchors");
  const day = equityUsd / (1 + change24hPct);
  const week = day / (1 + rng.range(-0.12, 0.38));
  const month = week / (1 + rng.range(-0.15, 0.85));
  const start = month / (1 + rng.range(0.6, 2.4));
  return [
    [90 * DAY, start],
    [30 * DAY, month],
    [7 * DAY, week],
    [DAY, day],
    [0, equityUsd],
  ];
}

/**
 * Equity over `period`, oldest first, ending exactly at `equityUsd`.
 * `change24hPct` is a fraction (-0.078 = -7.8%): the 1D series starts at
 * `equityUsd / (1 + change24hPct)`, and the longer periods pass through the
 * same value 24h back. 85-97 points depending on the period.
 */
export function equityHistory(equityUsd: number, change24hPct: number, period: PortfolioPeriod, now: number): { t: number; v: number }[] {
  const { step, points } = SAMPLING[period];
  const span = step * (points - 1);
  const t = (i: number) => now - span + i * step;
  if (!(equityUsd > 0) || !(change24hPct > -1)) return Array.from({ length: points }, (_, i) => ({ t: t(i), v: Math.max(0, equityUsd) || 0 }));

  const marks = anchors(equityUsd, change24hPct)
    .filter(([back]) => back <= span)
    .map(([back, v]) => [Math.round((span - back) / step), v] as const);
  const v = new Array<number>(points);
  const vol = DAILY_VOL * Math.sqrt(step / DAY);
  for (let s = 0; s + 1 < marks.length; s++) {
    // Brownian bridge in log space between two anchors.
    const [ia, va] = marks[s];
    const [ib, vb] = marks[s + 1];
    const rng = new Rng(`equity:${period}:${ia}`);
    const n = ib - ia;
    const walk = [0];
    for (let j = 1; j <= n; j++) walk.push(walk[j - 1] + rng.normal() * vol);
    const la = Math.log(va);
    const lb = Math.log(vb);
    for (let j = 0; j <= n; j++) {
      const f = j / n;
      v[ia + j] = Math.exp(la + (lb - la) * f + walk[j] - walk[n] * f);
    }
    v[ia] = va;
    v[ib] = vb;
  }
  return v.map((x, i) => ({ t: t(i), v: x }));
}

export interface ClosedPosition {
  mint: string;
  /** Whole tokens sold (UI units, not base units). */
  tokens: number;
  entryUsd: number;
  exitUsd: number;
  /** Realized PnL: exitUsd - entryUsd. */
  pnlUsd: number;
  /** pnlUsd / entryUsd, as a fraction. */
  pnlPct: number;
  closedAt: number;
}

/**
 * Five positions the wallet already sold, newest first, taken from graduated
 * coins (the open demo positions are curve coins). Token amounts are priced
 * off each coin's current price, so pass a fixed snapshot of the coins
 * (usePortfolio uses the ones it first saw) to keep the list steady.
 */
export function closedPositions(coins: Coin[], now: number): ClosedPosition[] {
  const rng = new Rng("closed-positions");
  const pool = coins.filter((c) => c.migrated).sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  const picks: Coin[] = [];
  while (pool.length && picks.length < 5) picks.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]);
  return picks
    .map((c, i) => {
      const entryUsd = rng.logRange(45, 1400);
      // Two wins for every loss.
      const move = i % 3 === 1 ? -rng.range(0.12, 0.68) : rng.logRange(0.08, 4.5);
      const exitUsd = entryUsd * (1 + move);
      const pnlUsd = exitUsd - entryUsd;
      const exitPrice = c.priceUsd * rng.range(0.55, 1.3);
      // Sold at some point after the coin launched, at most 26 days ago.
      const heldFor = Math.min(26 * DAY, Math.max(0, now - c.createdAt)) * rng.range(0.08, 0.92);
      return { mint: c.mint, tokens: exitUsd / exitPrice, entryUsd, exitUsd, pnlUsd, pnlPct: pnlUsd / entryUsd, closedAt: now - heldFor };
    })
    .sort((a, b) => b.closedAt - a.closedAt);
}

export interface PositionNote {
  text: string;
  updatedAt: number;
  likes: number;
  reposts: number;
  views: number;
}

const THESES = [
  "Ticker and name are locked for 3 days, so nobody can vamp it while the curve fills. Holding to Raydium.",
  "Buys keep outpacing sells and the dev hasn't sold a single token. Target: graduation.",
  "Small bag, big horns. Adding on every red candle until the curve hits 85 SOL.",
  "Verified launch tweet, an active chat and steady buyers. This one has legs.",
  "Took some profit on the way up. Riding the rest with house money.",
  "Holding through the migration: the liquidity gets locked, not pulled.",
  "The chart is a staircase. Not selling before the curve completes.",
  "Clean holder list and a small dev buy. Conviction hold, sized so I can sleep.",
  "Got in early and trimmed once. The bull keeps charging.",
] as const;

/** The holder's trade thesis on a position, or null for positions without one (about a third). */
export function positionNote(mint: string, now: number): PositionNote | null {
  const rng = new Rng(`thesis-note:${mint}`);
  if (rng.next() < 0.34) return null;
  const text = rng.pick(THESES);
  const updatedAt = now - rng.range(2 * HOUR, 9 * DAY);
  const views = rng.int(140, 9_000);
  const likes = Math.max(1, Math.round(views * rng.range(0.012, 0.09)));
  return { text, updatedAt, likes, reposts: Math.round(likes * rng.range(0.05, 0.45)), views };
}

/**
 * SOL/USD from public price APIs, tried in order. A source that times out, errors or returns
 * something implausible is skipped; when none answers, callers keep their fallback price.
 */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface PriceSource {
  name: string;
  url: string;
  read: (json: unknown) => unknown;
}

const at = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);

export const PRICE_SOURCES: readonly PriceSource[] = [
  // Jupiter Price API v3: { "<mint>": { "usdPrice": 147.2, ... } }
  { name: "Jupiter", url: `https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT}`, read: (j) => at(j, WSOL_MINT, "usdPrice") },
  // CoinGecko simple price: { "solana": { "usd": 147.2 } }
  { name: "CoinGecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", read: (j) => at(j, "solana", "usd") },
];

/** A price we'd show: a finite number in a wide sanity band, or null. */
export function saneSolUsd(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 100_000 ? n : null;
}

export interface SolUsdQuote {
  price: number;
  source: string;
}

/** The first plausible price from `sources`, or null when every source fails. */
export async function fetchSolUsd(sources: readonly PriceSource[] = PRICE_SOURCES, fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): Promise<SolUsdQuote | null> {
  for (const s of sources) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(s.url, { signal: ctl.signal, headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const price = saneSolUsd(s.read(await res.json()));
      if (price !== null) return { price, source: s.name };
    } catch {
      // Network error, timeout or bad JSON: try the next source.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

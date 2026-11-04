/** Per-coin demo history: trades, candles and holders, all derived from the coin's own numbers. */
import { PROTOCOL } from "../lib/protocol";
import { Rng } from "../lib/rng";
import type { Candle, Coin, Holder, Trade } from "../lib/types";
import { HANDLES } from "./catalog";
import { address, bridge, SOL_USD } from "./coins";

const SUPPLY_TOKENS = Number(PROTOCOL.totalSupply) / 1e6;

export const fakeSignature = (rng: Rng) => address(rng) + address(rng);

export function tradeHistory(coin: Coin, n = 60, now = Date.now()): Trade[] {
  const rng = new Rng(`trades:${coin.mint}`);
  const out: Trade[] = [];
  let ts = now - rng.range(3, 20) * 1000;
  const prices = bridge(rng, coin.priceUsd / (1 + coin.change1h * 0.5), coin.priceUsd, n, 0.01);
  for (let i = 0; i < n; i++) {
    const side = rng.bool(coin.buyVolUsd / (coin.buyVolUsd + coin.sellVolUsd)) ? "buy" : "sell";
    const solAmt = rng.logRange(0.02, coin.migrated ? 12 : 4);
    const p = prices[n - 1 - i];
    const [handle] = HANDLES[rng.int(0, HANDLES.length - 1)];
    out.push({
      id: `${coin.mint}-h${i}`,
      mint: coin.mint,
      side,
      trader: address(rng),
      handle,
      sol: solAmt,
      tokens: (solAmt * SOL_USD) / p,
      priceUsd: p,
      mcapUsd: p * SUPPLY_TOKENS,
      ts,
      sig: fakeSignature(rng),
    });
    ts -= rng.logRange(2, coin.stage === "new" ? 40 : 240) * 1000;
  }
  return out;
}

export const INTERVALS = { "1s": 1, "1m": 60, "5m": 300, "1h": 3600, "4h": 14400, D: 86400 } as const;
export type Interval = keyof typeof INTERVALS;

/** OHLCV ending at the coin's current price; never earlier than the coin's launch. */
export function candles(coin: Coin, interval: Interval, now = Date.now()): Candle[] {
  const sec = INTERVALS[interval];
  const rng = new Rng(`candles:${coin.mint}:${interval}`);
  const maxBars = Math.max(24, Math.floor((now - coin.createdAt) / 1000 / sec));
  const n = Math.min(160, maxBars);
  const spanH = (n * sec) / 3600;
  const drift = spanH >= 24 ? coin.change24h : spanH >= 6 ? coin.change6h : spanH >= 1 ? coin.change1h : coin.change1h * Math.max(0.05, spanH);
  const vol = Math.min(0.09, 0.006 * Math.sqrt(sec) + 0.004);
  const closes = bridge(rng, coin.priceUsd / (1 + drift), coin.priceUsd, n, vol);
  const end = Math.floor(now / 1000 / sec) * sec;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const open = i === 0 ? closes[0] * (1 - rng.range(-0.01, 0.01)) : closes[i - 1];
    const close = closes[i];
    const wick = Math.abs(close - open) + open * vol * rng.range(0.1, 0.9);
    out.push({
      time: end - (n - 1 - i) * sec,
      open,
      close,
      high: Math.max(open, close) + wick * rng.range(0.1, 0.8),
      low: Math.max(1e-12, Math.min(open, close) - wick * rng.range(0.1, 0.8)),
      volume: (coin.vol24hUsd / (86400 / sec)) * rng.logRange(0.3, 3) * (1 + Math.abs(close / open - 1) * 20),
    });
  }
  return out;
}

export function holders(coin: Coin): Holder[] {
  const rng = new Rng(`holders:${coin.mint}`);
  const sold = Number(PROTOCOL.initialRealToken - coin.reserves.realToken) / 1e6;
  const list: Holder[] = [];
  if (coin.migrated) {
    list.push({ address: coin.pool?.address ?? address(rng), label: "Raydium pool", pct: rng.range(0.14, 0.26), tokens: 0, valueUsd: 0, pnlUsd: 0 });
  } else {
    list.push({ address: address(rng), label: "Bonding curve", pct: 1 - sold / SUPPLY_TOKENS, tokens: 0, valueUsd: 0, pnlUsd: 0 });
  }
  if (coin.devPct > 0) list.push({ address: coin.creator, label: "Dev", pct: coin.devPct / 100, tokens: 0, valueUsd: 0, pnlUsd: 0 });
  let remaining = 1 - list.reduce((n, h) => n + h.pct, 0);
  for (let i = 0; i < 18 && remaining > 0.002; i++) {
    const pct = Math.min(remaining, remaining * rng.range(0.07, 0.2));
    remaining -= pct;
    list.push({ address: address(rng), pct, tokens: 0, valueUsd: 0, pnlUsd: 0 });
  }
  return list.map((h) => {
    const t = h.pct * SUPPLY_TOKENS;
    const value = t * coin.priceUsd;
    return { ...h, tokens: t, valueUsd: value, pnlUsd: h.label ? 0 : value * rng.range(-0.35, 1.8) };
  });
}

/** Demo traders, squads, callouts and streams. */
import { avatarArt } from "../lib/art";
import { Rng } from "../lib/rng";
import type { Callout, Coin, Period, Squad, Stream, Trader } from "../lib/types";
import { CALLOUT_LINES, HANDLES, SQUADS, STREAM_TITLES } from "./catalog";
import { address } from "./coins";

const PERIOD_SCALE: Record<Period, number> = { "1D": 1, "1W": 4.6, "1M": 13.5 };

export function generateTraders(coins: Coin[]): Trader[] {
  return HANDLES.map(([handle, name, squad], i) => {
    const rng = new Rng(`trader:${handle}`);
    const day = rng.logRange(9_000, 120_000) * (1 - i / 60);
    const dayVol = day * rng.range(4, 14);
    const per = <T,>(f: (s: number, p: Period) => T) => ({ "1D": f(1, "1D"), "1W": f(PERIOD_SCALE["1W"], "1W"), "1M": f(PERIOD_SCALE["1M"], "1M") });
    return {
      handle,
      name,
      address: address(rng),
      avatar: avatarArt(handle),
      x: rng.bool(0.7),
      verified: rng.bool(0.35),
      squad: squad ?? undefined,
      pnl: per((s) => day * s * rng.range(0.8, 1.25)),
      volume: per((s) => dayVol * s * rng.range(0.85, 1.2)),
      trades: per((s) => Math.round(rng.range(40, 400) * s)),
      winRate: rng.range(0.48, 0.81),
      bestCoin: coins[rng.int(0, coins.length - 1)].mint,
      rewardsUsd: rng.logRange(40, 9_000),
    };
  });
}

export function generateSquads(traders: Trader[]): Squad[] {
  return SQUADS.map(([name, tag]) => {
    const members = traders.filter((t) => t.squad === name);
    const sum = (p: Period, k: "pnl" | "volume") => members.reduce((n, t) => n + t[k][p], 0);
    return {
      name,
      tag,
      members: members.length * 37 + 12,
      pnl: { "1D": sum("1D", "pnl"), "1W": sum("1W", "pnl"), "1M": sum("1M", "pnl") },
      volume: { "1D": sum("1D", "volume"), "1W": sum("1W", "volume"), "1M": sum("1M", "volume") },
      emblem: avatarArt(`squad:${name}`),
    };
  });
}

export function generateCallouts(coins: Coin[], now = Date.now()): Callout[] {
  const rng = new Rng("callouts");
  const ranked = [...coins].sort((a, b) => b.change24h - a.change24h);
  return CALLOUT_LINES.map((text, i) => {
    const coin = ranked[(i * 5) % Math.min(ranked.length, 28)];
    const [handle] = HANDLES[(i * 11 + 2) % HANDLES.length];
    const calledAtMcap = coin.mcapUsd / rng.range(1.4, 4.2);
    const positionUsd = rng.logRange(120, 9_500);
    const pnlPct = coin.mcapUsd / calledAtMcap - 1;
    return {
      id: `callout-${i}`,
      handle,
      text,
      mint: coin.mint,
      positionUsd,
      pnlUsd: positionUsd * (pnlPct / (1 + pnlPct)),
      pnlPct,
      closed: rng.bool(0.25),
      calledAtMcap,
      ts: now - rng.range(2, 22 * 60) * 60_000,
      views: rng.int(20, 6_000),
      comments: rng.int(0, 40),
      likes: rng.int(1, 120),
      shares: rng.int(0, 18),
    };
  }).sort((a, b) => b.ts - a.ts);
}

export function generateStreams(coins: Coin[], now = Date.now()): Stream[] {
  const rng = new Rng("streams");
  const pool = [...coins].sort((a, b) => b.mcapUsd - a.mcapUsd).slice(0, 24);
  return STREAM_TITLES.flatMap((title, i) => {
    const coin = pool[(i * 3) % pool.length];
    const [handle] = HANDLES[(i * 5 + 1) % HANDLES.length];
    const live: Stream = { id: `live-${i}`, handle, title, mint: coin.mint, viewers: Math.round(rng.logRange(40, 9_000)), startedAt: now - rng.range(5, 300) * 60_000, kind: "live", durationSec: 0 };
    const clip: Stream = { ...live, id: `clip-${i}`, kind: "clip", title: `Clip: ${title.toLowerCase()}`, viewers: Math.round(rng.logRange(300, 40_000)), durationSec: rng.int(18, 95) };
    return [live, clip];
  });
}

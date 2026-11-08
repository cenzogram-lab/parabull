/**
 * Demo coins. Curve coins are placed on the real default curve: their
 * reserves, price, market cap and progress come from the program's math.
 */
import { PublicKey } from "@solana/web3.js";
import { coinArt } from "../lib/art";
import { curveProgress, mcapSol, priceSol, PROTOCOL, reservesAtSold } from "../lib/protocol";
import { Rng } from "../lib/rng";
import type { Coin, Stage } from "../lib/types";
import { COIN_SEEDS, HANDLES, type Kind } from "./catalog";

/** Demo SOL price used to show USD values. */
export const SOL_USD = 162.4;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LOCK_MS = PROTOCOL.registryLockSeconds * 1000;

export const address = (rng: Rng) => new PublicKey(rng.bytes(32)).toBase58();

const AGE: Record<Kind, [number, number]> = {
  new: [2 * MIN, 55 * MIN],
  live: [1 * HOUR, 20 * HOUR],
  soon: [3 * HOUR, 30 * HOUR],
  mover: [25 * MIN, 2 * DAY],
  graduated: [2.2 * DAY, 40 * DAY],
};
const PROGRESS: Record<Kind, [number, number]> = {
  new: [0.03, 0.3],
  live: [0.25, 0.68],
  soon: [0.74, 0.94],
  mover: [0.35, 0.9],
  graduated: [1, 1],
};

/** A random walk from `from` to `to` (a Brownian bridge in log space). */
export function bridge(rng: Rng, from: number, to: number, n: number, vol: number): number[] {
  const a = Math.log(from);
  const b = Math.log(to);
  const steps: number[] = [0];
  for (let i = 1; i < n; i++) steps.push(steps[i - 1] + rng.normal() * vol);
  const last = steps[n - 1];
  return steps.map((s, i) => Math.exp(a + (b - a) * (i / (n - 1)) + s - last * (i / (n - 1))));
}

function makeCoin(i: number, [name, ticker, kind, blurb]: (typeof COIN_SEEDS)[number], now: number): Coin {
  const rng = new Rng(`coin:${ticker}`);
  const mint = address(rng);
  const [handle] = HANDLES[(i * 7 + 3) % HANDLES.length];
  const creator = address(rng);
  // Pin the King of the Bull so the board always has a clear leader near migration.
  const ageMs = ticker === "BRONZE" ? 9 * HOUR + 14 * MIN : rng.range(...AGE[kind]);
  const createdAt = now - ageMs;
  const progress = ticker === "BRONZE" ? 0.962 : rng.range(...PROGRESS[kind]);
  const graduated = kind === "graduated";
  // `progress` is the share of the curve's tokens sold (what the migration gauge shows, as the indexer measures it).
  const sold = graduated ? PROTOCOL.initialRealToken : BigInt(Math.floor(Number(PROTOCOL.initialRealToken) * progress));
  const reserves = reservesAtSold(sold);

  let mcapUsd = mcapSol(reserves) * SOL_USD;
  let priceUsd = priceSol(reserves) * SOL_USD;
  if (graduated) {
    mcapUsd = rng.logRange(240e3, 38e6);
    priceUsd = mcapUsd / (Number(PROTOCOL.totalSupply) / 1e6);
  }
  const startMcap = mcapSol(reservesAtSold(0n)) * SOL_USD;
  const change24h =
    kind === "new" || ageMs < DAY
      ? mcapUsd / startMcap - 1
      : kind === "mover"
        ? rng.range(0.8, 24)
        : kind === "soon"
          ? rng.range(0.2, 4)
          : graduated
            ? rng.range(-0.25, 0.65)
            : rng.range(-0.35, 1.4);
  const change6h = change24h >= 0 ? change24h * rng.range(0.35, 0.95) : change24h * rng.range(0.2, 0.8);
  const change1h = kind === "mover" ? rng.range(0.18, 0.9) : change6h * rng.range(-0.3, 0.6);

  const raisedUsd = (Number(reserves.realSol) / 1e9) * SOL_USD;
  const vol24hUsd = graduated ? mcapUsd * rng.logRange(0.08, 0.9) : Math.max(raisedUsd * rng.range(1.3, 2.6), mcapUsd * rng.logRange(0.3, 2.2));
  const buyShare = change24h > 0 ? rng.range(0.53, 0.68) : rng.range(0.38, 0.5);
  const avgTrade = rng.range(38, 210);
  const trades = Math.max(12, Math.round(vol24hUsd / avgTrade));
  const buys24h = Math.round(trades * buyShare);
  const traders24h = Math.max(6, Math.round(trades / rng.range(2.6, 6.5)));
  const lifetimeFeesUsd = vol24hUsd * 0.01 * (ageMs > DAY ? Math.min(ageMs / DAY, 6) : ageMs / DAY);
  const escrowUsd = Math.min(PROTOCOL.dexListingUsd, lifetimeFeesUsd);
  const hasTweet = rng.bool(0.6);

  const stage: Stage = graduated ? "graduated" : kind === "new" ? "new" : progress >= 0.72 ? "soon" : "live";
  const spark = bridge(rng, priceUsd / (1 + change24h), priceUsd, 48, 0.035 + Math.min(0.08, Math.abs(change24h) * 0.01));
  const ath = Math.max(...spark) * (Number(PROTOCOL.totalSupply) / 1e6);
  return {
    mint,
    name,
    ticker,
    image: coinArt(mint, ticker),
    description: blurb,
    creator,
    creatorHandle: handle,
    createdAt,
    stage,
    reserves,
    complete: graduated,
    migrated: graduated,
    priceUsd,
    mcapUsd,
    athUsd: Math.max(ath, mcapUsd) * (kind === "mover" ? 1.01 : rng.range(1, 1.45)),
    vol24hUsd,
    buyVolUsd: vol24hUsd * buyShare,
    sellVolUsd: vol24hUsd * (1 - buyShare),
    buys24h,
    sells24h: trades - buys24h,
    traders24h,
    change1h,
    change6h,
    change24h,
    holders: Math.round(traders24h * rng.range(0.9, 1.8) + (graduated ? rng.int(400, 4000) : rng.int(8, 60))),
    devPct: rng.bool(0.3) ? 0 : rng.range(0.4, 4.6),
    replies: rng.int(3, graduated ? 900 : 180),
    locks: { ticker: createdAt + LOCK_MS, name: createdAt + LOCK_MS, tweet: hasTweet ? createdAt + LOCK_MS : null },
    tweetId: hasTweet ? `18${String(rng.int(10_000_000, 99_999_999))}${String(rng.int(100_000_000, 999_999_999))}` : null,
    escrowUsd,
    escrowReleased: escrowUsd >= PROTOCOL.dexListingUsd,
    spark,
    socials: {
      x: rng.bool(0.8) ? `https://x.com/${ticker.toLowerCase()}onsol` : undefined,
      website: rng.bool(0.5) ? `https://${ticker.toLowerCase()}.example` : undefined,
      telegram: rng.bool(0.4) ? `https://t.me/${ticker.toLowerCase()}` : undefined,
    },
    hot: change1h > 0.25 || (stage === "soon" && progress > 0.9),
    pool: graduated ? { address: address(rng), lpLocked: true, feeNft: address(rng), lpFeesUsd: vol24hUsd * 0.0025 * rng.range(2, 9) } : undefined,
  };
}

export function generateCoins(now = Date.now()): Coin[] {
  return COIN_SEEDS.map((seed, i) => makeCoin(i, seed, now));
}

/**
 * Curve progress toward graduation, 0..1: the indexer's figure in chain mode (`progress`, tokens sold against the
 * coin's own launch reserves), the same measure from the reserves in demo mode. Complete and graduated coins report 1.
 */
export const progressOf = (c: Pick<Coin, "migrated" | "complete" | "reserves" | "progress">) => (c.migrated || c.complete ? 1 : c.progress ?? curveProgress(c.reserves));

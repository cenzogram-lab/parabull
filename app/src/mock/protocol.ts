/**
 * Demo protocol economics: daily buyback-and-burn, and weekly holder-reward
 * epochs whose Merkle roots and proofs are real (built with src/lib/merkle.ts,
 * the same format as scripts/src/snapshot.ts and merkle.rs).
 */
import { PublicKey } from "@solana/web3.js";
import { buildLevels, leafHash, proofFor, rootOf } from "../lib/merkle";
import { PROTOCOL } from "../lib/protocol";
import { Rng } from "../lib/rng";
import { toHex } from "../lib/sha256";
import { SOL_USD } from "./coins";

const DAY = 86_400_000;
export const PARABULL_SUPPLY = 1_000_000_000;
export const PARABULL_PRICE = 0.0214;

export interface BuybackDay {
  date: number;
  solSpent: number;
  usd: number;
  burned: number;
  solPrice: number;
  platformVolumeUsd: number;
}

export function buybackLedger(now = Date.now(), days = 30): BuybackDay[] {
  const rng = new Rng("buybacks");
  const out: BuybackDay[] = [];
  let pbPrice = PARABULL_PRICE * 0.62;
  let solPrice = SOL_USD * 0.88;
  for (let i = days - 1; i >= 0; i--) {
    pbPrice *= 1 + rng.normal() * 0.035 + 0.016;
    solPrice *= 1 + rng.normal() * 0.02 + 0.004;
    const volume = rng.logRange(2.2e6, 6.8e6) * (1 + (days - i) / 60);
    const usd = volume * (Number(PROTOCOL.platformFeeBps) / 10_000) * (PROTOCOL.buybackBps / 10_000);
    out.push({ date: now - i * DAY, solSpent: usd / solPrice, usd, burned: usd / pbPrice, solPrice, platformVolumeUsd: volume });
  }
  return out;
}

/** Mirrors the scripts/src/snapshot.ts artifact (your leaf only) plus the on-chain RewardEpoch state. */
export interface DemoEpoch {
  epoch: number;
  root: string;
  totalLamports: string;
  numLeaves: number;
  claimedLamports: string;
  publishedAt: number;
  expiresAt: number;
  expired: boolean;
  solPriceAtPublish: number;
  /** The connected wallet's leaf, if it held $PARABULL at the snapshot. */
  you: { index: number; amount: string; proof: string[] } | null;
}

/**
 * Twelve weekly epochs funded by the holder share of platform fees (40% vs
 * 50% buyback, so 0.8x the buyback ledger). Each is a real Merkle tree over
 * ~500 holders; `claimant` gets an allocation in most of them.
 */
export function rewardEpochs(claimant: PublicKey, now = Date.now()): DemoEpoch[] {
  const rng = new Rng("epochs");
  const ledger = buybackLedger(now, 12 * 7);
  const out: DemoEpoch[] = [];
  for (let e = 1; e <= 12; e++) {
    const week = ledger.slice((e - 1) * 7, e * 7);
    const holderUsd = week.reduce((n, d) => n + d.usd, 0) * (PROTOCOL.holderBps / PROTOCOL.buybackBps);
    const solPrice = week[week.length - 1].solPrice;
    const totalSol = holderUsd / solPrice;
    const n = rng.int(380, 760);
    const youAt = rng.bool(0.8) ? rng.int(0, n - 1) : -1;
    const weights = Array.from({ length: n }, () => Math.exp(rng.normal() * 1.4));
    const wsum = weights.reduce((a, b) => a + b, 0);
    const amounts = weights.map((w) => BigInt(Math.floor((w / wsum) * totalSol * 1e9)));
    const leaves = amounts.map((a, i) => leafHash(i, i === youAt ? claimant.toBytes() : rng.bytes(32), a));
    const levels = buildLevels(leaves);
    const total = amounts.reduce((s, x) => s + x, 0n);
    const publishedAt = week[week.length - 1].date - 6 * 3_600_000;
    const expiresAt = publishedAt + 30 * DAY;
    // Older epochs are mostly claimed; the newest are still open.
    const claimedShare = e <= 8 ? rng.range(0.7, 0.97) : rng.range(0.1, 0.55);
    out.push({
      epoch: e,
      root: toHex(rootOf(levels)),
      totalLamports: total.toString(),
      numLeaves: n,
      claimedLamports: BigInt(Math.floor(Number(total) * claimedShare)).toString(),
      publishedAt,
      expiresAt,
      expired: expiresAt < now,
      solPriceAtPublish: solPrice,
      you: youAt >= 0 ? { index: youAt, amount: amounts[youAt].toString(), proof: proofFor(levels, youAt).map(toHex) } : null,
    });
  }
  return out;
}

const epochCache = new Map<string, readonly DemoEpoch[]>();

/**
 * `rewardEpochs` for a wallet, built once per visit and shared by every view
 * that shows them (header notifications, Portfolio, Holder rewards, the claim
 * panel): building the trees takes about 150ms. Copy before sorting.
 */
export function walletEpochs(claimant: PublicKey): readonly DemoEpoch[] {
  const key = claimant.toBase58();
  let epochs = epochCache.get(key);
  if (!epochs) epochCache.set(key, (epochs = rewardEpochs(claimant)));
  return epochs;
}

/** The wallet demo mode treats as "you" before a real wallet connects. */
export const DEMO_WALLET = new PublicKey(new Rng("demo-wallet").bytes(32));

import type { Reserves } from "./curve";

export type Stage = "new" | "live" | "soon" | "graduated";

/** Lock expiries in ms since epoch (3 days after the launch). */
export interface Locks {
  ticker: number;
  name: number;
  tweet: number | null;
}

export interface Coin {
  mint: string;
  name: string;
  ticker: string;
  image: string;
  description: string;
  creator: string;
  creatorHandle: string;
  createdAt: number;
  stage: Stage;
  reserves: Reserves;
  complete: boolean;
  migrated: boolean;
  /** USD per whole token. */
  priceUsd: number;
  mcapUsd: number;
  athUsd: number;
  vol24hUsd: number;
  buyVolUsd: number;
  sellVolUsd: number;
  buys24h: number;
  sells24h: number;
  traders24h: number;
  change1h: number;
  change6h: number;
  change24h: number;
  holders: number;
  devPct: number;
  replies: number;
  locks: Locks;
  tweetId: string | null;
  /** DexScreener listing escrow accrued from this coin's fees. */
  escrowUsd: number;
  escrowReleased: boolean;
  /** Price points across the last 24h (USD), oldest first. */
  spark: number[];
  socials: { x?: string; website?: string; telegram?: string };
  hot: boolean;
  /** Raydium pool and LP lock once graduated. */
  pool?: { address: string; lpLocked: boolean; feeNft: string; lpFeesUsd: number };
}

export interface Trade {
  id: string;
  mint: string;
  side: "buy" | "sell";
  trader: string;
  handle: string;
  sol: number;
  tokens: number;
  priceUsd: number;
  mcapUsd: number;
  ts: number;
  sig: string;
}

export type Period = "1D" | "1W" | "1M";

export interface Trader {
  handle: string;
  name: string;
  address: string;
  avatar: string;
  x: boolean;
  verified: boolean;
  squad?: string;
  pnl: Record<Period, number>;
  volume: Record<Period, number>;
  trades: Record<Period, number>;
  winRate: number;
  bestCoin: string;
  rewardsUsd: number;
}

export interface Squad {
  name: string;
  tag: string;
  members: number;
  pnl: Record<Period, number>;
  volume: Record<Period, number>;
  emblem: string;
}

export interface Callout {
  id: string;
  handle: string;
  text: string;
  mint: string;
  positionUsd: number;
  pnlUsd: number;
  pnlPct: number;
  closed: boolean;
  calledAtMcap: number;
  ts: number;
  views: number;
  comments: number;
  likes: number;
  shares: number;
}

export interface Stream {
  id: string;
  handle: string;
  title: string;
  mint: string;
  viewers: number;
  startedAt: number;
  kind: "live" | "clip";
  durationSec: number;
}

export interface Holder {
  address: string;
  label?: "Bonding curve" | "Dev" | "Raydium pool" | "Burn & Earn lock";
  pct: number;
  tokens: number;
  valueUsd: number;
  /** Unknown (null) for on-chain holders: the indexer doesn't track every holder's cost. */
  pnlUsd: number | null;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

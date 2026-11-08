/**
 * Reward claims in chain mode: allocations from the indexer (GET /rewards/:wallet, services/parabull-indexer
 * src/rewards.ts), checked against the RewardEpoch account itself just before claim_holder_reward is sent. The indexer
 * is never trusted on its own: the proof must lead to the on-chain root, the leaf must be unclaimed in the on-chain
 * bitmap, and the epoch must not be expired.
 */
import { leafHash, verifyProof } from "./merkle";

export type RewardKind = "holder" | "caller";

export interface AllocationJson {
  epoch: number;
  kind: RewardKind;
  index: number;
  amount: string;
  proof: string[] | null;
  root: string;
  claimed: boolean;
  expired: boolean;
  claimable: boolean;
  /** Unix seconds. */
  publishedAt: number;
  expiresAt: number;
  totalLamports: string;
  numLeaves: number;
}

export interface WalletRewardsJson {
  wallet: string;
  allocations: AllocationJson[];
  unclaimedLamports: string;
  /** Epochs whose snapshot the indexer hasn't verified (yet): the wallet may have allocations there it can't show. */
  unverifiedEpochs: number[];
}

export interface RewardsSummaryJson {
  epochs: { epoch: number; kind: RewardKind | null; artifact: "loading" | "verified" | "missing" | "mismatch"; totalLamports: string; numLeaves: number; publishedAt: number; expiresAt: number; expired: boolean }[];
  totals: Record<RewardKind, { epochs: number; lamports: string; allocations: number }>;
  vault: { totalDeposited: string; totalCommitted: string; totalClaimed: string; totalExpired: string; nextEpoch: number } | null;
}

export const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
export const bytesToHex = (b: Uint8Array | number[]) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The allocation's proof leads to the root the indexer reports (a quick check for the list). */
export function proofMatches(a: AllocationJson, wallet: Uint8Array): boolean {
  return !!a.proof && verifyProof(a.proof.map(hexToBytes), hexToBytes(a.root), leafHash(a.index, wallet, BigInt(a.amount)));
}

/** What the program will check, from the RewardEpoch account (as Anchor decodes it). */
export interface OnChainEpoch {
  merkleRoot: Uint8Array | number[];
  numLeaves: number;
  expired: boolean;
  claimedBitmap: Uint8Array | number[];
}

/** Why the claim would fail on-chain, or null when it will go through. */
export function checkBeforeClaim(onChain: OnChainEpoch | null, wallet: Uint8Array, a: AllocationJson): string | null {
  if (!onChain) return `Epoch ${a.epoch} isn't on-chain`;
  if (onChain.expired) return `Epoch ${a.epoch} has expired`;
  if (!a.proof) return "No proof for this allocation";
  const root = bytesToHex(onChain.merkleRoot);
  if (root !== a.root) return "The indexer's root doesn't match the on-chain root";
  if (a.index >= onChain.numLeaves) return "The allocation is outside the epoch";
  if (((onChain.claimedBitmap[a.index >> 3] ?? 0) & (1 << (a.index & 7))) !== 0) return "Already claimed";
  if (!verifyProof(a.proof.map(hexToBytes), Uint8Array.from(onChain.merkleRoot), leafHash(a.index, wallet, BigInt(a.amount)))) return "The proof doesn't match the on-chain root";
  return null;
}

/** The rows a claim panel shows: every claimable allocation first (never cut off), then the newest others, up to `max`. */
export function claimRows(allocations: AllocationJson[], max = 12): AllocationJson[] {
  const claimable = allocations.filter((a) => a.claimable);
  return [...claimable, ...allocations.filter((a) => !a.claimable).slice(0, Math.max(0, max - claimable.length))];
}

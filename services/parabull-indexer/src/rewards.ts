/**
 * Reward epochs (programs/parabull/src/instructions/rewards.rs): every RewardEpoch account (root, total, expiry and the
 * claimed bitmap) and the snapshot artifact each one was published from, `<REWARDS_BASE_URL>/epoch-<n>.json` (the
 * file scripts/src/snapshot.ts and scripts/src/callerEpoch.ts write). Holder epochs and caller epochs (a callout's
 * referral rewards) share the program's one counter and vault; the artifact's `kind` tells them apart.
 *
 * An artifact is trusted only after the indexer rebuilds its whole Merkle tree from the leaves and gets the on-chain
 * root, total and leaf count. Proofs are then cut from that tree, never copied from the file. A file that doesn't
 * match is "mismatch" and none of its allocations are served. Trees are kept while their epoch can still be claimed
 * (until expire_reward_epoch runs).
 */
import { base58Decode, isAddress } from "../../../app/src/lib/chatMessage";
import { buildLevels, leafHash, proofFor, rootOf } from "../../../app/src/lib/merkle";

export type RewardKind = "holder" | "caller";
export type ArtifactState = "loading" | "verified" | "missing" | "mismatch";

export interface EpochRecord {
  epoch: number;
  address: string;
  root: Uint8Array;
  totalLamports: bigint;
  claimedLamports: bigint;
  numLeaves: number;
  claimedCount: number;
  publishedAt: number;
  expiresAt: number;
  expired: boolean;
  snapshotSlot: number;
  bitmap: Uint8Array;
}

export interface Leaf {
  index: number;
  claimant: string;
  amount: bigint;
}

interface Artifact {
  state: ArtifactState;
  kind: RewardKind | null;
  error?: string;
  /** Next load attempt (ms) for loading / missing. */
  retryAt: number;
  tries: number;
  leaves?: Leaf[];
  /** The rebuilt tree, while the epoch can be claimed. */
  levels?: Uint8Array[][];
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const isClaimed = (bitmap: Uint8Array, index: number) => ((bitmap[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;

/**
 * Checks an artifact against its on-chain epoch: same epoch, leaf count and total, every leaf in index order with a
 * real address and a positive amount, and a rebuilt root equal to the on-chain one. Returns the leaves and tree.
 */
export function verifyArtifact(raw: unknown, e: Pick<EpochRecord, "epoch" | "root" | "totalLamports" | "numLeaves">): { ok: true; kind: RewardKind; leaves: Leaf[]; levels: Uint8Array[][] } | { ok: false; error: string } {
  const a = (typeof raw === "object" && raw !== null ? raw : {}) as { epoch?: unknown; root?: unknown; totalLamports?: unknown; numLeaves?: unknown; kind?: unknown; leaves?: unknown };
  if (a.epoch !== e.epoch) return { ok: false, error: "epoch number differs" };
  if (a.root !== hex(e.root)) return { ok: false, error: "root differs from the on-chain root" };
  if (a.totalLamports !== e.totalLamports.toString() || a.numLeaves !== e.numLeaves) return { ok: false, error: "total or leaf count differs from the chain" };
  if (!Array.isArray(a.leaves) || a.leaves.length !== e.numLeaves) return { ok: false, error: "leaf list doesn't match numLeaves" };
  const leaves: Leaf[] = [];
  let sum = 0n;
  for (const [i, l] of (a.leaves as { index?: unknown; claimant?: unknown; amount?: unknown }[]).entries()) {
    if (l?.index !== i || !isAddress(l.claimant) || typeof l.amount !== "string" || !/^[1-9]\d{0,19}$/.test(l.amount)) return { ok: false, error: `leaf ${i} is malformed` };
    const amount = BigInt(l.amount);
    sum += amount;
    leaves.push({ index: i, claimant: l.claimant, amount });
  }
  if (sum !== e.totalLamports) return { ok: false, error: "leaf amounts don't add up to the total" };
  const levels = buildLevels(leaves.map((l) => leafHash(l.index, base58Decode(l.claimant)!, l.amount)));
  if (hex(rootOf(levels)) !== hex(e.root)) return { ok: false, error: "leaves don't rebuild the on-chain root" };
  return { ok: true, kind: a.kind === "caller" ? "caller" : "holder", leaves, levels };
}

export interface AllocationJson {
  epoch: number;
  kind: RewardKind;
  index: number;
  amount: string;
  /** Hex siblings from the indexer's own tree; null once the epoch is expired (nothing left to claim). */
  proof: string[] | null;
  root: string;
  claimed: boolean;
  expired: boolean;
  claimable: boolean;
  publishedAt: number;
  expiresAt: number;
  totalLamports: string;
  numLeaves: number;
}

export class RewardsIndex {
  readonly epochs = new Map<number, EpochRecord>();
  private readonly artifacts = new Map<number, Artifact>();
  /** wallet -> [epoch, leaf index] of every verified allocation. */
  private readonly byWallet = new Map<string, [number, number][]>();
  vault: { totalDeposited: bigint; totalCommitted: bigint; totalClaimed: bigint; totalExpired: bigint; nextEpoch: number } | null = null;

  /** Replaces an epoch's on-chain state (a sync or a refresh). Expiry drops its tree. */
  upsert(e: EpochRecord) {
    this.epochs.set(e.epoch, e);
    if (!this.artifacts.has(e.epoch)) this.artifacts.set(e.epoch, { state: "loading", kind: null, retryAt: 0, tries: 0 });
    if (e.expired) delete this.artifacts.get(e.epoch)!.levels;
  }

  /** A HolderRewardClaimed event: mark the leaf claimed now (the next sync confirms it from the account). */
  markClaimed(epoch: number, index: number, amount: bigint) {
    const e = this.epochs.get(epoch);
    if (!e || index >= e.numLeaves || isClaimed(e.bitmap, index)) return;
    e.bitmap[index >> 3] |= 1 << (index & 7);
    e.claimedLamports += amount;
    e.claimedCount += 1;
  }

  /** Epochs whose artifact should be (re)loaded now. */
  due(now: number): number[] {
    return [...this.epochs.keys()].filter((n) => {
      const a = this.artifacts.get(n)!;
      return (a.state === "loading" || a.state === "missing") && a.retryAt <= now;
    });
  }

  /** The result of loading epoch `n`'s artifact (`raw` null: not found or unreadable). */
  loaded(n: number, raw: unknown | null, now: number) {
    const e = this.epochs.get(n);
    const a = this.artifacts.get(n);
    if (!e || !a) return;
    a.tries += 1;
    if (raw === null) {
      a.state = "missing";
      a.error = "artifact not found";
      // Back off from 30 s to 30 min: an epoch is usually published just before its file is uploaded.
      a.retryAt = now + Math.min(30_000 * 2 ** (a.tries - 1), 1_800_000);
      return;
    }
    const v = verifyArtifact(raw, e);
    if (!v.ok) {
      Object.assign(a, { state: "mismatch", error: v.error, kind: null });
      return;
    }
    Object.assign(a, { state: "verified", kind: v.kind, error: undefined, leaves: v.leaves, levels: e.expired ? undefined : v.levels });
    for (const l of v.leaves) {
      const list = this.byWallet.get(l.claimant) ?? [];
      if (!list.some(([ep, i]) => ep === n && i === l.index)) list.push([n, l.index]);
      this.byWallet.set(l.claimant, list);
    }
  }

  artifactState(n: number) {
    const a = this.artifacts.get(n);
    return a ? { state: a.state, kind: a.kind, error: a.error ?? null } : null;
  }

  /** Every verified allocation of `wallet`, newest epoch first, with claimed state from the on-chain bitmap. */
  forWallet(wallet: string) {
    const allocations: AllocationJson[] = [];
    for (const [n, index] of this.byWallet.get(wallet) ?? []) {
      const e = this.epochs.get(n);
      const a = this.artifacts.get(n);
      const leaf = a?.leaves?.[index];
      if (!e || !a || a.state !== "verified" || !leaf) continue;
      const claimed = isClaimed(e.bitmap, index);
      const proof = a.levels ? proofFor(a.levels, index).map(hex) : null;
      allocations.push({ epoch: n, kind: a.kind!, index, amount: leaf.amount.toString(), proof, root: hex(e.root), claimed, expired: e.expired, claimable: !claimed && !e.expired && proof !== null, publishedAt: e.publishedAt, expiresAt: e.expiresAt, totalLamports: e.totalLamports.toString(), numLeaves: e.numLeaves });
    }
    allocations.sort((x, y) => y.epoch - x.epoch);
    const unclaimed = allocations.filter((x) => x.claimable).reduce((s, x) => s + BigInt(x.amount), 0n);
    const unverified = [...this.epochs.keys()].filter((n) => this.artifacts.get(n)?.state !== "verified").sort((a, b) => b - a);
    return { wallet, allocations, unclaimedLamports: unclaimed.toString(), unverifiedEpochs: unverified };
  }

  /** Every epoch with its on-chain figures and artifact state, plus totals by kind (verified epochs only). */
  summary() {
    const epochs = [...this.epochs.values()]
      .sort((a, b) => b.epoch - a.epoch)
      .map((e) => {
        const a = this.artifacts.get(e.epoch)!;
        return {
          epoch: e.epoch,
          kind: a.kind,
          artifact: a.state,
          root: hex(e.root),
          totalLamports: e.totalLamports.toString(),
          claimedLamports: e.claimedLamports.toString(),
          numLeaves: e.numLeaves,
          claimedCount: e.claimedCount,
          publishedAt: e.publishedAt,
          expiresAt: e.expiresAt,
          expired: e.expired,
        };
      });
    const totals = { holder: { epochs: 0, lamports: 0n, allocations: 0 }, caller: { epochs: 0, lamports: 0n, allocations: 0 } };
    for (const e of epochs) {
      if (!e.kind || e.artifact !== "verified") continue;
      totals[e.kind].epochs += 1;
      totals[e.kind].lamports += BigInt(e.totalLamports);
      totals[e.kind].allocations += e.numLeaves;
    }
    const t = (x: typeof totals.holder) => ({ epochs: x.epochs, lamports: x.lamports.toString(), allocations: x.allocations });
    const v = this.vault;
    return {
      epochs,
      totals: { holder: t(totals.holder), caller: t(totals.caller) },
      vault: v && { totalDeposited: v.totalDeposited.toString(), totalCommitted: v.totalCommitted.toString(), totalClaimed: v.totalClaimed.toString(), totalExpired: v.totalExpired.toString(), nextEpoch: v.nextEpoch },
    };
  }
}

/**
 * Port of programs/parabull/src/merkle.rs. The backend snapshot job MUST use
 * exactly this format; `merkle.test.ts` pins a root shared with the Rust tests.
 *   leaf = sha256(0x00 || index u32 LE || claimant 32B || amount u64 LE)
 *   node = sha256(0x01 || min(a,b) || max(a,b)); odd node carried up.
 */
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";

const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();

export function leafHash(index: number, claimant: PublicKey, amount: bigint): Buffer {
  const i = Buffer.alloc(4);
  i.writeUInt32LE(index);
  const a = Buffer.alloc(8);
  a.writeBigUInt64LE(amount);
  return sha256(Buffer.from([0x00]), i, claimant.toBuffer(), a);
}

export function nodeHash(a: Buffer, b: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(Buffer.from([0x01]), lo, hi);
}

export class MerkleTree {
  readonly levels: Buffer[][];
  constructor(leaves: Buffer[]) {
    if (leaves.length === 0) throw new Error("empty tree");
    this.levels = [leaves];
    while (this.levels[this.levels.length - 1].length > 1) {
      const prev = this.levels[this.levels.length - 1];
      const next: Buffer[] = [];
      for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? nodeHash(prev[i], prev[i + 1]) : prev[i]);
      this.levels.push(next);
    }
  }
  root(): Buffer {
    return this.levels[this.levels.length - 1][0];
  }
  proof(index: number): Buffer[] {
    const proof: Buffer[] = [];
    for (const level of this.levels.slice(0, -1)) {
      const sib = index ^ 1;
      if (sib < level.length) proof.push(level[sib]);
      index = Math.floor(index / 2);
    }
    return proof;
  }
}

export function verify(proof: Buffer[], root: Buffer, leaf: Buffer): boolean {
  return proof.reduce((acc, s) => nodeHash(acc, s), leaf).equals(root);
}

export interface RewardEntry {
  claimant: PublicKey;
  amount: bigint;
}

/** Build an epoch from a holder snapshot (index = position in `entries`). */
export function buildEpoch(entries: RewardEntry[]) {
  const tree = new MerkleTree(entries.map((e, i) => leafHash(i, e.claimant, e.amount)));
  const total = entries.reduce((s, e) => s + e.amount, 0n);
  return { tree, root: tree.root(), total, numLeaves: entries.length };
}

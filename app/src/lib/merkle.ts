/**
 * Holder-reward proofs (port of scripts/src/merkle.ts / merkle.rs):
 *   leaf = sha256(0x00 || index u32 LE || claimant 32B || amount u64 LE)
 *   node = sha256(0x01 || min(a,b) || max(a,b)); odd node carried up.
 */
import { concatBytes, sha256 } from "./sha256";

const cmp = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

export function leafHash(index: number, claimant: Uint8Array, amount: bigint): Uint8Array {
  const i = new Uint8Array(4);
  new DataView(i.buffer).setUint32(0, index, true);
  const a = new Uint8Array(8);
  new DataView(a.buffer).setBigUint64(0, amount, true);
  return sha256(concatBytes(Uint8Array.of(0x00), i, claimant, a));
}

export function nodeHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = cmp(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(concatBytes(Uint8Array.of(0x01), lo, hi));
}

export function buildLevels(leaves: Uint8Array[]): Uint8Array[][] {
  if (leaves.length === 0) throw new Error("empty tree");
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? nodeHash(prev[i], prev[i + 1]) : prev[i]);
    levels.push(next);
  }
  return levels;
}

export const rootOf = (levels: Uint8Array[][]) => levels[levels.length - 1][0];

export function proofFor(levels: Uint8Array[][], index: number): Uint8Array[] {
  const proof: Uint8Array[] = [];
  let i = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const sibling = i ^ 1;
    if (sibling < levels[l].length) proof.push(levels[l][sibling]);
    i >>= 1;
  }
  return proof;
}

export function verifyProof(proof: Uint8Array[], root: Uint8Array, leaf: Uint8Array): boolean {
  let h = leaf;
  for (const p of proof) h = nodeHash(h, p);
  return cmp(h, root) === 0 && h.length === root.length;
}

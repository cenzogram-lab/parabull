//! Holder-reward Merkle tree.
//!
//! - Leaf:  `sha256(0x00 || index_le_u32 || claimant || amount_le_u64)`
//! - Node:  `sha256(0x01 || min(a, b) || max(a, b))` (sorted pairs, so proofs
//!   carry no left/right flags)
//! - Odd levels: the last node is carried up unchanged.
//!
//! The 0x00/0x01 prefixes stop a 64-byte internal node from being replayed as
//! a leaf. The backend snapshot job must build trees with exactly these rules;
//! `MerkleTree` below is the reference implementation (used by tests).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

pub type Hash32 = [u8; 32];

pub fn leaf_hash(index: u32, claimant: &Pubkey, amount: u64) -> Hash32 {
    hashv(&[&[0x00], &index.to_le_bytes(), claimant.as_ref(), &amount.to_le_bytes()]).to_bytes()
}

pub fn node_hash(a: &Hash32, b: &Hash32) -> Hash32 {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    hashv(&[&[0x01], lo, hi]).to_bytes()
}

pub fn verify(proof: &[Hash32], root: &Hash32, leaf: Hash32) -> bool {
    proof.iter().fold(leaf, |acc, sibling| node_hash(&acc, sibling)) == *root
}

/// Reference builder (off-chain / tests).
pub struct MerkleTree {
    levels: Vec<Vec<Hash32>>,
}

impl MerkleTree {
    pub fn new(leaves: Vec<Hash32>) -> Self {
        assert!(!leaves.is_empty(), "empty tree");
        let mut levels = vec![leaves];
        while levels.last().unwrap().len() > 1 {
            let prev = levels.last().unwrap();
            let next = prev
                .chunks(2)
                .map(|pair| if pair.len() == 2 { node_hash(&pair[0], &pair[1]) } else { pair[0] })
                .collect();
            levels.push(next);
        }
        MerkleTree { levels }
    }

    pub fn root(&self) -> Hash32 {
        self.levels.last().unwrap()[0]
    }

    pub fn proof(&self, mut index: usize) -> Vec<Hash32> {
        let mut proof = Vec::new();
        for level in &self.levels[..self.levels.len() - 1] {
            let sibling = index ^ 1;
            if sibling < level.len() {
                proof.push(level[sibling]);
            }
            index /= 2;
        }
        proof
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(n: u32) -> (Vec<(Pubkey, u64)>, MerkleTree) {
        let entries: Vec<_> = (0..n).map(|i| (Pubkey::new_unique(), 1_000 + u64::from(i))).collect();
        let leaves = entries.iter().enumerate().map(|(i, (k, a))| leaf_hash(i as u32, k, *a)).collect();
        (entries, MerkleTree::new(leaves))
    }

    #[test]
    fn every_leaf_verifies_for_many_sizes() {
        for n in [1, 2, 3, 4, 5, 7, 8, 9, 16, 33, 100] {
            let (entries, t) = tree(n);
            for (i, (k, a)) in entries.iter().enumerate() {
                assert!(verify(&t.proof(i), &t.root(), leaf_hash(i as u32, k, *a)), "n={n} i={i}");
            }
        }
    }

    #[test]
    fn tampering_fails() {
        let (entries, t) = tree(9);
        let (k, a) = entries[4];
        let proof = t.proof(4);
        assert!(verify(&proof, &t.root(), leaf_hash(4, &k, a)));
        assert!(!verify(&proof, &t.root(), leaf_hash(4, &k, a + 1)), "amount");
        assert!(!verify(&proof, &t.root(), leaf_hash(4, &Pubkey::new_unique(), a)), "claimant");
        assert!(!verify(&proof, &t.root(), leaf_hash(5, &k, a)), "index");
        assert!(!verify(&proof[1..], &t.root(), leaf_hash(4, &k, a)), "truncated proof");
        let mut bad = proof.clone();
        bad[0][0] ^= 1;
        assert!(!verify(&bad, &t.root(), leaf_hash(4, &k, a)), "corrupted sibling");
    }

    /// Cross-language vector: the same root is pinned in
    /// `scripts/src/merkle.test.ts` and was computed independently in Python.
    /// Claimant i = [i+1; 32], amount i = 1000 * (i+1), i in 0..5.
    #[test]
    fn pinned_cross_language_vector() {
        let leaves = (0..5u8)
            .map(|i| leaf_hash(u32::from(i), &Pubkey::new_from_array([i + 1; 32]), 1_000 * (u64::from(i) + 1)))
            .collect();
        let root = MerkleTree::new(leaves).root();
        let hex: String = root.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "8e2f88cdcb92884d2f7366851fa96d7301a484d2407381bc1566a4c5de6f1e7a");
    }

    #[test]
    fn internal_node_cannot_pose_as_leaf() {
        let (_, t) = tree(4);
        // Level-1 node 0 with its proof would reach the root if leaves and
        // nodes shared a hash domain; the prefixes make the leaf form unusable.
        let node = t.levels[1][0];
        let proof_from_node = vec![t.levels[1][1]];
        assert!(verify(&proof_from_node, &t.root(), node), "sanity: node-level proof");
        // An attacker would need a leaf preimage equal to `node`; leaf_hash
        // always starts its preimage with 0x00, node_hash with 0x01.
        assert_ne!(leaf_hash(0, &Pubkey::new_from_array(node), 0), node);
    }
}

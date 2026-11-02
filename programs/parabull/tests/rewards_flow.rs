//! Runtime tests for holder-reward Merkle epochs: publish (crank), claim
//! (pull by holder or pushed in batches by anyone), double-claim and proof
//! rejection, solvency and rent-exemption of the vault.

mod common;
use common::*;
use parabull::merkle::{leaf_hash, MerkleTree};
use parabull::state::{HolderRewardVault, RewardEpoch};

struct Snapshot {
    holders: Vec<(Keypair, u64)>,
    tree: MerkleTree,
}

impl Snapshot {
    fn total(&self) -> u64 {
        self.holders.iter().map(|(_, a)| a).sum()
    }
    fn proof(&self, i: usize) -> Vec<[u8; 32]> {
        self.tree.proof(i)
    }
}

async fn snapshot(env: &mut Env, amounts: &[u64]) -> Snapshot {
    let mut holders = Vec::new();
    for a in amounts {
        holders.push((env.user_with(SOL).await, *a));
    }
    let leaves = holders.iter().enumerate().map(|(i, (k, a))| leaf_hash(i as u32, &k.pubkey(), *a)).collect();
    Snapshot { holders, tree: MerkleTree::new(leaves) }
}

fn vault() -> Pubkey {
    pda(&[SEED_HOLDER_VAULT])
}

#[tokio::test]
async fn publish_then_pull_and_push_claims() {
    let mut env = Env::new().await;
    env.fund_account(&vault(), 5 * SOL).await;
    let snap = snapshot(&mut env, &[100_000_000, 250_000_000, 50_000_000, 400_000_000, 200_000_000]).await;
    let crank = env.crank.insecure_clone();

    let ix = env.publish_epoch_ix(&crank.pubkey(), snap.tree.root(), snap.total(), 5).await;
    env.send(&[ix], &[&crank]).await.unwrap();
    let e: RewardEpoch = env.anchor(&Env::reward_epoch_pda(0)).await;
    assert_eq!((e.epoch, e.num_leaves, e.total_lamports, e.claimed_count), (0, 5, snap.total(), 0));
    let v: HolderRewardVault = env.anchor(&vault()).await;
    assert_eq!((v.next_epoch, v.total_committed_lamports), (1, snap.total()));

    // Pull: holder 1 submits (and pays for) their own claim transaction.
    let (h1, a1) = (&snap.holders[1].0, snap.holders[1].1);
    let before = env.lamports(&h1.pubkey()).await;
    let ix = env.claim_ix(0, &h1.pubkey(), 1, a1, snap.proof(1));
    let blockhash = env.ctx.get_new_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&h1.pubkey()), &[h1], blockhash);
    env.ctx.banks_client.process_transaction(tx).await.unwrap();
    const TX_FEE: u64 = 5_000; // one signature
    assert_eq!(env.lamports(&h1.pubkey()).await + TX_FEE - before, a1);

    // Push: the crank pays holders 0, 2, 3 in one transaction (they don't sign).
    let befores: Vec<u64> = {
        let mut v = Vec::new();
        for i in [0, 2, 3] {
            v.push(env.lamports(&snap.holders[i].0.pubkey()).await);
        }
        v
    };
    let ixs: Vec<_> = [0usize, 2, 3].iter().map(|&i| env.claim_ix(0, &snap.holders[i].0.pubkey(), i as u32, snap.holders[i].1, snap.proof(i))).collect();
    let blockhash = env.ctx.get_new_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(&ixs, Some(&crank.pubkey()), &[&crank], blockhash);
    env.ctx.banks_client.process_transaction(tx).await.unwrap();
    for (n, i) in [0usize, 2, 3].iter().enumerate() {
        assert_eq!(env.lamports(&snap.holders[*i].0.pubkey()).await - befores[n], snap.holders[*i].1);
    }

    let e: RewardEpoch = env.anchor(&Env::reward_epoch_pda(0)).await;
    let paid = snap.holders[0].1 + a1 + snap.holders[2].1 + snap.holders[3].1;
    assert_eq!((e.claimed_count, e.claimed_lamports), (4, paid));
    assert!(e.is_claimed(0) && e.is_claimed(1) && !e.is_claimed(4));
    let v: HolderRewardVault = env.anchor(&vault()).await;
    assert_eq!(v.total_claimed_lamports, paid);
}

#[tokio::test]
async fn bad_claims_are_rejected() {
    let mut env = Env::new().await;
    env.fund_account(&vault(), 2 * SOL).await;
    let snap = snapshot(&mut env, &[100_000_000, 200_000_000, 300_000_000]).await;
    let crank = env.crank.insecure_clone();
    let ix = env.publish_epoch_ix(&crank.pubkey(), snap.tree.root(), snap.total(), 3).await;
    env.send(&[ix], &[&crank]).await.unwrap();
    let (h0, a0) = (snap.holders[0].0.pubkey(), snap.holders[0].1);
    let attacker = env.funded_user().await;

    // Inflated amount, someone else's leaf, wrong index, empty proof.
    assert_custom(env.send(&[env.claim_ix(0, &h0, 0, a0 + 1, snap.proof(0))], &[]).await, ParabullError::InvalidMerkleProof);
    assert_custom(env.send(&[env.claim_ix(0, &attacker.pubkey(), 0, a0, snap.proof(0))], &[]).await, ParabullError::InvalidMerkleProof);
    assert_custom(env.send(&[env.claim_ix(0, &h0, 1, a0, snap.proof(0))], &[]).await, ParabullError::InvalidMerkleProof);
    assert_custom(env.send(&[env.claim_ix(0, &h0, 0, a0, vec![])], &[]).await, ParabullError::InvalidMerkleProof);

    // Valid once, then never again.
    env.send(&[env.claim_ix(0, &h0, 0, a0, snap.proof(0))], &[]).await.unwrap();
    let mut again = env.claim_ix(0, &h0, 0, a0, snap.proof(0));
    again.data.push(0); // distinct transaction bytes; trailing data is ignored by Anchor
    assert_custom(env.send(&[again], &[]).await, ParabullError::RewardAlreadyClaimed);
}

#[tokio::test]
async fn epochs_must_be_funded_and_vault_stays_rent_exempt() {
    let mut env = Env::new().await;
    let rent = env.rent_exempt(8 + HolderRewardVault::INIT_SPACE).await;
    env.fund_account(&vault(), SOL).await;
    let crank = env.crank.insecure_clone();

    // More than the vault holds above rent.
    let snap = snapshot(&mut env, &[SOL / 2, SOL / 2 + 1]).await;
    let ix = env.publish_epoch_ix(&crank.pubkey(), snap.tree.root(), snap.total(), 2).await;
    assert_custom(env.send(&[ix], &[&crank]).await, ParabullError::InsufficientRewardFunds);

    // Exactly everything above rent, split over two epochs: the second must
    // account for the first one's outstanding (unclaimed) commitment.
    let first = snapshot(&mut env, &[SOL / 2]).await;
    let ix = env.publish_epoch_ix(&crank.pubkey(), first.tree.root(), first.total(), 1).await;
    env.send(&[ix], &[&crank]).await.unwrap();
    let second = snapshot(&mut env, &[SOL / 2 + 1]).await;
    let ix = env.publish_epoch_ix(&crank.pubkey(), second.tree.root(), second.total(), 1).await;
    assert_custom(env.send(&[ix], &[&crank]).await, ParabullError::InsufficientRewardFunds);
    let second = snapshot(&mut env, &[SOL / 2]).await;
    let ix = env.publish_epoch_ix(&crank.pubkey(), second.tree.root(), second.total(), 1).await;
    env.send(&[ix], &[&crank]).await.unwrap();

    // Pay out both: vault lands exactly on its rent-exempt minimum.
    let (a, b) = (first.holders[0].0.pubkey(), second.holders[0].0.pubkey());
    let ixs = [env.claim_ix(0, &a, 0, SOL / 2, first.proof(0)), env.claim_ix(1, &b, 0, SOL / 2, second.proof(0))];
    env.send(&ixs, &[]).await.unwrap();
    assert_eq!(env.lamports(&vault()).await, rent);

    // Non-crank can't publish.
    let stranger = env.funded_user().await;
    let ix = env.publish_epoch_ix(&stranger.pubkey(), [9; 32], 1, 1).await;
    assert_custom(env.send(&[ix], &[&stranger]).await, ParabullError::Unauthorized);
}

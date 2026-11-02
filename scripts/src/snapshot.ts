/**
 * $PARABULL holder snapshot -> holder-reward Merkle epoch(s).
 *
 *   CLUSTER=devnet npm run snapshot              # dry run: writes snapshots/epoch-<n>.draft.json
 *   CLUSTER=devnet npm run snapshot -- --publish # publishes and writes snapshots/epoch-<n>.json
 *
 * Steps:
 * 1. Every token account of Global.parabull_mint (one getProgramAccounts on
 *    the mint's token program, with the slot it was read at).
 * 2. Balances summed per owner. An owner is eligible only if
 *    `claim_holder_reward` can pay it: a system-owned wallet (or an address
 *    with no account yet), not executable, not on the exclusion list, and
 *    either on-curve or holding lamports (off-curve, empty, system-owned
 *    addresses are typically program authorities such as the CPMM vault
 *    authority). Program-owned holders (pool vaults, curves, other programs'
 *    PDAs) are therefore excluded.
 * 3. Distributable = vault lamports - rent - outstanding (committed - claimed
 *    - expired), times SNAPSHOT_DISTRIBUTE_BPS. Split pro rata by balance,
 *    rounding down; payouts under SNAPSHOT_MIN_PAYOUT_LAMPORTS are dropped
 *    (their share stays in the vault).
 * 4. Chunked into epochs of at most MAX_REWARD_LEAVES. Each tree is built with
 *    src/merkle.ts and every proof is verified locally before publishing.
 */
import { AccountInfo, Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { mkdirSync, renameSync, writeFileSync } from "fs";
import { resolve } from "path";
import { roles } from "./config";
import { MerkleTree, RewardEntry, buildEpoch, leafHash, verify } from "./merkle";
import { cpmmPoolAccounts } from "./pdas";
import { big, bn, connect, isDefault } from "./program";

/** Mirrors constants.rs MAX_REWARD_LEAVES. */
export const MAX_REWARD_LEAVES = 80_000;
export const BURN_ADDRESSES = [new PublicKey("11111111111111111111111111111111"), new PublicKey("1nc1nerator11111111111111111111111111111111")];

export interface TokenBalance {
  owner: PublicKey;
  amount: bigint;
}

export interface Holder {
  owner: PublicKey;
  balance: bigint;
}

/** Sum balances per owner; drop zeros; sort by balance desc, then address (deterministic). */
export function aggregateBalances(accounts: TokenBalance[]): Holder[] {
  const by = new Map<string, Holder>();
  for (const a of accounts) {
    if (a.amount === 0n) continue;
    const k = a.owner.toBase58();
    const h = by.get(k) ?? { owner: a.owner, balance: 0n };
    h.balance += a.amount;
    by.set(k, h);
  }
  return [...by.values()].sort((x, y) => (x.balance === y.balance ? x.owner.toBase58().localeCompare(y.owner.toBase58()) : x.balance > y.balance ? -1 : 1));
}

export interface OwnerInfo {
  /** null = no account at this address (a fresh wallet: system-owned by default). */
  account: Pick<AccountInfo<Buffer>, "owner" | "executable" | "lamports" | "data"> | null;
  onCurve: boolean;
}

export function isEligibleOwner(owner: PublicKey, info: OwnerInfo, excluded: Set<string>): boolean {
  if (excluded.has(owner.toBase58())) return false;
  const acc = info.account;
  if (acc && (!acc.owner.equals(SystemProgram.programId) || acc.executable || acc.data.length > 0)) return false;
  const lamports = acc?.lamports ?? 0;
  return info.onCurve || lamports > 0;
}

export function distributableLamports(vaultLamports: bigint, rentMinimum: bigint, outstanding: bigint, distributeBps = 10_000n): bigint {
  const free = vaultLamports - rentMinimum - outstanding;
  return free > 0n ? (free * distributeBps) / 10_000n : 0n;
}

/** Pro-rata floor allocation. Sum of amounts <= distributable, always. */
export function allocate(holders: Holder[], distributable: bigint, minPayout: bigint): RewardEntry[] {
  const supply = holders.reduce((s, h) => s + h.balance, 0n);
  if (supply === 0n || distributable === 0n) return [];
  return holders
    .map((h) => ({ claimant: h.owner, amount: (distributable * h.balance) / supply }))
    .filter((e) => e.amount > 0n && e.amount >= minPayout);
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface EpochArtifact {
  epoch: number;
  root: string;
  totalLamports: string;
  numLeaves: number;
  snapshotSlot: number;
  parabullMint: string;
  createdAt: string;
  publishSignature?: string;
  leaves: { index: number; claimant: string; amount: string; balance: string; proof: string[] }[];
}

/** Build one epoch, verify every proof, and produce the artifact the claim UI consumes. */
export function buildArtifact(epoch: number, entries: RewardEntry[], balances: Map<string, bigint>, meta: { snapshotSlot: number; parabullMint: PublicKey }) {
  if (entries.length === 0 || entries.length > MAX_REWARD_LEAVES) throw new Error(`epoch must have 1..${MAX_REWARD_LEAVES} leaves`);
  const built = buildEpoch(entries);
  const tree: MerkleTree = built.tree;
  const leaves = entries.map((e, i) => {
    const proof = tree.proof(i);
    if (!verify(proof, built.root, leafHash(i, e.claimant, e.amount))) throw new Error(`proof ${i} does not verify`);
    return {
      index: i,
      claimant: e.claimant.toBase58(),
      amount: e.amount.toString(),
      balance: (balances.get(e.claimant.toBase58()) ?? 0n).toString(),
      proof: proof.map((p) => p.toString("hex")),
    };
  });
  if (built.root.equals(Buffer.alloc(32))) throw new Error("zero root");
  const artifact: EpochArtifact = {
    epoch,
    root: built.root.toString("hex"),
    totalLamports: built.total.toString(),
    numLeaves: built.numLeaves,
    snapshotSlot: meta.snapshotSlot,
    parabullMint: meta.parabullMint.toBase58(),
    createdAt: new Date().toISOString(),
    leaves,
  };
  return { artifact, root: built.root, total: built.total };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

async function ownerInfos(connection: Connection, owners: PublicKey[]): Promise<Map<string, OwnerInfo>> {
  const out = new Map<string, OwnerInfo>();
  for (const batch of chunk(owners, 100)) {
    const infos = await connection.getMultipleAccountsInfo(batch, "confirmed");
    batch.forEach((o, i) => out.set(o.toBase58(), { account: infos[i], onCurve: PublicKey.isOnCurve(o.toBytes()) }));
  }
  return out;
}

export interface SnapshotOptions {
  publish: boolean;
  minPayoutLamports?: bigint;
  distributeBps?: bigint;
  minDistributableLamports?: bigint;
  outDir?: string;
  log?: (...a: unknown[]) => void;
}

export async function runSnapshot(opts: SnapshotOptions) {
  const log = opts.log ?? console.log;
  const { crank } = roles();
  const { connection, program, pdas } = connect(crank);
  const g = await program.account.global.fetch(pdas.global());
  if (isDefault(g.parabullMint)) throw new Error("Global.parabull_mint is not set");

  // 1. Token accounts at a known slot.
  const mintInfo = await connection.getAccountInfo(g.parabullMint);
  if (!mintInfo) throw new Error("$PARABULL mint not found");
  const tokenProgram = mintInfo.owner;
  const filters = [{ memcmp: { offset: 0, bytes: g.parabullMint.toBase58() } }, ...(tokenProgram.equals(TOKEN_PROGRAM_ID) ? [{ dataSize: 165 }] : [])];
  const { context, value } = await connection.getProgramAccounts(tokenProgram, { filters, withContext: true, commitment: "confirmed" });
  const balances: TokenBalance[] = [];
  for (const { pubkey, account } of value) {
    try {
      const t = unpackAccount(pubkey, account, tokenProgram);
      if (t.mint.equals(g.parabullMint)) balances.push({ owner: t.owner, amount: t.amount });
    } catch {
      /* not a token account (e.g. the mint itself) */
    }
  }

  // 2. Eligible holders.
  const excluded = new Set<string>([
    ...BURN_ADDRESSES,
    g.lpLockAuthority,
    pdas.buybackAuthority(),
    pdas.feeKeyVault(),
    pdas.bondingCurve(g.parabullMint),
    pdas.migrationAuthority(g.parabullMint),
    ...(isDefault(g.parabullPool) ? [] : [cpmmPoolAccounts(g.cpmmProgram, g.parabullPool, g.parabullMint, PublicKey.default).authority]),
    ...(process.env.SNAPSHOT_EXCLUDE ?? "").split(",").filter(Boolean).map((s) => new PublicKey(s.trim())),
  ].map((k) => k.toBase58()));
  const aggregated = aggregateBalances(balances);
  const infos = await ownerInfos(connection, aggregated.map((h) => h.owner));
  const holders = aggregated.filter((h) => isEligibleOwner(h.owner, infos.get(h.owner.toBase58())!, excluded));
  log(`snapshot @ slot ${context.slot}: ${value.length} token accounts, ${aggregated.length} owners, ${holders.length} eligible`);

  // 3. Distributable lamports.
  const vaultKey = pdas.holderVault();
  const vaultInfo = await connection.getAccountInfo(vaultKey);
  if (!vaultInfo) throw new Error("HolderRewardVault not found");
  const vault = await program.account.holderRewardVault.fetch(vaultKey);
  const rent = BigInt(await connection.getMinimumBalanceForRentExemption(vaultInfo.data.length));
  const outstanding = big(vault.totalCommittedLamports) - big(vault.totalClaimedLamports) - big(vault.totalExpiredLamports);
  const distributable = distributableLamports(BigInt(vaultInfo.lamports), rent, outstanding, opts.distributeBps ?? BigInt(process.env.SNAPSHOT_DISTRIBUTE_BPS ?? "10000"));
  const minDistributable = opts.minDistributableLamports ?? BigInt(process.env.SNAPSHOT_MIN_DISTRIBUTABLE_LAMPORTS ?? "100000000");
  if (distributable < minDistributable) {
    log(`distributable ${distributable} < minimum ${minDistributable}; nothing to publish`);
    return [];
  }
  const entries = allocate(holders, distributable, opts.minPayoutLamports ?? BigInt(process.env.SNAPSHOT_MIN_PAYOUT_LAMPORTS ?? "10000"));
  if (entries.length === 0) {
    log("no eligible payouts");
    return [];
  }

  // 4. Epochs: build, verify, write, publish.
  const outDir = opts.outDir ?? resolve(__dirname, "../snapshots");
  mkdirSync(outDir, { recursive: true });
  const balanceMap = new Map(holders.map((h) => [h.owner.toBase58(), h.balance]));
  const written: string[] = [];
  let epoch = Number(vault.nextEpoch);
  for (const part of chunk(entries, MAX_REWARD_LEAVES)) {
    const { artifact, root, total } = buildArtifact(epoch, part, balanceMap, { snapshotSlot: context.slot, parabullMint: g.parabullMint });
    const draft = resolve(outDir, `epoch-${epoch}.draft.json`);
    writeFileSync(draft, JSON.stringify(artifact));
    log(`epoch ${epoch}: ${artifact.numLeaves} leaves, ${total} lamports, root ${artifact.root}`);
    if (!opts.publish) {
      written.push(draft);
      epoch += 1;
      continue;
    }
    const sig = await program.methods
      .publishRewardEpoch([...root], bn(total), artifact.numLeaves, bn(context.slot))
      .accountsStrict({ crank: crank.publicKey, global: pdas.global(), holderVault: vaultKey, rewardEpoch: pdas.rewardEpoch(epoch), systemProgram: SystemProgram.programId })
      .signers([crank])
      .rpc();
    const onChain = await program.account.rewardEpoch.fetch(pdas.rewardEpoch(epoch));
    if (!Buffer.from(onChain.merkleRoot).equals(root) || big(onChain.totalLamports) !== total) throw new Error(`epoch ${epoch}: on-chain root/total mismatch`);
    artifact.publishSignature = sig;
    const final = resolve(outDir, `epoch-${epoch}.json`);
    writeFileSync(draft, JSON.stringify(artifact));
    renameSync(draft, final);
    written.push(final);
    log(`published epoch ${epoch}: ${sig}`);
    epoch += 1;
  }
  return written;
}

if (require.main === module) {
  runSnapshot({ publish: process.argv.includes("--publish") }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

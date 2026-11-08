/**
 * Caller epoch: pays callout authors for the buys their callouts brought in, funded by the treasury and paid through the
 * program's existing reward epochs (publish_reward_epoch + claim_holder_reward). No program or IDL change.
 *
 *   CLUSTER=devnet INDEXER_URL=... EDGE_URL=... CALLOUTS_ORIGIN=... CALLER_EPOCH_LAMPORTS=... \
 *     npm run caller-epoch -- --since 2026-11-01 --until 2026-11-08            # dry run: snapshots/epoch-<n>.draft.json
 *   ... npm run caller-epoch -- --since 2026-11-01 --until 2026-11-08 --publish # publishes, writes snapshots/epoch-<n>.json
 *
 * 1. Referred buys in [since, until) from the indexer (GET /referrals, services/parabull-indexer). Fails closed unless
 *    the indexer's referral record is complete from `since` (its `coveredFrom`).
 * 2. Each buy's callout from the edge Worker (GET /callouts?ids=, services/parabull-edge). A buy counts only if the
 *    callout exists, the buy is of the callout's coin, came after the callout was posted, wasn't made by the callout's
 *    author (no self-referral) and cost at least MIN_REFERRED_BUY_LAMPORTS. Each trader counts for at most
 *    PER_TRADER_CAP_LAMPORTS per caller, so one wallet can't make a caller's epoch.
 * 3. CALLER_EPOCH_LAMPORTS is split by counted volume, rounding down, with no caller above MAX_CALLER_SHARE_BPS of it
 *    and nothing under MIN_PAYOUT_LAMPORTS. What isn't paid out stays with the treasury. Only wallets
 *    claim_holder_reward can pay (system-owned) get a leaf.
 * 4. One Merkle tree (src/merkle.ts, every proof checked), written as an artifact with `kind: "caller"`.
 * 5. --publish sends ONE transaction: the treasury's SystemProgram transfer of exactly the epoch's total into the holder
 *    vault, then publish_reward_epoch (crank). Atomic, so the holder snapshot never sees the top-up as distributable,
 *    and publish's own funding check passes on exactly that money. Unclaimed caller rewards, once the epoch is expired,
 *    go back to the vault's free balance, which the next holder snapshot distributes.
 *
 * Upload the final artifact to REWARDS_BASE_URL (where the indexer and the app read epoch-<n>.json).
 */
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction, type Keypair } from "@solana/web3.js";
import { mkdirSync, renameSync, writeFileSync } from "fs";
import { resolve } from "path";
import { isCalloutId, type CalloutJson } from "../../app/src/lib/callouts";
import { loadKeypair, roles } from "./config";
import { buildEpoch, leafHash, verify, type RewardEntry } from "./merkle";
import type { Pdas } from "./pdas";
import { big, bn, connect, type ParabullProgram } from "./program";
import { MAX_REWARD_LEAVES, chunk, isEligibleOwner, type OwnerInfo } from "./snapshot";

/** A referred buy as the indexer serves it (GET /referrals). */
export interface ReferralEvent {
  calloutId: string;
  signature: string;
  index: number;
  mint: string;
  trader: string;
  solLamports: string;
  feeLamports: string;
  tokenAmount: string;
  slot: number;
  timestamp: number;
}

export interface CallerRules {
  minBuyLamports: bigint;
  perTraderCapLamports: bigint;
  maxCallerShareBps: bigint;
  minPayoutLamports: bigint;
}

export const DEFAULT_RULES: CallerRules = {
  minBuyLamports: 50_000_000n, // 0.05 SOL
  perTraderCapLamports: 10_000_000_000n, // 10 SOL per trader per caller
  maxCallerShareBps: 2_500n, // 25% of the epoch
  minPayoutLamports: 10_000n,
};

export interface CallerStats {
  caller: string;
  /** Counted volume (after the per-trader cap), raw volume and fees of the counted buys, in lamports. */
  countedLamports: bigint;
  volumeLamports: bigint;
  feeLamports: bigint;
  buys: number;
  traders: number;
  callouts: string[];
}

export type DropReason = "unknown_callout" | "other_coin" | "self_referral" | "before_callout" | "too_small";

/** Step 2: which buys count, per caller. Deterministic (sorted by caller). */
export function attribute(events: ReferralEvent[], callouts: Map<string, CalloutJson>, rules: CallerRules) {
  const dropped: Record<DropReason, number> = { unknown_callout: 0, other_coin: 0, self_referral: 0, before_callout: 0, too_small: 0 };
  const byCaller = new Map<string, { perTrader: Map<string, bigint>; volume: bigint; fee: bigint; buys: number; callouts: Set<string> }>();
  const seen = new Set<string>();
  for (const e of events) {
    const key = `${e.signature}:${e.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const c = callouts.get(e.calloutId);
    const sol = BigInt(e.solLamports);
    const drop: DropReason | null = !c ? "unknown_callout" : e.mint !== c.mint ? "other_coin" : e.trader === c.wallet ? "self_referral" : e.timestamp * 1000 < c.ts ? "before_callout" : sol < rules.minBuyLamports ? "too_small" : null;
    if (drop) {
      dropped[drop] += 1;
      continue;
    }
    const s = byCaller.get(c!.wallet) ?? { perTrader: new Map(), volume: 0n, fee: 0n, buys: 0, callouts: new Set<string>() };
    s.perTrader.set(e.trader, (s.perTrader.get(e.trader) ?? 0n) + sol);
    s.volume += sol;
    s.fee += BigInt(e.feeLamports);
    s.buys += 1;
    s.callouts.add(e.calloutId);
    byCaller.set(c!.wallet, s);
  }
  const callers: CallerStats[] = [...byCaller]
    .map(([caller, s]) => ({
      caller,
      countedLamports: [...s.perTrader.values()].reduce((sum, v) => sum + (v < rules.perTraderCapLamports ? v : rules.perTraderCapLamports), 0n),
      volumeLamports: s.volume,
      feeLamports: s.fee,
      buys: s.buys,
      traders: s.perTrader.size,
      callouts: [...s.callouts].sort(),
    }))
    .sort((a, b) => (a.caller < b.caller ? -1 : 1));
  return { callers, dropped };
}

/** Step 3: the budget split by counted volume (floor), capped per caller, small payouts dropped. Sum <= budget. */
export function allocateCallers(callers: CallerStats[], budget: bigint, rules: CallerRules): { caller: string; amount: bigint }[] {
  const total = callers.reduce((s, c) => s + c.countedLamports, 0n);
  if (total === 0n || budget === 0n) return [];
  const cap = (budget * rules.maxCallerShareBps) / 10_000n;
  return callers
    .map((c) => {
      const share = (budget * c.countedLamports) / total;
      return { caller: c.caller, amount: share < cap ? share : cap };
    })
    .filter((x) => x.amount > 0n && x.amount >= rules.minPayoutLamports)
    .sort((a, b) => (a.amount === b.amount ? (a.caller < b.caller ? -1 : 1) : a.amount > b.amount ? -1 : 1));
}

export interface CallerArtifact {
  epoch: number;
  kind: "caller";
  root: string;
  totalLamports: string;
  numLeaves: number;
  snapshotSlot: number;
  window: { since: number; until: number };
  rules: Record<keyof CallerRules, string>;
  dropped: Record<DropReason, number>;
  createdAt: string;
  funder: string;
  publishSignature?: string;
  leaves: { index: number; claimant: string; amount: string; proof: string[]; countedLamports: string; buys: number; traders: number; callouts: string[] }[];
}

/** Step 4: the tree and the artifact (every proof checked). */
export function buildCallerArtifact(
  epoch: number,
  payouts: { caller: string; amount: bigint }[],
  stats: Map<string, CallerStats>,
  meta: { snapshotSlot: number; window: { since: number; until: number }; rules: CallerRules; dropped: Record<DropReason, number>; funder: PublicKey; now?: Date },
): { artifact: CallerArtifact; root: Buffer; total: bigint } {
  if (payouts.length === 0 || payouts.length > MAX_REWARD_LEAVES) throw new Error(`a caller epoch needs 1..${MAX_REWARD_LEAVES} payouts`);
  const entries: RewardEntry[] = payouts.map((p) => ({ claimant: new PublicKey(p.caller), amount: p.amount }));
  const built = buildEpoch(entries);
  const leaves = entries.map((e, i) => {
    const proof = built.tree.proof(i);
    if (!verify(proof, built.root, leafHash(i, e.claimant, e.amount))) throw new Error(`proof ${i} does not verify`);
    const s = stats.get(e.claimant.toBase58())!;
    return { index: i, claimant: e.claimant.toBase58(), amount: e.amount.toString(), proof: proof.map((p) => p.toString("hex")), countedLamports: s.countedLamports.toString(), buys: s.buys, traders: s.traders, callouts: s.callouts };
  });
  const rules = Object.fromEntries(Object.entries(meta.rules).map(([k, v]) => [k, (v as bigint).toString()])) as Record<keyof CallerRules, string>;
  return {
    artifact: {
      epoch,
      kind: "caller",
      root: built.root.toString("hex"),
      totalLamports: built.total.toString(),
      numLeaves: built.numLeaves,
      snapshotSlot: meta.snapshotSlot,
      window: meta.window,
      rules,
      dropped: meta.dropped,
      createdAt: (meta.now ?? new Date()).toISOString(),
      funder: meta.funder.toBase58(),
      leaves,
    },
    root: built.root,
    total: built.total,
  };
}

/** Step 5: the one transaction, top-up first so publish's funding check sees it. */
export async function publishInstructions(
  program: ParabullProgram,
  pdas: Pdas,
  a: { funder: PublicKey; crank: PublicKey; epoch: number; root: Buffer; total: bigint; numLeaves: number; snapshotSlot: number },
): Promise<TransactionInstruction[]> {
  const vault = pdas.holderVault();
  const publish = await program.methods
    .publishRewardEpoch([...a.root], bn(a.total), a.numLeaves, bn(a.snapshotSlot))
    .accountsStrict({ crank: a.crank, global: pdas.global(), holderVault: vault, rewardEpoch: pdas.rewardEpoch(a.epoch), systemProgram: SystemProgram.programId })
    .instruction();
  return [SystemProgram.transfer({ fromPubkey: a.funder, toPubkey: vault, lamports: a.total }), publish];
}

/** "2026-11-01", "2026-11-01T12:00:00Z" or unix seconds -> unix seconds. */
export function parseTime(v: string): number {
  if (/^\d{9,11}$/.test(v)) return Number(v);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(ms)) throw new Error(`not a date or unix time: ${v}`);
  return Math.floor(ms / 1000);
}

export interface CallerEpochOptions {
  since: number;
  until: number;
  budgetLamports: bigint;
  publish: boolean;
  indexerUrl: string;
  edgeUrl: string;
  /** Sent as Origin: the edge Worker only answers its allowed origins (the app's). */
  calloutsOrigin: string;
  rules?: CallerRules;
  outDir?: string;
  fetchImpl?: typeof fetch;
  log?: (...a: unknown[]) => void;
}

async function getJson<T>(fetchImpl: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetchImpl(url, { headers: { accept: "application/json", ...headers } });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(`${url}: ${body?.error ?? res.status}`);
  return body;
}

/** Steps 1-2 against the services: every referred buy in the window, and the callouts they name. */
export async function loadReferrals(o: Pick<CallerEpochOptions, "since" | "until" | "indexerUrl" | "edgeUrl" | "calloutsOrigin" | "fetchImpl">) {
  const fetchImpl = o.fetchImpl ?? fetch;
  const events: ReferralEvent[] = [];
  let cursor: string | null = "0";
  let coveredFrom: number | null = null;
  while (cursor !== null) {
    const page: { events: ReferralEvent[]; next: string | null; coveredFrom: number | null } = await getJson(fetchImpl, `${o.indexerUrl}/referrals?since=${o.since}&until=${o.until}&limit=5000&cursor=${cursor}`);
    events.push(...page.events);
    coveredFrom = page.coveredFrom;
    cursor = page.next;
  }
  if (coveredFrom !== null && coveredFrom > o.since) {
    throw new Error(`the indexer's referral record starts at ${new Date(coveredFrom * 1000).toISOString()}, after the window's start: raise its BACKFILL_LIMIT, or start the window later`);
  }
  const ids = [...new Set(events.map((e) => e.calloutId))].filter(isCalloutId);
  const callouts = new Map<string, CalloutJson>();
  for (const batch of chunk(ids, 100)) {
    const page: { callouts: CalloutJson[] } = await getJson(fetchImpl, `${o.edgeUrl}/callouts?ids=${batch.join(",")}&limit=100`, { origin: o.calloutsOrigin });
    for (const c of page.callouts) callouts.set(c.id, c);
  }
  return { events, callouts };
}

async function eligible(connection: Connection, wallets: string[]): Promise<Set<string>> {
  const ok = new Set<string>();
  for (const batch of chunk(wallets, 100)) {
    const keys = batch.map((w) => new PublicKey(w));
    const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
    keys.forEach((k, i) => {
      const info: OwnerInfo = { account: infos[i], onCurve: PublicKey.isOnCurve(k.toBytes()) };
      if (isEligibleOwner(k, info, new Set())) ok.add(k.toBase58());
    });
  }
  return ok;
}

export async function runCallerEpoch(o: CallerEpochOptions) {
  const log = o.log ?? console.log;
  const rules = o.rules ?? DEFAULT_RULES;
  if (o.until <= o.since) throw new Error("--until must be after --since");
  if (o.budgetLamports <= 0n) throw new Error("CALLER_EPOCH_LAMPORTS must be positive");
  const { crank, admin } = roles();
  const { connection, program, pdas } = connect(crank);
  const g = await program.account.global.fetch(pdas.global());
  if (!g.crankAuthority.equals(crank.publicKey)) throw new Error(`CRANK_KEYPAIR is ${crank.publicKey.toBase58()}, but Global.crank_authority is ${g.crankAuthority.toBase58()}`);
  // The money comes from the treasury: its key signs the top-up.
  const funder: Keypair = process.env.TREASURY_KEYPAIR ? loadKeypair(process.env.TREASURY_KEYPAIR) : admin;
  if (!funder.publicKey.equals(g.treasury)) throw new Error(`the funding key (${funder.publicKey.toBase58()}) isn't Global.treasury (${g.treasury.toBase58()}): set TREASURY_KEYPAIR`);

  const { events, callouts } = await loadReferrals(o);
  const { callers, dropped } = attribute(events, callouts, rules);
  const payable = await eligible(connection, callers.map((c) => c.caller));
  const stats = new Map(callers.map((c) => [c.caller, c]));
  const payouts = allocateCallers(callers.filter((c) => payable.has(c.caller)), o.budgetLamports, rules);
  log(`window ${new Date(o.since * 1000).toISOString()} .. ${new Date(o.until * 1000).toISOString()}: ${events.length} referred buys, ${callers.length} callers, ${payouts.length} payouts; dropped ${JSON.stringify(dropped)}`);
  if (!payouts.length) {
    log("nothing to pay");
    return null;
  }
  const vault = await program.account.holderRewardVault.fetch(pdas.holderVault());
  const epoch = Number(vault.nextEpoch);
  const snapshotSlot = await connection.getSlot("confirmed");
  const { artifact, root, total } = buildCallerArtifact(epoch, payouts, stats, { snapshotSlot, window: { since: o.since, until: o.until }, rules, dropped, funder: funder.publicKey });
  const outDir = o.outDir ?? resolve(__dirname, "../snapshots");
  mkdirSync(outDir, { recursive: true });
  const draft = resolve(outDir, `epoch-${epoch}.draft.json`);
  writeFileSync(draft, JSON.stringify(artifact));
  log(`caller epoch ${epoch}: ${artifact.numLeaves} callers, ${total} lamports (budget ${o.budgetLamports}), root ${artifact.root} -> ${draft}`);
  if (!o.publish) return draft;

  const balance = BigInt(await connection.getBalance(funder.publicKey, "confirmed"));
  if (balance < total + 10_000_000n) throw new Error(`the treasury has ${balance} lamports; the epoch needs ${total} plus fees`);
  const ixs = await publishInstructions(program, pdas, { funder: funder.publicKey, crank: crank.publicKey, epoch, root, total, numLeaves: artifact.numLeaves, snapshotSlot });
  const signers = [crank, funder].filter((k, i, a) => a.findIndex((x) => x.publicKey.equals(k.publicKey)) === i);
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
  const onChain = await program.account.rewardEpoch.fetch(pdas.rewardEpoch(epoch));
  if (!Buffer.from(onChain.merkleRoot).equals(root) || big(onChain.totalLamports) !== total) throw new Error(`epoch ${epoch}: on-chain root/total mismatch`);
  artifact.publishSignature = sig;
  const final = resolve(outDir, `epoch-${epoch}.json`);
  writeFileSync(draft, JSON.stringify(artifact));
  renameSync(draft, final);
  log(`published caller epoch ${epoch}: ${sig}. Upload ${final} to REWARDS_BASE_URL.`);
  return final;
}

if (require.main === module) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new Error(`${what} is required`);
    return v.replace(/\/+$/, "");
  };
  Promise.resolve()
    .then(() =>
      runCallerEpoch({
        since: parseTime(need(arg("--since"), "--since")),
        until: parseTime(need(arg("--until"), "--until")),
        budgetLamports: BigInt(need(process.env.CALLER_EPOCH_LAMPORTS, "CALLER_EPOCH_LAMPORTS")),
        publish: process.argv.includes("--publish"),
        indexerUrl: need(process.env.INDEXER_URL, "INDEXER_URL"),
        edgeUrl: need(process.env.EDGE_URL, "EDGE_URL"),
        calloutsOrigin: need(process.env.CALLOUTS_ORIGIN, "CALLOUTS_ORIGIN (the app's origin, one of the Worker's ALLOWED_ORIGINS)"),
        rules: {
          minBuyLamports: BigInt(process.env.MIN_REFERRED_BUY_LAMPORTS ?? DEFAULT_RULES.minBuyLamports),
          perTraderCapLamports: BigInt(process.env.PER_TRADER_CAP_LAMPORTS ?? DEFAULT_RULES.perTraderCapLamports),
          maxCallerShareBps: BigInt(process.env.MAX_CALLER_SHARE_BPS ?? DEFAULT_RULES.maxCallerShareBps),
          minPayoutLamports: BigInt(process.env.MIN_PAYOUT_LAMPORTS ?? DEFAULT_RULES.minPayoutLamports),
        },
      }),
    )
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

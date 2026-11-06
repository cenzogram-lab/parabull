/**
 * Pure logic behind the admin console (pages/AdminConsole.tsx): KPI totals across bonding curves, vault figures, and
 * validation of parameter changes and admin nominations against the program's own rules (`GlobalParams::validate` in
 * programs/parabull/src/state.rs). The program enforces every rule again on-chain; these checks only stop a doomed
 * transaction before the wallet is asked to sign it. Only the lazily loaded console imports this module.
 */
import { PublicKey } from "@solana/web3.js";
import { BPS, bpsLabel, type GlobalView } from "./protocolParams";

/** Raydium's pool-creation fee on mainnet AmmConfig 0; the migration reserve also pays account rent. */
export const RAYDIUM_POOL_FEE_LAMPORTS = 150_000_000n;

/** `MIN_REWARD_CLAIM_WINDOW_SECONDS` in constants.rs. */
export const MIN_CLAIM_WINDOW_SECONDS = 7 * 86_400;

// ---- KPIs -----------------------------------------------------------------------------------------------------------

export interface CurveView {
  complete: boolean;
  migrated: boolean;
  escrowReleased: boolean;
  realSolReserves: bigint;
  escrowAccrued: bigint;
  buybackAccrued: bigint;
  holderAccrued: bigint;
  treasuryAccrued: bigint;
}

export interface CurveKpis {
  curves: number;
  /** Still trading on the curve. */
  active: number;
  /** Curve complete, migration to Raydium not finished. */
  graduating: number;
  /** Pool created and LP locked. */
  graduated: number;
  /** SOL held for curves (trading reserves, plus a completed curve's raise until `prepare_migration` moves it). */
  solInCurves: bigint;
  unswept: { escrow: bigint; buyback: bigint; holder: bigint; treasury: bigint; total: bigint };
  escrowsReleased: number;
}

export function curveKpis(curves: readonly CurveView[]): CurveKpis {
  const k: CurveKpis = { curves: curves.length, active: 0, graduating: 0, graduated: 0, solInCurves: 0n, unswept: { escrow: 0n, buyback: 0n, holder: 0n, treasury: 0n, total: 0n }, escrowsReleased: 0 };
  for (const c of curves) {
    if (c.migrated) k.graduated++;
    else if (c.complete) k.graduating++;
    else k.active++;
    k.solInCurves += c.realSolReserves;
    if (!c.escrowReleased) k.unswept.escrow += c.escrowAccrued;
    else k.escrowsReleased++;
    k.unswept.buyback += c.buybackAccrued;
    k.unswept.holder += c.holderAccrued;
    k.unswept.treasury += c.treasuryAccrued;
  }
  k.unswept.total = k.unswept.escrow + k.unswept.buyback + k.unswept.holder + k.unswept.treasury;
  return k;
}

export interface HolderVaultView {
  totalDepositedLamports: bigint;
  totalCommittedLamports: bigint;
  totalClaimedLamports: bigint;
  totalExpiredLamports: bigint;
  nextEpoch: bigint;
}

/** Lamports published epochs still owe holders: committed, less what was claimed and what expired unclaimed. */
export const owedToEpochs = (v: HolderVaultView) => {
  const owed = v.totalCommittedLamports - v.totalClaimedLamports - v.totalExpiredLamports;
  return owed > 0n ? owed : 0n;
};

/** A vault's spendable SOL: its balance above the rent-exempt minimum (`vault_spendable` in state.rs). */
export const spendable = (lamports: bigint, rentMinimum: bigint) => (lamports > rentMinimum ? lamports - rentMinimum : 0n);

// ---- Parameter changes ----------------------------------------------------------------------------------------------

/** The editable numeric parameters, as the form holds them (strings straight from the inputs). */
export interface ParamsForm {
  buybackPct: string;
  holderPct: string;
  dexTargetSol: string;
  tradingOpenDelaySlots: string;
  migrationReserveSol: string;
  claimWindowDays: string;
}

export const formFromGlobal = (g: GlobalView): ParamsForm => ({
  buybackPct: String(g.buybackBps / 100),
  holderPct: String(g.holderBps / 100),
  dexTargetSol: lamportsToSolInput(g.dexTargetLamports),
  tradingOpenDelaySlots: g.tradingOpenDelaySlots.toString(),
  migrationReserveSol: lamportsToSolInput(g.migrationReserveLamports),
  claimWindowDays: String(Number((g.rewardClaimWindowSeconds / 86_400).toFixed(4))),
});

/** Lamports as the shortest exact SOL string ("0.25", "1.999", "2"). */
export function lamportsToSolInput(l: bigint): string {
  const whole = l / 1_000_000_000n;
  const frac = (l % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Exact SOL string to lamports; null unless it's a plain non-negative decimal with at most 9 places. */
export function solInputToLamports(s: string): bigint | null {
  const m = /^\s*(\d+)(?:\.(\d{0,9}))?\s*$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000_000n + BigInt((m[2] ?? "").padEnd(9, "0") || "0");
}

/** Percentage string to basis points; null unless it's 0–100 with at most 2 decimals. */
export function pctInputToBps(s: string): number | null {
  const m = /^\s*(\d{1,3})(?:\.(\d{0,2}))?\s*$/.exec(s);
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return bps <= BPS ? bps : null;
}

/** Mirrors the program's `GlobalUpdate`: only the fields that change are set. */
export interface GlobalUpdateDraft {
  dexTargetLamports?: bigint;
  buybackBps?: number;
  holderBps?: number;
  migrationReserveLamports?: bigint;
  tradingOpenDelaySlots?: bigint;
  rewardClaimWindowSeconds?: bigint;
}

export interface ParamChange {
  label: string;
  from: string;
  to: string;
}

export type ParamsCheck =
  | { ok: true; update: GlobalUpdateDraft; changes: ParamChange[]; warnings: string[] }
  | { ok: false; errors: Partial<Record<keyof ParamsForm | "split", string>> };

const fmtSol = (l: bigint) => `${lamportsToSolInput(l)} SOL`;
const fmtDays = (s: number) => `${Number((s / 86_400).toFixed(4))} days`;

/**
 * Validate the form against `GlobalParams::validate` and the console's own floor (trading opens at least a slot after
 * creation, so the block-zero protection can't be switched off from here), and list what would change.
 */
export function checkParams(g: GlobalView, f: ParamsForm): ParamsCheck {
  const errors: Partial<Record<keyof ParamsForm | "split", string>> = {};
  const buyback = pctInputToBps(f.buybackPct);
  const holder = pctInputToBps(f.holderPct);
  if (buyback === null) errors.buybackPct = "A percentage from 0 to 100, at most 2 decimals";
  if (holder === null) errors.holderPct = "A percentage from 0 to 100, at most 2 decimals";
  if (buyback !== null && holder !== null && buyback + holder > BPS) errors.split = "Buyback and holder shares can't add up to more than 100%";

  const dex = solInputToLamports(f.dexTargetSol);
  if (dex === null) errors.dexTargetSol = "An amount in SOL, at most 9 decimals";
  else if (dex === 0n) errors.dexTargetSol = "Must be above 0";

  const delay = /^\s*\d+\s*$/.test(f.tradingOpenDelaySlots) ? BigInt(f.tradingOpenDelaySlots.trim()) : null;
  if (delay === null) errors.tradingOpenDelaySlots = "A whole number of slots";
  else if (delay < 1n) errors.tradingOpenDelaySlots = "At least 1: trading in the creation slot is what the delay prevents";
  else if (delay > 150n) errors.tradingOpenDelaySlots = "At most 150 slots (about a minute)";

  const reserve = solInputToLamports(f.migrationReserveSol);
  if (reserve === null) errors.migrationReserveSol = "An amount in SOL, at most 9 decimals";
  else if (reserve === 0n) errors.migrationReserveSol = "Must be above 0";

  const daysM = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(f.claimWindowDays);
  const windowSeconds = daysM ? Math.round(Number(f.claimWindowDays) * 86_400) : null;
  if (windowSeconds === null) errors.claimWindowDays = "A number of days";
  else if (windowSeconds < MIN_CLAIM_WINDOW_SECONDS) errors.claimWindowDays = "At least 7 days, the program's minimum";
  else if (windowSeconds > 365 * 86_400) errors.claimWindowDays = "At most 365 days";

  if (Object.keys(errors).length) return { ok: false, errors };

  const update: GlobalUpdateDraft = {};
  const changes: ParamChange[] = [];
  const warnings: string[] = [];
  if (buyback! !== g.buybackBps) (update.buybackBps = buyback!), changes.push({ label: "Buyback share", from: bpsLabel(g.buybackBps), to: bpsLabel(buyback!) });
  if (holder! !== g.holderBps) (update.holderBps = holder!), changes.push({ label: "Holder share", from: bpsLabel(g.holderBps), to: bpsLabel(holder!) });
  if (update.buybackBps !== undefined || update.holderBps !== undefined) {
    changes.push({ label: "Treasury share (the rest)", from: bpsLabel(BPS - g.buybackBps - g.holderBps), to: bpsLabel(BPS - buyback! - holder!) });
  }
  if (dex! !== g.dexTargetLamports) (update.dexTargetLamports = dex!), changes.push({ label: "DexScreener listing target", from: fmtSol(g.dexTargetLamports), to: fmtSol(dex!) });
  if (delay! !== g.tradingOpenDelaySlots) (update.tradingOpenDelaySlots = delay!), changes.push({ label: "Trading opens after", from: `${g.tradingOpenDelaySlots} slots`, to: `${delay} slots` });
  if (reserve! !== g.migrationReserveLamports) {
    update.migrationReserveLamports = reserve!;
    changes.push({ label: "Migration reserve", from: fmtSol(g.migrationReserveLamports), to: fmtSol(reserve!) });
    if (reserve! <= RAYDIUM_POOL_FEE_LAMPORTS) warnings.push("The migration reserve must cover Raydium's 0.15 SOL pool fee plus rent, or graduations will fail.");
  }
  if (windowSeconds! !== g.rewardClaimWindowSeconds) {
    update.rewardClaimWindowSeconds = BigInt(windowSeconds!);
    changes.push({ label: "Reward claim window", from: fmtDays(g.rewardClaimWindowSeconds), to: fmtDays(windowSeconds!) });
    warnings.push("A new claim window applies to epochs published from now on; published epochs keep theirs.");
  }
  return { ok: true, update, changes, warnings };
}

// ---- Admin transfer -------------------------------------------------------------------------------------------------

export type NomineeCheck = { ok: true; key: PublicKey; warning: string | null } | { ok: false; error: string };

/** Validate a proposed new admin before `propose_admin`. */
export function checkNominee(g: GlobalView, input: string): NomineeCheck {
  const s = input.trim();
  if (!s) return { ok: false, error: "Paste the new admin's address" };
  let key: PublicKey;
  try {
    key = new PublicKey(s);
  } catch {
    return { ok: false, error: "Not a valid Solana address" };
  }
  if (key.toBase58() !== s) return { ok: false, error: "Not a valid Solana address" };
  if (key.equals(PublicKey.default)) return { ok: false, error: "That's the empty address; use Cancel to withdraw a nomination" };
  if (s === g.admin) return { ok: false, error: "That wallet is already the admin" };
  if (s === g.pendingAdmin) return { ok: false, error: "That wallet is already nominated" };
  const warning = PublicKey.isOnCurve(key.toBytes())
    ? null
    : "This address is off the ed25519 curve, so no private key can sign for it. Only a program (such as a multisig vault) can accept. Make sure that's intended.";
  return { ok: true, key, warning };
}

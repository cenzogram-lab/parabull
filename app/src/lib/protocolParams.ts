/**
 * Protocol parameters as the app reads them (from `Global` in chain mode, the program defaults in demo mode), their
 * labels, and who the program's roles are. Small and shared by every page; the admin console's own logic (KPIs,
 * parameter validation) is in lib/admin.ts, which only the lazily loaded console imports.
 */
import { PublicKey } from "@solana/web3.js";
import { PROTOCOL } from "./protocol";

export const BPS = 10_000;

/** "1%", "50%", "0.25%": basis points as a short percentage. */
export const bpsLabel = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

type Num = { toString(): string };
type Key = { toBase58(): string };

/** The `Global` fields the app uses, as plain values. */
export interface GlobalView {
  paused: boolean;
  admin: string;
  pendingAdmin: string;
  launchAuthority: string;
  crankAuthority: string;
  treasury: string;
  parabullMint: string;
  parabullPool: string;
  launchFeeLamports: bigint;
  ticketDepositLamports: bigint;
  ticketTtlSeconds: number;
  platformFeeBps: number;
  buybackBps: number;
  holderBps: number;
  dexTargetLamports: bigint;
  dexTargetUpdatedAt: number;
  tradingOpenDelaySlots: bigint;
  registryLockSeconds: number;
  launchCount: bigint;
  migrationReserveLamports: bigint;
  rewardClaimWindowSeconds: number;
}

/** The decoded Anchor account (BN and PublicKey fields) as a `GlobalView`. */
export function globalView(g: {
  paused: boolean;
  admin: Key;
  pendingAdmin: Key;
  launchAuthority: Key;
  crankAuthority: Key;
  treasury: Key;
  parabullMint: Key;
  parabullPool: Key;
  launchFeeLamports: Num;
  ticketDepositLamports: Num;
  ticketTtlSeconds: Num;
  platformFeeBps: number;
  buybackBps: number;
  holderBps: number;
  dexTargetLamports: Num;
  dexTargetUpdatedAt: Num;
  tradingOpenDelaySlots: Num;
  registryLockSeconds: Num;
  launchCount: Num;
  migrationReserveLamports: Num;
  rewardClaimWindowSeconds: Num;
}): GlobalView {
  const big = (v: Num) => BigInt(v.toString());
  const num = (v: Num) => Number(v.toString());
  return {
    paused: g.paused,
    admin: g.admin.toBase58(),
    pendingAdmin: g.pendingAdmin.toBase58(),
    launchAuthority: g.launchAuthority.toBase58(),
    crankAuthority: g.crankAuthority.toBase58(),
    treasury: g.treasury.toBase58(),
    parabullMint: g.parabullMint.toBase58(),
    parabullPool: g.parabullPool.toBase58(),
    launchFeeLamports: big(g.launchFeeLamports),
    ticketDepositLamports: big(g.ticketDepositLamports),
    ticketTtlSeconds: num(g.ticketTtlSeconds),
    platformFeeBps: g.platformFeeBps,
    buybackBps: g.buybackBps,
    holderBps: g.holderBps,
    dexTargetLamports: big(g.dexTargetLamports),
    dexTargetUpdatedAt: num(g.dexTargetUpdatedAt),
    tradingOpenDelaySlots: big(g.tradingOpenDelaySlots),
    registryLockSeconds: num(g.registryLockSeconds),
    launchCount: big(g.launchCount),
    migrationReserveLamports: big(g.migrationReserveLamports),
    rewardClaimWindowSeconds: num(g.rewardClaimWindowSeconds),
  };
}

/** Protocol parameters the rest of the app reads: from `Global` in chain mode, the program defaults in demo mode. */
export interface ProtocolParams {
  platformFeeBps: number;
  buybackBps: number;
  holderBps: number;
  /** Null in demo mode, where the listing fund is the flat $299 target. */
  dexTargetLamports: bigint | null;
  launchFeeLamports: bigint;
  ticketDepositLamports: bigint;
  registryLockSeconds: number;
  tradingOpenDelaySlots: number;
  rewardClaimWindowSeconds: number;
}

/** `DEFAULT_REWARD_CLAIM_WINDOW_SECONDS` in constants.rs. */
export const DEFAULT_CLAIM_WINDOW_SECONDS = 30 * 86_400;

export const DEFAULT_PARAMS: ProtocolParams = {
  platformFeeBps: Number(PROTOCOL.platformFeeBps),
  buybackBps: PROTOCOL.buybackBps,
  holderBps: PROTOCOL.holderBps,
  dexTargetLamports: null,
  launchFeeLamports: PROTOCOL.launchFeeLamports,
  ticketDepositLamports: PROTOCOL.ticketDepositLamports,
  registryLockSeconds: PROTOCOL.registryLockSeconds,
  tradingOpenDelaySlots: PROTOCOL.tradingOpenDelaySlots,
  rewardClaimWindowSeconds: DEFAULT_CLAIM_WINDOW_SECONDS,
};

export const paramsFromGlobal = (g: GlobalView): ProtocolParams => ({
  platformFeeBps: g.platformFeeBps,
  buybackBps: g.buybackBps,
  holderBps: g.holderBps,
  dexTargetLamports: g.dexTargetLamports,
  launchFeeLamports: g.launchFeeLamports,
  ticketDepositLamports: g.ticketDepositLamports,
  registryLockSeconds: g.registryLockSeconds,
  tradingOpenDelaySlots: Number(g.tradingOpenDelaySlots),
  rewardClaimWindowSeconds: g.rewardClaimWindowSeconds,
});

/** "50 / 40 / 10": the post-escrow split as buyback / holders / treasury percentages. */
export const splitLabel = (p: Pick<ProtocolParams, "buybackBps" | "holderBps">) =>
  [p.buybackBps, p.holderBps, BPS - p.buybackBps - p.holderBps].map((b) => Number((b / 100).toFixed(2))).join(" / ");

/** "30 days", "1.5 hours", "10 minutes": whole days when it is some, else hours, else minutes under an hour. */
export function durationLabel(seconds: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (seconds % 86_400 === 0) return plural(seconds / 86_400, "day");
  if (seconds >= 3_600) return plural(Number((seconds / 3_600).toFixed(1)), "hour");
  return plural(Number((seconds / 60).toFixed(1)), "minute");
}

/** The listing-fund target in USD: the on-chain lamport target at today's price, or the flat demo target. */
export const dexTargetUsd = (p: ProtocolParams, solUsd: number) => (p.dexTargetLamports === null ? PROTOCOL.dexListingUsd : (Number(p.dexTargetLamports) / 1e9) * solUsd);

/** Lamports for a USD target at `solUsd`, rounded to the lamport. */
export const usdToLamports = (usd: number, solUsd: number) => BigInt(Math.round((usd / solUsd) * 1e9));

// ---- Access ---------------------------------------------------------------------------------------------------------

export interface Roles {
  admin: boolean;
  pendingAdmin: boolean;
  crank: boolean;
}

const DEFAULT_KEY = PublicKey.default.toBase58();

/** What `wallet` is to the program. A wallet can hold several roles (say, admin and crank). */
export function rolesOf(g: GlobalView, wallet: string | null): Roles {
  if (!wallet) return { admin: false, pendingAdmin: false, crank: false };
  return {
    admin: wallet === g.admin,
    pendingAdmin: g.pendingAdmin !== DEFAULT_KEY && wallet === g.pendingAdmin,
    crank: wallet === g.crankAuthority,
  };
}

/** The console opens for the admin, the crank authority and a nominated admin (who needs it to accept). */
export const mayOpenConsole = (r: Roles) => r.admin || r.pendingAdmin || r.crank;

export const hasPendingAdmin = (g: GlobalView) => g.pendingAdmin !== DEFAULT_KEY;

/**
 * Bonding-curve milestones. Progress is SOL raised over the SOL the curve raises when its last token is bought,
 * the same figure the app shows ("96.2% to Raydium"). Graduation is the Raydium migration (`migrated`).
 */
import type { SentinelMilestone } from "../../../app/src/lib/sentinelMessage";
import { buyCost, type Reserves } from "../../../scripts/src/curve";

export interface CurveView {
  realSol: bigint;
  complete: boolean;
  migrated: boolean;
}

export const THRESHOLDS: readonly [Exclude<SentinelMilestone, "graduation">, number][] = [
  ["p25", 0.25],
  ["p50", 0.5],
  ["p75", 0.75],
];

/** SOL (lamports) raised when the last curve token is bought, from the program's initial reserves. */
export function graduationRaise(initial: Pick<Reserves, "virtualToken" | "virtualSol" | "realToken">): bigint {
  return buyCost({ ...initial, realSol: 0n }, initial.realToken);
}

/** 0..1. A complete curve counts as 1. */
export function progress(view: CurveView, raise: bigint): number {
  if (view.complete || view.migrated) return 1;
  if (raise <= 0n) return 0;
  return Math.min(1, Number(view.realSol) / Number(raise));
}

/** Every milestone the curve has reached, in order. */
export function reached(view: CurveView, raise: bigint): SentinelMilestone[] {
  const p = progress(view, raise);
  const out: SentinelMilestone[] = THRESHOLDS.filter(([, t]) => p >= t).map(([k]) => k);
  if (view.migrated) out.push("graduation");
  return out;
}

/**
 * What to do with milestones reached since the last look. `done` holds every milestone already handled. Enabled ones
 * are posted; disabled ones are marked done without posting, so switching a milestone on later never posts a stale
 * one. When several land at once (a big buy), only the highest is posted, so the account doesn't post three in a row.
 */
export function due(view: CurveView, raise: bigint, done: ReadonlySet<SentinelMilestone>, enabled: Record<SentinelMilestone, boolean>): { post: SentinelMilestone | null; markDone: SentinelMilestone[] } {
  const fresh = reached(view, raise).filter((m) => !done.has(m));
  const postable = fresh.filter((m) => enabled[m]);
  return { post: postable.length ? postable[postable.length - 1] : null, markDone: fresh };
}

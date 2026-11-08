/**
 * The launch form's ticker / name / tweet lock check against the on-chain registries (create.rs `registry_claimable`),
 * judged at the cluster's time (the Clock sysvar), never the browser's. It fails closed: a registry that can't be read
 * in time is "unknown", and the form won't take the ticket until every lock reads "free".
 */
import { type Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

export type LockState = "free" | "locked" | "unknown";

export interface RegistryLike {
  mint: PublicKey;
  launchTimestamp: { toNumber(): number };
}

/** Clock sysvar: slot, epoch_start_timestamp, epoch, leader_schedule_epoch, then unix_timestamp (i64 LE) at byte 32. */
export function clockUnixTimestamp(data: Uint8Array): number {
  if (data.length < 40) throw new Error("Clock sysvar too short");
  return Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(32, true));
}

/** The cluster's unix time in seconds, from the Clock sysvar. */
export async function clusterUnixTime(connection: Pick<Connection, "getAccountInfo">): Promise<number> {
  const a = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  if (!a) throw new Error("Clock sysvar not found");
  return clockUnixTimestamp(a.data);
}

/** What `create` will decide for one registry at cluster time `now` (seconds): held until `launch_timestamp + lock`. */
export function registryLock(r: RegistryLike | null, now: number, lockSeconds: number): Exclude<LockState, "unknown"> {
  if (!r || r.mint.equals(PublicKey.default)) return "free";
  return now < r.launchTimestamp.toNumber() + lockSeconds ? "locked" : "free";
}

/** Rejects after `ms` (an RPC that hangs counts as unreadable). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export interface LockReaders {
  /** Cluster unix time, seconds. */
  now(): Promise<number>;
  ticker: (() => Promise<RegistryLike | null>) | null;
  name: (() => Promise<RegistryLike | null>) | null;
  tweet: (() => Promise<RegistryLike | null>) | null;
}

export interface LockStates {
  ticker: LockState;
  name: LockState;
  tweet: LockState;
}

/**
 * Every lock in one pass. A field without a reader (no valid ticker yet, no tweet) is "free". If the clock or a
 * registry read fails or takes longer than `timeoutMs`, that lock is "unknown" (the clock failing makes them all so).
 */
export async function checkLocks(r: LockReaders, lockSeconds: number, timeoutMs = 6_000): Promise<LockStates> {
  const read = async (f: LockReaders["ticker"]): Promise<{ ok: true; v: RegistryLike | null } | { ok: false }> => {
    if (!f) return { ok: true, v: null };
    try {
      return { ok: true, v: await withTimeout(f(), timeoutMs) };
    } catch {
      return { ok: false };
    }
  };
  const [now, ticker, name, tweet] = await Promise.all([withTimeout(r.now(), timeoutMs).catch(() => null), read(r.ticker), read(r.name), read(r.tweet)]);
  const state = (x: Awaited<ReturnType<typeof read>>): LockState => (now === null || !x.ok ? "unknown" : registryLock(x.v, now, lockSeconds));
  return { ticker: r.ticker ? state(ticker) : "free", name: r.name ? state(name) : "free", tweet: r.tweet ? state(tweet) : "free" };
}

/** Null when the ticket may be bought, otherwise why not. */
export function lockBlocker(s: LockStates, lockLabel: string): string | null {
  if (s.ticker === "locked") return `This ticker is locked for ${lockLabel}`;
  if (s.name === "locked") return `This name is locked for ${lockLabel}`;
  if (s.tweet === "locked") return `This tweet already backed a launch in the last ${lockLabel}`;
  if (s.ticker === "unknown" || s.name === "unknown" || s.tweet === "unknown") return "Couldn't check the ticker, name and tweet locks on-chain. Try again in a moment.";
  return null;
}

/**
 * Whose coin the ticker registry names after a ticket closed: ours only if the curve's creator (the ticket payer the
 * program recorded) is this wallet and it launched after our request. Otherwise the ticket was refunded, whatever coin
 * took the ticker (another payer's ticket for the same ticker can win the race).
 */
export function launchedBy(reg: { mint: PublicKey; launchTimestamp: { toNumber(): number } } | null, curveCreator: PublicKey | null, payer: PublicKey, requestedAt: number): PublicKey | null {
  if (!reg || reg.mint.equals(PublicKey.default) || reg.launchTimestamp.toNumber() < requestedAt - 5) return null;
  return curveCreator?.equals(payer) ? reg.mint : null;
}

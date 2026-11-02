/**
 * Claimable Burn & Earn LP fees for one locked position (fee-key NFT).
 *
 * Source: Raydium's lock-position endpoint, the one raydium-sdk-v2 uses in
 * `Api.fetchCpmmLockInfo` (`API_URLS.CPMM_LOCK`, queried with `?id=<NFT mint>`):
 *   mainnet https://dynamic-ipfs.raydium.io/lock/cpmm/position
 *   devnet  https://dynamic-ipfs-devnet.raydium.io/lock/cpmm/position
 * Response (`CpmmLockInfo`): `positionInfo.unclaimedFee.lp` (a JS number) and
 * `poolInfo.lpMint.decimals`.
 *
 * NOTE: the pool-info endpoint (`/pools/info/ids`) reports pool-level stats,
 * not what a specific lock can claim, so it is not used here.
 *
 * Unverified assumption: `unclaimedFee.lp` is in UI units (the SDK types it
 * as a float; CPMM LP mints have 9 decimals). The raw amount is floored and
 * reduced by a safety margin, and the crank also caps it by the on-chain
 * locked LP. Burn & Earn rejects an over-claim, so a wrong unit makes the
 * collection fail rather than over-pay.
 *
 * Never throws: any failure returns null so the crank keeps going.
 */
import { PublicKey } from "@solana/web3.js";
import { ClusterName } from "./config";

export const CPMM_LOCK_API: Record<Exclude<ClusterName, "localnet">, string> = {
  "mainnet-beta": "https://dynamic-ipfs.raydium.io/lock/cpmm/position",
  devnet: "https://dynamic-ipfs-devnet.raydium.io/lock/cpmm/position",
};

const LP_DECIMALS_FALLBACK = 9; // CPMM `initialize`: lp mint::decimals = 9

/** UI amount (number or numeric string) -> raw integer units, rounded down. */
export function uiToRaw(ui: number | string, decimals: number): bigint | null {
  const n = typeof ui === "string" ? Number(ui) : ui;
  if (!Number.isFinite(n) || n <= 0) return null;
  const fixed = n.toFixed(decimals); // exact decimal string, no exponent (n < 1e21)
  if (fixed.includes("e")) return null;
  const [int, frac = ""] = fixed.split(".");
  return BigInt(int + frac.padEnd(decimals, "0").slice(0, decimals));
}

/** Pure parser for a `CpmmLockInfo` response. Returns null when there is nothing to claim. */
export function parseLockPosition(json: unknown, safetyBps = 10n): bigint | null {
  const r = json as { positionInfo?: { unclaimedFee?: { lp?: number | string } }; poolInfo?: { lpMint?: { decimals?: number } } };
  const lp = r?.positionInfo?.unclaimedFee?.lp;
  if (lp === undefined || lp === null) return null;
  const decimals = r?.poolInfo?.lpMint?.decimals ?? LP_DECIMALS_FALLBACK;
  const raw = uiToRaw(lp, decimals);
  if (raw === null) return null;
  const safe = (raw * (10_000n - safetyBps)) / 10_000n;
  return safe > 0n ? safe : null;
}

export interface FetchOptions {
  cluster: ClusterName;
  timeoutMs?: number;
  safetyBps?: bigint;
  fetchImpl?: typeof fetch;
  /** Raw LP units; takes precedence over the API (devnet/local testing). */
  override?: string;
  log?: (msg: string) => void;
}

export async function fetchLpFeeAmount(feeNftMint: PublicKey, opts: FetchOptions): Promise<bigint | null> {
  const log = opts.log ?? (() => {});
  const override = opts.override ?? process.env.OVERRIDE_LP_FEE_AMOUNT;
  if (override !== undefined && override !== "") {
    if (!/^\d+$/.test(override)) {
      log(`ignoring OVERRIDE_LP_FEE_AMOUNT=${override}: not a raw integer`);
      return null;
    }
    const v = BigInt(override);
    return v > 0n ? v : null;
  }
  if (opts.cluster === "localnet") return null;

  const url = `${process.env.RAYDIUM_CPMM_LOCK_API ?? CPMM_LOCK_API[opts.cluster]}?id=${feeNftMint.toBase58()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) {
      log(`lock API ${res.status} for ${feeNftMint.toBase58()}${res.status === 429 ? " (rate limited)" : ""}`);
      return null;
    }
    return parseLockPosition(await res.json(), opts.safetyBps ?? 10n);
  } catch (e) {
    log(`lock API error for ${feeNftMint.toBase58()}: ${(e as Error)?.name === "AbortError" ? "timeout" : (e as Error)?.message ?? e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

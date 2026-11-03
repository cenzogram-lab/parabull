/** Pure helpers for test_launch_and_trade.ts (option parsing, buy-out quote, worker hand-off). */
import { PublicKey } from "@solana/web3.js";
import type { ClusterName } from "./config";
import { Reserves, applySlippage, quoteBuyExactTokens } from "./curve";

export interface SmokeOptions {
  /** false with --no-create: leave `create` to the launch worker. */
  create: boolean;
  /** GRADUATE=1: buy out the curve, then run the three graduation steps. */
  graduate: boolean;
  /** GRADUATE_MAX_SOL (default 5): refuse a buy-out costing more than this. */
  maxGraduateLamports: bigint;
}

export function smokeOptions(argv: string[], env: Record<string, string | undefined>, cluster: ClusterName): SmokeOptions {
  const graduate = env.GRADUATE === "1";
  if (graduate && cluster === "mainnet-beta") throw new Error("GRADUATE=1 buys out a whole curve; it's for devnet/localnet test curves and is refused on mainnet-beta");
  const maxSol = Number(env.GRADUATE_MAX_SOL ?? "5");
  if (!Number.isFinite(maxSol) || maxSol <= 0) throw new Error(`GRADUATE_MAX_SOL must be a positive number, got ${env.GRADUATE_MAX_SOL}`);
  return {
    create: !argv.includes("--no-create"),
    graduate,
    maxGraduateLamports: BigInt(Math.round(maxSol * 1e9)),
  };
}

/** The single buy that completes the curve: every remaining real token, with a slippage ceiling. */
export function graduationBuy(r: Reserves, feeBps: bigint, slippageBps: bigint, maxLamports: bigint) {
  if (r.realToken === 0n) throw new Error("curve already has no tokens left");
  const q = quoteBuyExactTokens(r, r.realToken, feeBps);
  const maxCost = applySlippage(q.total, slippageBps, true);
  if (maxCost > maxLamports) {
    throw new Error(
      `buying out this curve costs up to ${Number(maxCost) / 1e9} SOL, over GRADUATE_MAX_SOL (${Number(maxLamports) / 1e9}). ` +
        "Initialise Global with CURVE_PRESET=small for devnet, or raise GRADUATE_MAX_SOL.",
    );
  }
  return { tokens: r.realToken, total: q.total, maxCost };
}

/**
 * After the ticket closes under --no-create: the worker's mint if it launched
 * this ticket (the ticker registry was claimed at or after the request), or
 * null if the ticket was refunded instead.
 */
export function workerLaunchedMint(registry: { mint: PublicKey; launchTimestamp: bigint } | null, requestedAt: bigint): PublicKey | null {
  if (!registry || registry.mint.equals(PublicKey.default) || registry.launchTimestamp < requestedAt) return null;
  return registry.mint;
}

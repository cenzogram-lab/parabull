/**
 * Bonding-curve parameter sets for `initialize`.
 *
 * MAINNET_CURVE is the default shape (raises ~85.005 SOL, ~410.9 SOL market
 * cap at completion). `smallCurve` derives a test curve that graduates at a
 * chosen raise (e.g. ~2 SOL on devnet) while staying consistent with the
 * program's migration rules:
 *  - virtual SOL is solved so buying out the curve costs `targetRaise`;
 *  - total supply is solved so the pool, seeded with (raise - migration
 *    reserve) SOL and the tracked migration tokens, opens at the curve's
 *    final price. Without this, the fixed reserve would be a large share of
 *    a small raise and fail the on-chain 5% opening-price check.
 */
import { buyCost } from "./curve";

export interface CurveParams {
  initialVirtualTokenReserves: bigint;
  initialVirtualSolReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
}

export const MAINNET_CURVE: CurveParams = {
  initialVirtualTokenReserves: 1_073_000_000_000_000n,
  initialVirtualSolReserves: 30_000_000_000n,
  initialRealTokenReserves: 793_100_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function smallCurve(targetRaiseLamports: bigint, migrationReserveLamports: bigint, shape: CurveParams = MAINNET_CURVE): CurveParams {
  const vt0 = shape.initialVirtualTokenReserves;
  const rt0 = shape.initialRealTokenReserves;
  if (targetRaiseLamports <= migrationReserveLamports) throw new Error("target raise must exceed the migration reserve");
  // raise = floor(rt0 * vs0 / (vt0 - rt0)) + 1  =>  vs0 = ceil((raise - 1) * (vt0 - rt0) / rt0)
  const vs0 = ceilDiv((targetRaiseLamports - 1n) * (vt0 - rt0), rt0);
  const raise = buyCost({ virtualToken: vt0, virtualSol: vs0, realToken: rt0, realSol: 0n }, rt0);
  // Pool price (raise - reserve) / poolTokens == final curve price (vs0 + raise) / (vt0 - rt0).
  const poolTokens = ((raise - migrationReserveLamports) * (vt0 - rt0)) / (vs0 + raise);
  return { initialVirtualTokenReserves: vt0, initialVirtualSolReserves: vs0, initialRealTokenReserves: rt0, tokenTotalSupply: rt0 + poolTokens };
}

/** Same check as raydium.rs `pool_price_within` (opening price vs final curve price). */
export function poolPriceWithin(solToPool: bigint, tokens: bigint, virtualSol: bigint, virtualToken: bigint, maxDiscountBps: bigint): boolean {
  return solToPool * virtualToken * 10_000n >= (10_000n - maxDiscountBps) * virtualSol * tokens;
}

/** What graduation looks like for a parameter set (for logging and tests). */
export function graduationPreview(p: CurveParams, migrationReserveLamports: bigint) {
  const raise = buyCost({ virtualToken: p.initialVirtualTokenReserves, virtualSol: p.initialVirtualSolReserves, realToken: p.initialRealTokenReserves, realSol: 0n }, p.initialRealTokenReserves);
  const finalVt = p.initialVirtualTokenReserves - p.initialRealTokenReserves;
  const finalVs = p.initialVirtualSolReserves + raise;
  const poolTokens = p.tokenTotalSupply - p.initialRealTokenReserves;
  const solToPool = raise - migrationReserveLamports;
  return {
    raiseLamports: raise,
    marketCapLamports: (p.tokenTotalSupply * finalVs) / finalVt,
    solToPool,
    poolTokens,
    priceCheckPasses: solToPool > 0n && poolPriceWithin(solToPool, poolTokens, finalVs, finalVt, 500n),
  };
}

/** SOL the migration reserve must cover beyond Raydium's pool-creation fee:
 *  rent for the CPMM pool, LP mint, vaults, observation and LP accounts, plus
 *  the Burn & Earn lock accounts. */
export const MIGRATION_RENT_ALLOWANCE_LAMPORTS = 60_000_000n;
export const DEFAULT_MIGRATION_RESERVE_LAMPORTS = 250_000_000n;

export interface ResolvedCurve {
  label: string;
  params: CurveParams;
  migrationReserveLamports: bigint;
}

const CURVE_KEYS = ["INITIAL_VIRTUAL_TOKEN_RESERVES", "INITIAL_VIRTUAL_SOL_RESERVES", "INITIAL_REAL_TOKEN_RESERVES", "TOKEN_TOTAL_SUPPLY"] as const;

/**
 * Curve selection from environment variables:
 *  - all four INITIAL_* / TOKEN_TOTAL_SUPPLY set: exactly those values;
 *  - CURVE_PRESET=small: smallCurve(CURVE_TARGET_SOL, default 2) (not on mainnet);
 *  - otherwise the mainnet shape.
 * MIGRATION_RESERVE_LAMPORTS overrides the reserve (default 0.25 SOL).
 */
export function resolveCurve(env: Record<string, string | undefined>, cluster: string): ResolvedCurve {
  const reserve = BigInt(env.MIGRATION_RESERVE_LAMPORTS ?? DEFAULT_MIGRATION_RESERVE_LAMPORTS.toString());
  const given = CURVE_KEYS.filter((k) => env[k] !== undefined && env[k] !== "");
  if (given.length > 0) {
    if (given.length !== CURVE_KEYS.length) throw new Error(`set all of ${CURVE_KEYS.join(", ")} or none`);
    const v = (k: (typeof CURVE_KEYS)[number]) => BigInt(env[k]!);
    return {
      label: "explicit",
      params: {
        initialVirtualTokenReserves: v("INITIAL_VIRTUAL_TOKEN_RESERVES"),
        initialVirtualSolReserves: v("INITIAL_VIRTUAL_SOL_RESERVES"),
        initialRealTokenReserves: v("INITIAL_REAL_TOKEN_RESERVES"),
        tokenTotalSupply: v("TOKEN_TOTAL_SUPPLY"),
      },
      migrationReserveLamports: reserve,
    };
  }
  const preset = env.CURVE_PRESET ?? "mainnet";
  if (preset === "small") {
    if (cluster === "mainnet-beta") throw new Error("CURVE_PRESET=small is for devnet/localnet only");
    const targetSol = Number(env.CURVE_TARGET_SOL ?? "2");
    if (!(targetSol > 0)) throw new Error("CURVE_TARGET_SOL must be > 0");
    const target = BigInt(Math.round(targetSol * 1e9));
    return { label: `small (~${targetSol} SOL raise)`, params: smallCurve(target, reserve), migrationReserveLamports: reserve };
  }
  if (preset !== "mainnet") throw new Error(`unknown CURVE_PRESET ${preset}`);
  return { label: "mainnet", params: MAINNET_CURVE, migrationReserveLamports: reserve };
}

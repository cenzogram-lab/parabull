/** Program defaults (programs/parabull/src/constants.rs, scripts/deploy_and_init.ts). */
import { buyCost, type Reserves } from "./curve";

export const PROTOCOL = {
  decimals: 6,
  totalSupply: 1_000_000_000_000_000n,
  initialVirtualToken: 1_073_000_000_000_000n,
  initialVirtualSol: 30_000_000_000n,
  initialRealToken: 793_100_000_000_000n,
  platformFeeBps: 100n,
  launchFeeLamports: 200_000_000n,
  ticketDepositLamports: 230_000_000n,
  ticketTtlSeconds: 600,
  registryLockSeconds: 3 * 24 * 60 * 60,
  tradingOpenDelaySlots: 2,
  /** Fee split after the DexScreener escrow is funded: 50% buyback, 40% holders, rest treasury. */
  buybackBps: 5_000,
  holderBps: 4_000,
  dexListingUsd: 299,
  migrationReserveLamports: 250_000_000n,
  maxNameLen: 32,
  maxTickerLen: 10,
  maxUriLen: 200,
} as const;

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const TOKEN_UNIT = 1_000_000;

export const initialReserves = (): Reserves => ({
  virtualToken: PROTOCOL.initialVirtualToken,
  virtualSol: PROTOCOL.initialVirtualSol,
  realToken: PROTOCOL.initialRealToken,
  realSol: 0n,
});

/** SOL raised when the last curve token is bought (about 85 SOL on the default curve). */
export const GRADUATION_RAISE_LAMPORTS = buyCost(initialReserves(), PROTOCOL.initialRealToken);

/** SOL per whole token at the current reserves. */
export const priceSol = (r: Reserves) => Number(r.virtualSol) / LAMPORTS_PER_SOL / (Number(r.virtualToken) / TOKEN_UNIT);

/** Fully diluted market cap in SOL (fixed 1B supply). */
export const mcapSol = (r: Reserves) => priceSol(r) * (Number(PROTOCOL.totalSupply) / TOKEN_UNIT);

/** Fraction of the curve sold, 0..1. */
/**
 * Curve progress, 0..1, as the indexer measures it (services/parabull-indexer src/model.ts `progressOf`): the share of
 * the curve's launch tokens sold. The curve completes when the last one sells, so this reaches 1 exactly then, unlike
 * SOL raised (which `prepare_migration` moves out).
 */
export const curveProgress = (r: Reserves, initialRealToken: bigint = PROTOCOL.initialRealToken) =>
  initialRealToken <= 0n ? 0 : Math.max(0, Math.min(1, Number(initialRealToken - r.realToken) / Number(initialRealToken)));

/** Reserves after `tokensSold` base units have been bought from a fresh curve. */
export function reservesAtSold(tokensSold: bigint): Reserves {
  const start = initialReserves();
  const sold = tokensSold > start.realToken ? start.realToken : tokensSold;
  const realSol = sold === 0n ? 0n : buyCost(start, sold);
  return {
    virtualToken: start.virtualToken - sold,
    virtualSol: start.virtualSol + realSol,
    realToken: start.realToken - sold,
    realSol,
  };
}

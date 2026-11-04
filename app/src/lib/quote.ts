/** Trade quotes for the terminal, built on the program's own curve math. */
import { applySlippage, quoteBuyExactTokens, quoteSell, tokensForSol, type Reserves } from "./curve";

const BPS = 10_000n;

export interface BuyQuote {
  tokens: bigint;
  solCost: bigint;
  fee: bigint;
  total: bigint;
  /** `max_sol_cost` to send: total plus slippage. */
  maxCost: bigint;
  /** Average fill price vs the spot price, as a fraction (0.031 = 3.1% worse). */
  priceImpact: number;
  /** True when this buy takes the last curve tokens (the curve completes). */
  completesCurve: boolean;
}

/**
 * Largest buy whose total (cost + platform fee) fits in `budget` lamports.
 * The program's `buy` takes an exact token amount, so the SOL input is
 * converted to tokens here and re-quoted exactly.
 */
export function quoteBuyWithSol(r: Reserves, budget: bigint, feeBps: bigint, slippageBps: bigint): BuyQuote | null {
  if (budget <= 1n || r.realToken === 0n) return null;
  const preFee = (budget * BPS) / (BPS + feeBps);
  if (preFee <= 1n) return null;
  let tokens = tokensForSol(r, preFee);
  if (tokens > r.realToken) tokens = r.realToken;
  if (tokens <= 0n) return null;
  let q = quoteBuyExactTokens(r, tokens, feeBps);
  // Fee rounding can push the total a few lamports over; step down until it fits.
  for (let i = 0; q.total > budget && i < 64; i++) {
    tokens -= tokens / 2000n + 1n;
    if (tokens <= 0n) return null;
    q = quoteBuyExactTokens(r, tokens, feeBps);
  }
  if (q.total > budget) return null;
  const spot = Number(r.virtualSol) / Number(r.virtualToken);
  const fill = Number(q.solCost) / Number(q.tokensOut);
  return {
    tokens: q.tokensOut,
    solCost: q.solCost,
    fee: q.fee,
    total: q.total,
    maxCost: applySlippage(q.total, slippageBps, true),
    priceImpact: fill / spot - 1,
    completesCurve: q.tokensOut === r.realToken,
  };
}

export interface SellQuote {
  tokens: bigint;
  solGross: bigint;
  fee: bigint;
  solNet: bigint;
  /** `min_sol_output` to send: net proceeds minus slippage. */
  minOut: bigint;
  priceImpact: number;
}

export function quoteSellTokens(r: Reserves, tokens: bigint, feeBps: bigint, slippageBps: bigint): SellQuote | null {
  if (tokens <= 0n) return null;
  try {
    const q = quoteSell(r, tokens, feeBps);
    const spot = Number(r.virtualSol) / Number(r.virtualToken);
    const fill = Number(q.solGross) / Number(tokens);
    return { tokens, solGross: q.solGross, fee: q.fee, solNet: q.solNet, minOut: applySlippage(q.solNet, slippageBps, false), priceImpact: 1 - fill / spot };
  } catch {
    return null; // more than the curve's real SOL can pay out
  }
}

/** Reserves after a buy of `tokens` costing `solCost` (fee excluded; it never enters the reserves). */
export const applyBuy = (r: Reserves, tokens: bigint, solCost: bigint): Reserves => ({
  virtualToken: r.virtualToken - tokens,
  virtualSol: r.virtualSol + solCost,
  realToken: r.realToken - tokens,
  realSol: r.realSol + solCost,
});

export const applySell = (r: Reserves, tokens: bigint, solGross: bigint): Reserves => ({
  virtualToken: r.virtualToken + tokens,
  virtualSol: r.virtualSol - solGross,
  realToken: r.realToken + tokens,
  realSol: r.realSol - solGross,
});

/**
 * Port of programs/parabull/src/math.rs (bigint, exact integer semantics).
 * Used to set slippage limits; the program re-computes everything on-chain.
 */
export interface Reserves {
  virtualToken: bigint;
  virtualSol: bigint;
  realToken: bigint;
  realSol: bigint;
}

const BPS = 10_000n;

export const buyCost = (r: Reserves, tokens: bigint) => {
  const den = r.virtualToken - tokens;
  if (den <= 0n) throw new Error("buy exceeds virtual reserves");
  return (tokens * r.virtualSol) / den + 1n;
};
export const sellProceeds = (r: Reserves, tokens: bigint) => (r.virtualSol * tokens) / (r.virtualToken + tokens);
export const tokensForSol = (r: Reserves, sol: bigint) => {
  if (sol === 0n) throw new Error("zero SOL");
  const eff = sol - 1n;
  return (eff * r.virtualToken) / (r.virtualSol + eff);
};
export const fee = (amount: bigint, bps: bigint) => (amount * bps + BPS - 1n) / BPS;

export function quoteBuyExactTokens(r: Reserves, tokens: bigint, feeBps: bigint) {
  const tokensOut = tokens < r.realToken ? tokens : r.realToken;
  const solCost = buyCost(r, tokensOut);
  const f = fee(solCost, feeBps);
  return { tokensOut, solCost, fee: f, total: solCost + f };
}

export function quoteSell(r: Reserves, tokens: bigint, feeBps: bigint) {
  const solGross = sellProceeds(r, tokens);
  if (solGross > r.realSol) throw new Error("sell exceeds real SOL reserves");
  const f = fee(solGross, feeBps);
  return { tokensIn: tokens, solGross, fee: f, solNet: solGross - f };
}

/** Raydium CPMM swap_base_input quote: fee = ceil(in * rate / 1e6), then constant product. */
export function cpmmQuoteOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, tradeFeeRate: bigint) {
  const feeAmt = (amountIn * tradeFeeRate + 999_999n) / 1_000_000n;
  const inAfterFee = amountIn - feeAmt;
  return (reserveOut * inAfterFee) / (reserveIn + inAfterFee);
}

export const applySlippage = (amount: bigint, bps: bigint, up: boolean) => (up ? (amount * (BPS + bps)) / BPS : (amount * (BPS - bps)) / BPS);

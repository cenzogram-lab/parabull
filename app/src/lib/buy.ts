/**
 * The buy transaction's instructions as Anchor builds them (hooks/useParabullProgram.ts sends it): `buy`, then, for a
 * followed callout link, the referral Memo at the top level (src/lib/referral.ts).
 */
import type { BN, Program } from "@coral-xyz/anchor";
import type { Parabull } from "../idl/parabull";
import { refMemoInstruction } from "./referral";

type TradeAccounts = Parameters<ReturnType<Program<Parabull>["methods"]["buy"]>["accountsStrict"]>[0];

/** `tokens` and `maxSolCost` as BN (u64), built by the caller: this module imports Anchor's types only. */
export function buyMethod(program: Program<Parabull>, accounts: TradeAccounts, tokens: BN, maxSolCost: BN, refCalloutId: string | null) {
  const m = program.methods.buy(tokens, maxSolCost).accountsStrict(accounts);
  return refCalloutId ? m.postInstructions([refMemoInstruction(refCalloutId)]) : m;
}

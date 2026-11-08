/**
 * Pure helpers for test_devnet_e2e.ts: options, the fixed-budget buy quote,
 * balance deltas from transaction metadata, event extraction and the check log.
 */
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import { PublicKey, VersionedMessage, VersionedTransactionResponse } from "@solana/web3.js";
import type { ClusterName } from "./config";
import { Reserves, applySlippage, quoteBuyExactTokens } from "./curve";

export interface E2eOptions {
  /** E2E_BUY_SOL (default 0.230): the buy's whole spend, fee included. */
  buyLamports: bigint;
  /** E2E_SELL_BPS (default 5000): share of the bought tokens to sell back; must leave some held. */
  sellBps: bigint;
  /** E2E_SLIPPAGE_BPS (default 200): ceiling on the buy's cost and floor on the sell's payout. */
  slippageBps: bigint;
  /** E2E_URI: real metadata JSON (the worker then fetches it and its image); unset skips the fetch. */
  uri: string | null;
  /** E2E_INDEXER_URL: also check that services/parabull-indexer serves the coin, both trades and the position. */
  indexerUrl: string | null;
  /** E2E_KEEP_FUNDS=1: leave the test wallet's SOL where it is instead of returning it to the admin. */
  keepFunds: boolean;
}

/** Exact decimal SOL -> lamports (no float rounding): "0.230" -> 230_000_000n. */
export function solToLamports(sol: string): bigint {
  const m = sol.trim().match(/^(\d+)(?:\.(\d{1,9}))?$/);
  if (!m) throw new Error(`not a SOL amount: ${sol}`);
  return BigInt(m[1]) * 1_000_000_000n + BigInt((m[2] ?? "").padEnd(9, "0"));
}

const bps = (env: Record<string, string | undefined>, key: string, def: string, min: bigint, max: bigint): bigint => {
  const v = env[key] ?? def;
  if (!/^\d+$/.test(v) || BigInt(v) < min || BigInt(v) > max) throw new Error(`${key} must be an integer from ${min} to ${max}, got ${v}`);
  return BigInt(v);
};

export function e2eOptions(env: Record<string, string | undefined>, cluster: ClusterName): E2eOptions {
  if (cluster === "mainnet-beta") throw new Error("the end-to-end test spends real SOL on a throwaway coin; it runs on devnet (or localnet) only");
  const buyLamports = solToLamports(env.E2E_BUY_SOL ?? "0.230");
  if (buyLamports === 0n) throw new Error("E2E_BUY_SOL must be above 0");
  if (buyLamports > 2_000_000_000n) throw new Error("E2E_BUY_SOL is capped at 2 SOL");
  const indexerUrl = env.E2E_INDEXER_URL?.trim() || null;
  if (indexerUrl && !/^https?:\/\//.test(indexerUrl)) throw new Error(`E2E_INDEXER_URL must be http(s)://, got ${indexerUrl}`);
  return {
    buyLamports,
    sellBps: bps(env, "E2E_SELL_BPS", "5000", 1n, 9_999n),
    slippageBps: bps(env, "E2E_SLIPPAGE_BPS", "200", 0n, 2_000n),
    uri: env.E2E_URI?.trim() || null,
    indexerUrl: indexerUrl?.replace(/\/+$/, "") ?? null,
    keepFunds: env.E2E_KEEP_FUNDS === "1",
  };
}

/**
 * The most tokens whose cost plus fee fits in `budget` lamports (binary search
 * over the program's own buy quote). Refuses a budget that would take the last
 * real token: the test needs a curve that's still trading for the sell.
 */
export function tokensForBudget(r: Reserves, budget: bigint, feeBps: bigint) {
  if (r.realToken === 0n) throw new Error("curve has no tokens left");
  if (quoteBuyExactTokens(r, r.realToken, feeBps).total <= budget) {
    throw new Error(`${budget} lamports would buy out the whole curve; lower E2E_BUY_SOL or use a larger curve`);
  }
  let lo = 0n; // fits
  let hi = r.realToken; // doesn't fit
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (quoteBuyExactTokens(r, mid, feeBps).total <= budget) lo = mid;
    else hi = mid;
  }
  if (lo === 0n) throw new Error(`${budget} lamports doesn't buy a single token unit`);
  return quoteBuyExactTokens(r, lo, feeBps);
}

/** Tokens to sell back: `sellBps` of what's held, at least 1 and leaving at least 1 (a partial sell). */
export function partialSellAmount(held: bigint, sellBps: bigint): bigint {
  if (held < 2n) throw new Error("need at least 2 token units for a partial sell");
  const amount = (held * sellBps) / 10_000n;
  return amount < 1n ? 1n : amount >= held ? held - 1n : amount;
}

/** Lamports to give the throwaway wallet: the ticket deposit, the buy at its slippage ceiling, and 0.03 SOL for rent and fees. */
export function fundingFor(depositLamports: bigint, buyLamports: bigint, slippageBps: bigint): bigint {
  return depositLamports + applySlippage(buyLamports, slippageBps, true) + 30_000_000n;
}

type TxWithMeta = Pick<VersionedTransactionResponse, "transaction" | "meta">;

/** An account's lamport change across a transaction (post - pre), from its metadata; 0n if it wasn't in it. */
export function lamportDelta(tx: TxWithMeta, account: PublicKey): bigint {
  if (!tx.meta) throw new Error("transaction has no metadata");
  const keys = (tx.transaction.message as VersionedMessage).getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
  for (let i = 0; i < keys.length; i++) {
    if (keys.get(i)!.equals(account)) return BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
  }
  return 0n;
}

export interface ParsedEvent {
  name: string;
  data: Record<string, unknown>;
}

/** The program's events in a transaction's logs (only while the program is on top of the invoke stack). */
export function eventsIn(logs: string[] | null | undefined, programId: PublicKey, coder: BorshCoder): ParsedEvent[] {
  return [...new EventParser(programId, coder).parseLogs(logs ?? [])].map((e) => ({ name: e.name, data: e.data as Record<string, unknown> }));
}

/** The one event named `name` (case- and underscore-insensitive); throws unless there's exactly one. */
export function oneEvent(events: ParsedEvent[], name: string): ParsedEvent {
  const norm = (s: string) => s.replace(/_/g, "").toLowerCase();
  const found = events.filter((e) => norm(e.name) === norm(name));
  if (found.length !== 1) throw new Error(`expected one ${name} event, found ${found.length} (${events.map((e) => e.name).join(", ") || "none"})`);
  return found[0];
}

/** An event field by its camelCase name, falling back to snake_case (Anchor's coder may use either). */
export function field(e: ParsedEvent, camel: string): unknown {
  if (camel in e.data) return e.data[camel];
  const snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  if (snake in e.data) return e.data[snake];
  throw new Error(`${e.name} has no field ${camel}`);
}

/** A u64/i64 event or account field (BN, bigint, number or string) as bigint. */
export const u64 = (v: unknown): bigint => BigInt((v as { toString(): string }).toString());

export class CheckFailed extends Error {}

/** Records each check as it passes; the first failure throws (later steps depend on earlier state). */
export class Checks {
  readonly passed: string[] = [];
  constructor(private readonly log: (line: string) => void = () => undefined) {}

  ok(name: string, cond: unknown, detail = ""): void {
    if (!cond) throw new CheckFailed(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
    this.passed.push(name);
    this.log(`  ok  ${name}`);
  }

  /** Equality for bigint/number/string/boolean/PublicKey (numbers and bigints compare by value). */
  eq(name: string, actual: unknown, expected: unknown): void {
    const show = (v: unknown) => (v instanceof PublicKey ? v.toBase58() : typeof v === "bigint" ? `${v}` : JSON.stringify(v));
    const same =
      actual instanceof PublicKey || expected instanceof PublicKey
        ? actual instanceof PublicKey && expected instanceof PublicKey && actual.equals(expected)
        : (typeof actual === "bigint" || typeof actual === "number") && (typeof expected === "bigint" || typeof expected === "number")
          ? BigInt(actual) === BigInt(expected)
          : actual === expected;
    this.ok(name, same, `got ${show(actual)}, expected ${show(expected)}`);
  }
}

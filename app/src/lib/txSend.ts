/**
 * How the app sends a trade: a compute-unit limit sized by simulation and a priority fee from recent fees on the
 * curve account, then a send-and-watch loop that rebroadcasts until the transaction lands or its blockhash expires.
 *
 * The outcome is always definite or honestly unknown. A transaction is reported failed only when the cluster says
 * so (an error status) or when its blockhash has expired with no status (it can never land, so nothing was spent).
 * If the status can't be read in time, the caller is told it's unconfirmed, never "failed", so a trade that is still
 * landing isn't retried into a double buy.
 */
import { ComputeBudgetProgram, type Connection, type PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";

/** Priority-fee policy, micro-lamports per compute unit. */
export const PRIORITY_FEE = { percentile: 0.75, min: 10_000, max: 2_000_000, fallback: 50_000 } as const;
/** Compute limits: the simulation's figure plus headroom, inside these bounds; `fallback` when simulation gives none. */
export const COMPUTE_UNITS = { headroom: 1.15, extra: 5_000, min: 50_000, max: 1_400_000, fallback: 300_000 } as const;

/** The `percentile` of recent fees (zeros included: an idle account needs little), clamped to [min, max]. */
export function pickPriorityFee(samples: number[], p: { percentile: number; min: number; max: number; fallback: number } = PRIORITY_FEE): number {
  const xs = samples.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (xs.length === 0) return p.fallback;
  const v = xs[Math.min(xs.length - 1, Math.floor(p.percentile * xs.length))];
  return Math.round(Math.min(p.max, Math.max(p.min, v)));
}

export function computeUnitLimit(unitsConsumed: number | null | undefined, c = COMPUTE_UNITS): number {
  if (!unitsConsumed || unitsConsumed <= 0) return c.fallback;
  return Math.min(c.max, Math.max(c.min, Math.ceil(unitsConsumed * c.headroom) + c.extra));
}

/** Worst-case priority fee in lamports for a limit and a price. */
export const priorityFeeLamports = (units: number, microLamportsPerCu: number) => Math.ceil((units * microLamportsPerCu) / 1_000_000);

export interface IdlError {
  code: number;
  name: string;
  msg?: string;
}

/**
 * A readable reason from a transaction error and/or its logs: the Anchor error the logs name, else the program error
 * code looked up in the IDL, else the raw error.
 */
export function describeTxError(err: unknown, logs: string[] | null | undefined, idlErrors: IdlError[]): string {
  for (const l of logs ?? []) {
    const m = /Error Code: (\w+)\. Error Number: \d+\. Error Message: (.+?)\.?$/.exec(l);
    if (m) return `${m[2]} (${m[1]})`;
  }
  const custom = (err as { InstructionError?: [number, { Custom?: number } | string] } | null)?.InstructionError?.[1];
  if (custom && typeof custom === "object" && typeof custom.Custom === "number") {
    const e = idlErrors.find((x) => x.code === custom.Custom);
    return e ? `${e.msg ?? e.name} (${e.name})` : `program error ${custom.Custom}`;
  }
  if (typeof custom === "string") return custom;
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

/** The cluster rejected the transaction: it landed with an error, or simulation showed it would. Nothing to retry. */
export class TxFailedError extends Error {
  constructor(message: string, readonly signature: string | null) {
    super(message);
    this.name = "TxFailedError";
  }
}
/** The blockhash expired with no status: the transaction can never land, and nothing was spent. Safe to retry. */
export class TxExpiredError extends Error {
  constructor(readonly signature: string) {
    super("The transaction expired before it landed. Nothing was spent: you can place it again.");
    this.name = "TxExpiredError";
  }
}
/** No status in time and the blockhash isn't known to have expired: it may still land. Check before retrying. */
export class TxUnconfirmedError extends Error {
  constructor(readonly signature: string) {
    super("The transaction was sent but isn't confirmed yet. Check it in the explorer before placing it again.");
    this.name = "TxUnconfirmedError";
  }
}

export interface ConfirmRpc {
  sendRaw(raw: Uint8Array): Promise<string>;
  /** `history`: search the whole transaction history, not just recent statuses (the final check before "expired"). */
  status(signature: string, history?: boolean): Promise<{ err: unknown; confirmationStatus?: string | null } | null>;
  blockHeight(): Promise<number>;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 of bytes (a transaction signature). */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export interface ConfirmOptions {
  pollMs?: number;
  rebroadcastMs?: number;
  /** Give up as unconfirmed after this long without a status or a readable block height. */
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  idlErrors?: IdlError[];
}

/**
 * Sends `raw` (whose first signature is `signature`) and watches it: confirmed (returns the signature), failed on-chain
 * (TxFailedError), expired (TxExpiredError, once the block height is past `lastValidBlockHeight` and two final status
 * checks over the whole history, a poll apart, find nothing), or unconfirmed (TxUnconfirmedError, when nothing can be
 * read for `maxWaitMs`). Rebroadcasts while it waits. A send that errors is treated like a lost rebroadcast: the RPC
 * may have forwarded the transaction before failing, so only its status decides.
 */
export async function sendAndConfirm(rpc: ConfirmRpc, raw: Uint8Array, signature: string, lastValidBlockHeight: number, o: ConfirmOptions = {}): Promise<string> {
  const pollMs = o.pollMs ?? 1_500;
  const rebroadcastMs = o.rebroadcastMs ?? 2_000;
  const maxWaitMs = o.maxWaitMs ?? 120_000;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await rpc.sendRaw(raw).catch(() => undefined);
  const started = now();
  let lastSend = started;
  const landed = (s: Awaited<ReturnType<ConfirmRpc["status"]>>) => !!s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");
  const settle = (s: NonNullable<Awaited<ReturnType<ConfirmRpc["status"]>>>) => {
    if (s.err) throw new TxFailedError(describeTxError(s.err, null, o.idlErrors ?? []), signature);
    return signature;
  };
  for (;;) {
    const s = await rpc.status(signature).catch(() => undefined);
    if (s && landed(s)) return settle(s);
    if (s?.err) return settle(s); // processed with an error: it won't change
    const height = await rpc.blockHeight().catch(() => null);
    if (height !== null && height > lastValidBlockHeight) {
      // Twice, a poll apart, over the whole history: the node that answered the block height may be ahead of the one
      // answering statuses. Expired only if both say the transaction isn't there.
      let last = await rpc.status(signature, true).catch(() => undefined);
      if (last === null) {
        await sleep(pollMs);
        last = await rpc.status(signature, true).catch(() => undefined);
      }
      if (last && (landed(last) || last.err)) return settle(last);
      if (last === null) throw new TxExpiredError(signature);
      throw new TxUnconfirmedError(signature);
    }
    if (now() - started > maxWaitMs) throw new TxUnconfirmedError(signature);
    if (now() - lastSend >= rebroadcastMs) {
      lastSend = now();
      await rpc.sendRaw(raw).catch(() => undefined);
    }
    await sleep(pollMs);
  }
}

export interface SendBudgetedOptions {
  connection: Connection;
  payer: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  instructions: TransactionInstruction[];
  /** Accounts whose recent fees price this transaction (the curve). */
  feeAccounts: PublicKey[];
  idlErrors: IdlError[];
  confirm?: ConfirmOptions;
}

/**
 * Simulates the instructions under the maximum limit (failing early with the program's own error), then sends them
 * with a compute limit sized from the simulation and a priority fee, and watches them land (`sendAndConfirm`).
 */
export async function sendBudgeted(o: SendBudgetedOptions): Promise<{ signature: string; computeUnits: number; microLamports: number }> {
  const { connection } = o;
  const fees = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: o.feeAccounts }).catch(() => []);
  const microLamports = pickPriorityFee(fees.map((f) => f.prioritizationFee));
  const build = (units: number, blockhash: string) => {
    const tx = new Transaction({ feePayer: o.payer, recentBlockhash: blockhash });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...o.instructions);
    return tx;
  };
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const sim = await connection.simulateTransaction(build(COMPUTE_UNITS.max, blockhash));
  if (sim.value.err) throw new TxFailedError(describeTxError(sim.value.err, sim.value.logs, o.idlErrors), null);
  const computeUnits = computeUnitLimit(sim.value.unitsConsumed);
  const signed = await o.signTransaction(build(computeUnits, blockhash));
  if (!signed.signature) throw new Error("The wallet didn't sign the transaction");
  const raw = signed.serialize();
  const signature = await sendAndConfirm(
    {
      sendRaw: (r) => connection.sendRawTransaction(r, { skipPreflight: true, maxRetries: 0 }),
      status: async (sig, history) => (await connection.getSignatureStatuses([sig], { searchTransactionHistory: !!history })).value[0],
      blockHeight: () => connection.getBlockHeight("confirmed"),
    },
    raw,
    base58(signed.signature),
    lastValidBlockHeight,
    { idlErrors: o.idlErrors, ...o.confirm },
  );
  return { signature, computeUnits, microLamports };
}

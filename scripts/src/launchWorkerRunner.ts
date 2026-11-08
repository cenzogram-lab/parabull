/**
 * The launch worker's ticket handling (docs/BACKEND_SPEC.md §1), with its
 * chain access passed in. `launch_worker.ts` runs it as a service; the devnet
 * end-to-end test (`test_devnet_e2e.ts`) drives `handle` for its own ticket so
 * it exercises the same code path the service runs.
 *
 *   ticket -> recover args from request_launch -> decide (pause, commitment,
 *   locks) -> optional metadata / tweet checks -> CSPRNG 3-15 s delay ->
 *   re-decide -> `create` (launch authority + fresh mint keypair), refunding a
 *   ticket whose create can never succeed.
 */
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { DecisionInput, RegistryState, RequestArgs, checkMetadataUri, decide, findRequestArgs, randomDelayMs, verifyTweet } from "./launchWorker";
import { Pdas, ata2022 } from "./pdas";
import { ParabullProgram, anchorErrorName, big, send as sendIxs } from "./program";

/** Errors from `create` that will never succeed on retry: refund instead. */
export const TERMINAL_CREATE_ERRORS = new Set([
  "TickerLocked",
  "NameLocked",
  "TweetLocked",
  "MetadataMismatch",
  "TweetRegistryMismatch",
  "InvalidName",
  "InvalidTicker",
  "InvalidUri",
  "LaunchFeeExceedsDeposit",
]);

export type HandleOutcome =
  /** `create` landed. `signature` is null when an earlier attempt landed and only the closed ticket was seen. */
  | { kind: "created"; ticket: PublicKey; mint: PublicKey; symbol: string; delayMs: number; signature: string | null }
  /** Rejected and refunded to the payer (signature null if the refund itself failed or the ticket was already gone). */
  | { kind: "refunded"; ticket: PublicKey; reason: string; signature: string | null }
  /** The ticket was already closed (created or refunded elsewhere). */
  | { kind: "closed"; ticket: PublicKey }
  /** Left open for now: paused, the request transaction not found yet, near expiry, or already being handled. */
  | { kind: "skipped"; ticket: PublicKey; reason: string }
  | { kind: "error"; ticket: PublicKey; message: string };

export interface LaunchWorkerDeps {
  connection: Connection;
  program: ParabullProgram;
  pdas: Pdas;
  launchAuthority: Keypair;
  /** Skip fetching the metadata URI and its image (SKIP_METADATA_FETCH=1). */
  skipMetadataFetch?: boolean;
  /** X API bearer token for the tweet check; skipped when unset. */
  xBearerToken?: string;
  /** The pre-create delay; default CSPRNG-uniform 3-15 s. */
  delayMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Sends instructions signed by `signers`; default `program.ts` `send` (explicit compute limit, confirmed). */
  send?: (ixs: TransactionInstruction[], signers: Keypair[], computeUnits: number) => Promise<string>;
  /** Unix seconds; default the local clock. */
  now?: () => bigint;
  log?: (...a: unknown[]) => void;
}

type Ticket = Awaited<ReturnType<ParabullProgram["account"]["launchTicket"]["fetch"]>>;

const tickerOf = (t: Ticket) => Buffer.from(t.ticker.slice(0, t.tickerLen)).toString("utf8");
const reg = (r: { mint: PublicKey; launchTimestamp: { toString(): string } } | null): RegistryState | null =>
  r && { mint: r.mint, launchTimestamp: BigInt(r.launchTimestamp.toString()) };

export function createLaunchWorker(d: LaunchWorkerDeps) {
  const { connection, program, pdas, launchAuthority } = d;
  const coder = program.coder as BorshCoder;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const send = d.send ?? ((ixs: TransactionInstruction[], signers: Keypair[], cu: number) => sendIxs(connection, ixs, signers, cu));
  const now = d.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const log = d.log ?? (() => undefined);
  const delayMs = d.delayMs ?? (() => randomDelayMs());
  const inFlight = new Set<string>();
  /** Signature of the request_launch transaction, when known (log subscription, or the caller), to skip a lookup. */
  const sigHint = new Map<string, string>();

  async function recoverArgs(ticket: PublicKey): Promise<RequestArgs | null> {
    const hinted = sigHint.get(ticket.toBase58());
    const sigs = hinted ? [hinted] : (await connection.getSignaturesForAddress(ticket, { limit: 20 }, "confirmed")).reverse().map((s) => s.signature);
    for (const sig of sigs) {
      const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const args = tx && findRequestArgs(tx, program.programId, ticket, coder);
      if (args) return args;
    }
    return null;
  }

  async function evaluate(t: Ticket, args: RequestArgs | null): Promise<DecisionInput> {
    const g = await program.account.global.fetch(pdas.global());
    const tweetHash = t.tweetIdHash ? Buffer.from(t.tweetIdHash) : null;
    const [tk, nm, tw] = await Promise.all([
      program.account.tickerRegistry.fetchNullable(pdas.tickerRegistry(tickerOf(t))),
      program.account.nameRegistry.fetchNullable(pdas.nameRegistry(Buffer.from(t.nameHash))),
      tweetHash ? program.account.tweetRegistry.fetchNullable(pdas.tweetRegistry(tweetHash)) : Promise.resolve(null),
    ]);
    return {
      now: now(),
      paused: g.paused,
      expiresAt: big(t.expiresAt),
      lockSeconds: big(g.registryLockSeconds),
      ticketMetadataHash: Buffer.from(t.metadataHash),
      ticketTweetHash: tweetHash,
      args,
      ticker: reg(tk),
      name: reg(nm),
      tweet: reg(tw),
    };
  }

  async function refund(ticket: PublicKey, t: Ticket, reason: string): Promise<HandleOutcome> {
    const ix = await program.methods
      .refundTicket()
      .accountsStrict({ authority: launchAuthority.publicKey, payer: t.payer, global: pdas.global(), ticket })
      .instruction();
    try {
      const signature = await send([ix], [launchAuthority], 100_000);
      log(`refund ${ticket.toBase58()} (${reason}): ${signature}`);
      return { kind: "refunded", ticket, reason, signature };
    } catch (e) {
      if (!(await connection.getAccountInfo(ticket))) return { kind: "closed", ticket };
      log(`refund ${ticket.toBase58()} failed: ${anchorErrorName(e) ?? (e as Error).message}`);
      return { kind: "refunded", ticket, reason, signature: null };
    }
  }

  async function sendCreate(ticket: PublicKey, t: Ticket, args: RequestArgs, mint: Keypair): Promise<string> {
    const g = await program.account.global.fetch(pdas.global());
    const curve = pdas.bondingCurve(mint.publicKey);
    const ix = await program.methods
      .create(args.name, args.symbol, args.uri)
      .accountsStrict({
        launchAuthority: launchAuthority.publicKey,
        global: pdas.global(),
        ticket,
        payer: t.payer,
        treasury: g.treasury,
        mint: mint.publicKey,
        mintAuthority: pdas.mintAuthority(),
        bondingCurve: curve,
        curveTokenAccount: ata2022(mint.publicKey, curve),
        tickerRegistry: pdas.tickerRegistry(tickerOf(t)),
        nameRegistry: pdas.nameRegistry(Buffer.from(t.nameHash)),
        tweetRegistry: t.tweetIdHash ? pdas.tweetRegistry(Buffer.from(t.tweetIdHash)) : null,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return send([ix], [launchAuthority, mint], 400_000);
  }

  async function run(ticket: PublicKey): Promise<HandleOutcome> {
    const key = ticket.toBase58();
    let t = await program.account.launchTicket.fetchNullable(ticket);
    if (!t) return { kind: "closed", ticket };
    const args = await recoverArgs(ticket);
    const first = decide(await evaluate(t, args));
    if (first.action === "reject") return refund(ticket, t, first.reason);
    if (first.action !== "schedule") {
      log(`${first.action} ${key}: ${first.reason}`);
      return { kind: "skipped", ticket, reason: `${first.action}: ${first.reason}` };
    }

    // Off-chain checks (BACKEND_SPEC §1.2 items 3-4), before the delay.
    const offChain =
      (d.skipMetadataFetch ? null : await checkMetadataUri(args!.uri)) ??
      (args!.tweetId === null ? null : await verifyTweet(args!.tweetId, args!.symbol, { bearer: d.xBearerToken }));
    if (offChain) return refund(ticket, t, offChain);

    const delay = delayMs();
    log(`schedule ${key} $${args!.symbol} in ${delay} ms`);
    await sleep(delay);

    // Same mint keypair across retries: if an earlier send landed, the ticket is closed.
    const mint = Keypair.generate();
    for (let attempt = 1; ; attempt++) {
      t = await program.account.launchTicket.fetchNullable(ticket);
      if (!t) {
        // Closed while we waited: ours if the mint exists (an attempt landed), otherwise someone else's.
        if (attempt > 1 && (await connection.getAccountInfo(mint.publicKey))) {
          return { kind: "created", ticket, mint: mint.publicKey, symbol: args!.symbol, delayMs: delay, signature: null };
        }
        log(`done ${key} (ticket closed)`);
        return { kind: "closed", ticket };
      }
      const again = decide(await evaluate(t, args));
      if (again.action === "reject") return refund(ticket, t, again.reason);
      if (again.action === "abandon") {
        log(`abandon ${key}: ${again.reason}`);
        return { kind: "skipped", ticket, reason: `abandon: ${again.reason}` };
      }
      if (again.action === "wait") {
        await sleep(5_000);
        continue;
      }
      try {
        const signature = await sendCreate(ticket, t, args!, mint);
        log(`created ${mint.publicKey.toBase58()} $${args!.symbol} for ${key}: ${signature}`);
        return { kind: "created", ticket, mint: mint.publicKey, symbol: args!.symbol, delayMs: delay, signature };
      } catch (e) {
        const name = anchorErrorName(e);
        if (!(await connection.getAccountInfo(ticket))) {
          log(`done ${key} (landed on an earlier attempt)`);
          return { kind: "created", ticket, mint: mint.publicKey, symbol: args!.symbol, delayMs: delay, signature: null };
        }
        if (name && TERMINAL_CREATE_ERRORS.has(name)) return refund(ticket, t, name);
        log(`create ${key} attempt ${attempt} failed: ${name ?? (e as Error).message}`);
        await sleep(Math.min(2_000 * attempt, 10_000));
      }
    }
  }

  /** Handle one ticket to an outcome. `requestSignature` (the request_launch tx) skips the signature lookup. */
  async function handle(ticket: PublicKey, requestSignature?: string): Promise<HandleOutcome> {
    const key = ticket.toBase58();
    if (requestSignature) sigHint.set(key, requestSignature);
    if (inFlight.has(key)) return { kind: "skipped", ticket, reason: "already in flight" };
    inFlight.add(key);
    try {
      return await run(ticket);
    } catch (e) {
      log(`error on ${key}: ${(e as Error).message}`);
      return { kind: "error", ticket, message: (e as Error).message };
    } finally {
      inFlight.delete(key);
      sigHint.delete(key);
    }
  }

  /** One pass over every open ticket. */
  async function pollOnce(): Promise<HandleOutcome[]> {
    const tickets = await program.account.launchTicket.all();
    return Promise.all(tickets.map((t) => handle(t.publicKey)));
  }

  /** Handle each `LaunchRequested` as it's logged. Returns the subscription id (`connection.removeOnLogsListener`). */
  function listen(): number {
    const parser = new EventParser(program.programId, coder);
    return connection.onLogs(
      program.programId,
      (l) => {
        if (l.err) return;
        for (const ev of parser.parseLogs(l.logs)) {
          if (ev.name.toLowerCase() !== "launchrequested") continue;
          void handle((ev.data as { ticket: PublicKey }).ticket, l.signature);
        }
      },
      "confirmed",
    );
  }

  return { handle, pollOnce, listen, recoverArgs };
}

export type LaunchWorker = ReturnType<typeof createLaunchWorker>;

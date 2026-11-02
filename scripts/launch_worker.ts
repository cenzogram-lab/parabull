/**
 * Minimal launch worker (docs/BACKEND_SPEC.md §1).
 *
 *   LaunchRequested event / LaunchTicket account
 *     -> validate (pause, metadata commitment, ticker/name/tweet locks,
 *        optional metadata URI fetch and X API tweet check)
 *     -> reject: refund_ticket now (launch authority; funds go to the payer)
 *     -> otherwise wait a CSPRNG-uniform 3-15 s
 *     -> re-validate, then send `create` co-signed by the launch authority and
 *        a fresh in-memory mint keypair.
 *
 * Name/symbol/URI aren't stored on the ticket (only their commitment), so the
 * worker recovers them from the user's request_launch transaction and checks
 * them against `metadata_hash` before using them.
 *
 *   CLUSTER=devnet npm run worker            # run forever
 *   CLUSTER=devnet npm run worker -- --once  # one polling pass, then exit
 *
 * Env: LAUNCH_AUTHORITY_KEYPAIR (default ADMIN_KEYPAIR), POLL_MS (30000),
 * SKIP_METADATA_FETCH=1, X_BEARER_TOKEN (tweet check; skipped when unset),
 * DISABLE_DELAY=1 (localnet testing only; refused on mainnet-beta).
 *
 * State is in memory: on restart, the polling pass rediscovers every open
 * ticket, which is safe because a ticket can only be consumed once on-chain.
 */
import { EventParser, BorshCoder } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { cluster, roles } from "./src/config";
import { ata2022 } from "./src/pdas";
import { anchorErrorName, big, connect, send } from "./src/program";
import {
  DecisionInput,
  EXPIRY_MARGIN_SECONDS,
  RegistryState,
  RequestArgs,
  checkMetadataUri,
  decide,
  findRequestArgs,
  randomDelayMs,
  verifyTweet,
} from "./src/launchWorker";

const POLL_MS = Number(process.env.POLL_MS ?? "30000");
const NO_DELAY = process.env.DISABLE_DELAY === "1";
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Errors from `create` that will never succeed on retry: refund instead. */
const TERMINAL = new Set([
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

const { launchAuthority } = roles();
const x = connect(launchAuthority);
const { connection, program, pdas } = x;
const coder = program.coder as BorshCoder;
const inFlight = new Set<string>();
/** Signature of the request_launch tx, from the log subscription, to skip a lookup. */
const sigHint = new Map<string, string>();

type Ticket = Awaited<ReturnType<typeof program.account.launchTicket.fetch>>;

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

const reg = (r: { mint: PublicKey; launchTimestamp: { toString(): string } } | null): RegistryState | null =>
  r && { mint: r.mint, launchTimestamp: BigInt(r.launchTimestamp.toString()) };

async function evaluate(ticketKey: PublicKey, t: Ticket, args: RequestArgs | null): Promise<DecisionInput> {
  const g = await program.account.global.fetch(pdas.global());
  const ticker = Buffer.from(t.ticker.slice(0, t.tickerLen)).toString("utf8");
  const tweetHash = t.tweetIdHash ? Buffer.from(t.tweetIdHash) : null;
  const [tk, nm, tw] = await Promise.all([
    program.account.tickerRegistry.fetchNullable(pdas.tickerRegistry(ticker)),
    program.account.nameRegistry.fetchNullable(pdas.nameRegistry(Buffer.from(t.nameHash))),
    tweetHash ? program.account.tweetRegistry.fetchNullable(pdas.tweetRegistry(tweetHash)) : Promise.resolve(null),
  ]);
  return {
    now: BigInt(Math.floor(Date.now() / 1000)),
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

async function refund(ticketKey: PublicKey, t: Ticket, reason: string) {
  const ix = await program.methods
    .refundTicket()
    .accountsStrict({ authority: launchAuthority.publicKey, payer: t.payer, global: pdas.global(), ticket: ticketKey })
    .instruction();
  try {
    log(`refund ${ticketKey.toBase58()} (${reason}): ${await send(connection, [ix], [launchAuthority], 100_000)}`);
  } catch (e) {
    if (!(await connection.getAccountInfo(ticketKey))) return; // already closed
    log(`refund ${ticketKey.toBase58()} failed: ${anchorErrorName(e) ?? (e as Error).message}`);
  }
}

async function sendCreate(ticketKey: PublicKey, t: Ticket, args: RequestArgs, mint: Keypair) {
  const g = await program.account.global.fetch(pdas.global());
  const curve = pdas.bondingCurve(mint.publicKey);
  const ix = await program.methods
    .create(args.name, args.symbol, args.uri)
    .accountsStrict({
      launchAuthority: launchAuthority.publicKey,
      global: pdas.global(),
      ticket: ticketKey,
      payer: t.payer,
      treasury: g.treasury,
      mint: mint.publicKey,
      mintAuthority: pdas.mintAuthority(),
      bondingCurve: curve,
      curveTokenAccount: ata2022(mint.publicKey, curve),
      tickerRegistry: pdas.tickerRegistry(Buffer.from(t.ticker.slice(0, t.tickerLen)).toString("utf8")),
      nameRegistry: pdas.nameRegistry(Buffer.from(t.nameHash)),
      tweetRegistry: t.tweetIdHash ? pdas.tweetRegistry(Buffer.from(t.tweetIdHash)) : null,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return send(connection, [ix], [launchAuthority, mint], 400_000);
}

async function handle(ticketKey: PublicKey) {
  const key = ticketKey.toBase58();
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    let t = await program.account.launchTicket.fetchNullable(ticketKey);
    if (!t) return;
    const args = await recoverArgs(ticketKey);
    const d = decide(await evaluate(ticketKey, t, args));
    if (d.action === "reject") return refund(ticketKey, t, d.reason);
    if (d.action !== "schedule") return log(`${d.action} ${key}: ${d.reason}`);

    // Off-chain checks (BACKEND_SPEC §1.2 items 3-4), before the delay.
    const offChain =
      (process.env.SKIP_METADATA_FETCH === "1" ? null : await checkMetadataUri(args!.uri)) ??
      (args!.tweetId === null ? null : await verifyTweet(args!.tweetId, args!.symbol, { bearer: process.env.X_BEARER_TOKEN }));
    if (offChain) return refund(ticketKey, t, offChain);

    const delay = NO_DELAY ? 0 : randomDelayMs();
    log(`schedule ${key} $${args!.symbol} in ${delay} ms`);
    await sleep(delay);

    // Same mint keypair across retries: if an earlier send landed, the ticket is closed.
    const mint = Keypair.generate();
    for (let attempt = 1; ; attempt++) {
      t = await program.account.launchTicket.fetchNullable(ticketKey);
      if (!t) return log(`done ${key} (ticket closed)`);
      const again = decide(await evaluate(ticketKey, t, args));
      if (again.action === "reject") return refund(ticketKey, t, again.reason);
      if (again.action === "abandon") return log(`abandon ${key}: ${again.reason}`);
      if (again.action === "wait") {
        await sleep(5_000);
        continue;
      }
      try {
        const sig = await sendCreate(ticketKey, t, args!, mint);
        return log(`created ${mint.publicKey.toBase58()} $${args!.symbol} for ${key}: ${sig}`);
      } catch (e) {
        const name = anchorErrorName(e);
        if (!(await connection.getAccountInfo(ticketKey))) return log(`done ${key} (landed on an earlier attempt)`);
        if (name && TERMINAL.has(name)) return refund(ticketKey, t, name);
        log(`create ${key} attempt ${attempt} failed: ${name ?? (e as Error).message}`);
        await sleep(Math.min(2_000 * attempt, 10_000));
      }
    }
  } catch (e) {
    log(`error on ${key}: ${(e as Error).message}`);
  } finally {
    inFlight.delete(key);
  }
}

async function pollOnce() {
  const tickets = await program.account.launchTicket.all();
  await Promise.all(tickets.map((t) => handle(t.publicKey)));
}

async function main() {
  if (NO_DELAY && cluster() === "mainnet-beta") throw new Error("DISABLE_DELAY is not allowed on mainnet-beta");
  const g = await program.account.global.fetch(pdas.global());
  if (!g.launchAuthority.equals(launchAuthority.publicKey)) {
    throw new Error(`LAUNCH_AUTHORITY_KEYPAIR is ${launchAuthority.publicKey.toBase58()}, but Global.launch_authority is ${g.launchAuthority.toBase58()}`);
  }
  log(`launch worker on ${cluster()} as ${launchAuthority.publicKey.toBase58()} (expiry margin ${EXPIRY_MARGIN_SECONDS}s)`);

  if (process.argv.includes("--once")) {
    await pollOnce();
    return;
  }

  const parser = new EventParser(program.programId, coder);
  connection.onLogs(
    program.programId,
    (l) => {
      if (l.err) return;
      for (const ev of parser.parseLogs(l.logs)) {
        if (ev.name.toLowerCase() !== "launchrequested") continue;
        const ticket = (ev.data as { ticket: PublicKey }).ticket;
        sigHint.set(ticket.toBase58(), l.signature);
        void handle(ticket);
      }
    },
    "confirmed",
  );
  for (;;) {
    await pollOnce().catch((e) => log(`poll failed: ${(e as Error).message}`));
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Minimal launch worker (docs/BACKEND_SPEC.md §1).
 *
 *   LaunchRequested event / LaunchTicket account
 *     -> validate (pause, metadata commitment, ticker/name/tweet locks,
 *        optional metadata URI fetch and X API tweet check)
 *     -> reject: refund_ticket now (launch authority; funds go to the payer)
 *     -> a metadata / X API failure that may pass (timeout, 429, 5xx):
 *        retried until the ticket nears expiry, then refunded
 *     -> a ticket that can't be created before expiry (paused, found late):
 *        refunded, never left for the payer to recover by hand
 *     -> otherwise wait a CSPRNG-uniform 3-15 s
 *     -> re-validate, then send `create` co-signed by the launch authority and
 *        a fresh in-memory mint keypair.
 *
 * Name/symbol/URI aren't stored on the ticket (only their commitment), so the
 * worker recovers them from the user's request_launch transaction and checks
 * them against `metadata_hash` before using them. The ticket handling itself
 * is `src/launchWorkerRunner.ts` (also driven by `test_devnet_e2e.ts`).
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
import { cluster, roles } from "./src/config";
import { EXPIRY_MARGIN_SECONDS } from "./src/launchWorker";
import { createLaunchWorker } from "./src/launchWorkerRunner";
import { connect } from "./src/program";

const POLL_MS = Number(process.env.POLL_MS ?? "30000");
const NO_DELAY = process.env.DISABLE_DELAY === "1";
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (NO_DELAY && cluster() === "mainnet-beta") throw new Error("DISABLE_DELAY is not allowed on mainnet-beta");
  const { launchAuthority } = roles();
  const { connection, program, pdas } = connect(launchAuthority);
  const g = await program.account.global.fetch(pdas.global());
  if (!g.launchAuthority.equals(launchAuthority.publicKey)) {
    throw new Error(`LAUNCH_AUTHORITY_KEYPAIR is ${launchAuthority.publicKey.toBase58()}, but Global.launch_authority is ${g.launchAuthority.toBase58()}`);
  }
  const worker = createLaunchWorker({
    connection,
    program,
    pdas,
    launchAuthority,
    skipMetadataFetch: process.env.SKIP_METADATA_FETCH === "1",
    xBearerToken: process.env.X_BEARER_TOKEN,
    ...(NO_DELAY ? { delayMs: () => 0 } : {}),
    log,
  });
  log(`launch worker on ${cluster()} as ${launchAuthority.publicKey.toBase58()} (expiry margin ${EXPIRY_MARGIN_SECONDS}s)`);

  if (process.argv.includes("--once")) {
    await worker.pollOnce();
    return;
  }

  worker.listen();
  // Passes don't wait for each other: a ticket still retrying its checks (or waiting out a pause) never holds up the
  // next pass's discovery of new tickets. `handle` skips a ticket already in flight.
  for (;;) {
    void worker.pollOnce().catch((e) => log(`poll failed: ${(e as Error).message}`));
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

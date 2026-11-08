/**
 * Runs the indexer and its API. Settings (environment):
 *   RPC_URL            Solana JSON-RPC (required). Use a provider that allows getProgramAccounts.
 *   RPC_WS_URL         its websocket for logsSubscribe; default: RPC_URL with ws(s):// (port +1 on localhost:8899);
 *                      "off" disables it (the poller alone then sets the latency, POLL_MS)
 *   PROGRAM_ID         default: the committed IDL's address
 *   PORT, HOST         default 8790, 0.0.0.0
 *   ALLOWED_ORIGINS    comma-separated origins for CORS and the stream; unset allows any (the data is public)
 *   METADATA_ORIGINS   comma-separated origins the metadata JSON may be fetched from (e.g. the media CDN); unset: none
 *   BACKFILL_LIMIT     program transactions read on start (default 1000)
 *   POLL_MS, CURVES_MS, TICKETS_MS, HOLDERS_MS   cadences (default 3000, 30000, 15000, 120000)
 *   REWARDS_BASE_URL   where epoch-<n>.json snapshot artifacts are served (scripts/src/snapshot.ts, callerEpoch.ts);
 *                      unset, reward epochs are listed but no allocations are served
 *   REWARDS_MS         reward-epoch sync cadence (default 60000)
 *   RPC_REQUESTS_PER_MINUTE          per-IP limit on requests that reach the RPC (default 60)
 *   TRUST_PROXY=1      take the client IP from X-Forwarded-For
 */
import { createServer } from "node:http";
import { Api } from "./api";
import { Indexer } from "./indexer";
import { Rpc } from "./rpc";

const env = process.env;
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

export function wsUrlFor(rpcUrl: string): string {
  const u = new URL(rpcUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === "8899") u.port = "8900";
  return u.href;
}

async function main() {
  const rpcUrl = env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL is required");
  const ix = new Indexer({
    rpc: new Rpc(rpcUrl),
    programId: env.PROGRAM_ID || undefined,
    backfillLimit: num(env.BACKFILL_LIMIT, 1000),
    metadataOrigins: list(env.METADATA_ORIGINS),
    rewardsBaseUrl: env.REWARDS_BASE_URL || undefined,
    log,
  });
  for (let delay = 2_000; ; delay = Math.min(delay * 2, 60_000)) {
    try {
      await ix.start();
      break;
    } catch (e) {
      log(`first load failed (${(e as Error).message}); retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  const every = (ms: number, name: string, f: () => Promise<unknown>) =>
    setInterval(() => f().catch((e: Error) => log(`${name}: ${e.message}`)), ms);
  every(num(env.POLL_MS, 3_000), "poll", () => ix.pollTransactions());
  every(num(env.CURVES_MS, 30_000), "curves", () => ix.syncCurves());
  every(num(env.TICKETS_MS, 15_000), "tickets", () => ix.syncTickets());
  every(num(env.HOLDERS_MS, 120_000), "holders", () => ix.syncHolderCounts());
  every(300_000, "global", () => ix.syncGlobal());
  every(num(env.REWARDS_MS, 60_000), "rewards", () => ix.syncRewards());
  if (env.RPC_WS_URL !== "off") ix.subscribe(env.RPC_WS_URL || wsUrlFor(rpcUrl));

  const api = new Api(ix, { allowedOrigins: list(env.ALLOWED_ORIGINS), rpcRequestsPerMinute: num(env.RPC_REQUESTS_PER_MINUTE, 60), trustProxy: env.TRUST_PROXY === "1" });
  const port = num(env.PORT, 8790);
  api.attach(createServer()).listen(port, env.HOST || "0.0.0.0", () => log(`parabull-indexer listening on :${port}`));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error(e);
  process.exit(1);
});

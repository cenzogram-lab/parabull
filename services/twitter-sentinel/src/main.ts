/** Starts the sentinel: reads its config, signs in to each X account, watches every configured coin, serves the API. */
import { readFileSync } from "node:fs";
import { Connection } from "@solana/web3.js";
import { Chain } from "./chain";
import { Sentinel } from "./sentinel";
import { createApi } from "./server";
import { Store } from "./store";
import { CookieX, DryRunX, type XAccount, type XClient } from "./x";

const env = process.env;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

const config = {
  port: num(env.SENTINEL_PORT, 8787),
  rpcUrl: env.SENTINEL_RPC_URL ?? "https://api.devnet.solana.com",
  dataDir: env.SENTINEL_DATA_DIR ?? new URL("../data", import.meta.url).pathname,
  accountsFile: env.SENTINEL_ACCOUNTS ?? new URL("../accounts.json", import.meta.url).pathname,
  /** Posts are only logged unless this is "0". */
  dryRun: env.SENTINEL_DRY_RUN !== "0",
  siteUrl: (env.SENTINEL_SITE_URL ?? "").replace(/\/$/, ""),
  allowedOrigins: (env.SENTINEL_ALLOWED_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
  curvePollSeconds: num(env.SENTINEL_CURVE_POLL_SECONDS, 60),
  mentionPollSeconds: num(env.SENTINEL_MENTION_POLL_SECONDS, 180),
};

/** accounts.json: { "<mint>": { "username", "authToken", "ct0", "guestId"? } }. Operator-managed; never sent by the app. */
function loadAccounts(): Record<string, XAccount> {
  try {
    return JSON.parse(readFileSync(config.accountsFile, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return {};
  }
}

const accounts = loadAccounts();
const clients = new Map<string, XClient>();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
function xFor(mint: string): XClient | null {
  const acct = accounts[mint];
  if (!acct?.username) return null;
  const key = acct.username.toLowerCase();
  let client = clients.get(key);
  if (!client) {
    client = config.dryRun ? new DryRunX(acct.username.replace(/^@/, ""), log) : new CookieX(acct);
    clients.set(key, client);
  }
  return client;
}

const store = new Store(config.dataDir);
const chain = new Chain(new Connection(config.rpcUrl, "confirmed"));
const sentinel = new Sentinel({ store, chain, xFor, coinUrl: (mint) => (config.siteUrl ? `${config.siteUrl}/coin/${mint}` : ""), log });
const api = createApi({ store, chain, sentinel, xFor, allowedOrigins: config.allowedOrigins });

for (const mint of store.mints()) sentinel.watch(mint);
const curveTimer = setInterval(() => void sentinel.tick(), config.curvePollSeconds * 1000);
const mentionTimer = setInterval(() => void sentinel.tickMentions(), config.mentionPollSeconds * 1000);
void sentinel.tick();

api.listen(config.port, () => log(`X sentinel on :${config.port} (${config.dryRun ? "dry run: posts are logged, not sent" : "live"}), ${store.mints().length} coin(s), ${Object.keys(accounts).length} X account(s), RPC ${config.rpcUrl}`));

const stop = () => {
  clearInterval(curveTimer);
  clearInterval(mentionTimer);
  sentinel.stop();
  api.close(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/**
 * HTTP API for the app's X automation modal:
 *   GET    /health
 *   GET    /api/sentinel/:mint/settings   status and settings; never any session cookies
 *   PUT    /api/sentinel/:mint/settings   settings, and optionally a new X session, signed by the coin's creator
 *   DELETE /api/sentinel/:mint/settings   stop watching the coin and forget its session, signed by the creator
 * Writes are signed requests (app/src/lib/sentinelMessage.ts), checked against the curve's on-chain creator.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PublicKey } from "@solana/web3.js";
import { DEFAULT_SETTINGS, type SentinelStatus } from "../../../app/src/lib/sentinelMessage";
import { AccountError, type XRegistry } from "./accounts";
import { verifySignedDisconnect, verifySignedSettings } from "./auth";
import type { ChainSource } from "./chain";
import type { Sentinel } from "./sentinel";
import type { Store } from "./store";

export interface ServerDeps {
  store: Store;
  chain: ChainSource;
  sentinel: Sentinel;
  accounts: XRegistry;
  /** Posts are logged, not sent. */
  dryRun: boolean;
  /** Origins allowed to call the API from a browser; ["*"] allows any. */
  allowedOrigins: string[];
  now?: () => number;
  log?: (line: string) => void;
}

const MAX_BODY = 16 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("body must be JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function validMint(s: string) {
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

export function createApi(deps: ServerDeps): Server {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const status = (mint: string): SentinelStatus => {
    const rec = deps.store.get(mint);
    const source = deps.accounts.source(mint);
    const username = source === "creator" ? rec!.session!.username : source === "operator" ? deps.accounts.for(mint)?.username : undefined;
    return {
      mint,
      mode: deps.dryRun ? "dry-run" : "live",
      account: source && username ? { username, source, linkedAt: source === "creator" ? rec!.session!.linkedAt : null } : null,
      active: !!rec,
      settings: rec?.settings ?? null,
      updatedAt: rec?.updatedAt ?? null,
    };
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && (deps.allowedOrigins.includes("*") || deps.allowedOrigins.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "OPTIONS") return void res.writeHead(204).end();
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") return send(200, { ok: true });
      const m = /^\/api\/sentinel\/([^/]+)\/settings$/.exec(url.pathname);
      if (!m) return send(404, { error: "not found" });
      const mint = m[1];
      if (!validMint(mint)) return send(400, { error: "not a mint address" });
      if (req.method === "GET") return send(200, status(mint));
      if (req.method !== "PUT" && req.method !== "DELETE") return send(405, { error: "method not allowed" });

      const body = await readBody(req);
      const curve = await deps.chain.curve(mint);
      if (!curve) return send(404, { error: "no Parabull bonding curve for this mint" });

      if (req.method === "DELETE") {
        const auth = verifySignedDisconnect(body, mint, curve.creator, now(), deps.store.lastIssued(mint));
        if (!auth.ok) return send(auth.status, { error: auth.error });
        deps.sentinel.forget(mint);
        deps.store.remove(mint, auth.issuedAtMs);
        deps.accounts.invalidate(mint);
        log(`[${mint}] disconnected by the creator: watching stopped, session forgotten`);
        return send(200, status(mint));
      }

      const auth = verifySignedSettings(body, mint, curve.creator, now(), deps.store.lastIssued(mint));
      if (!auth.ok) return send(auth.status, { error: auth.error });
      // Checked with X before anything is saved, so a bad session never replaces a working one.
      const linked = auth.session ? await deps.accounts.prepare(mint, auth.session) : null;
      const prev = deps.store.get(mint);
      deps.store.update(
        mint,
        (r) => ({
          ...(r ?? { settings: DEFAULT_SETTINGS, milestonesDone: null, watchingSince: now(), replied: [], lastByAuthor: {}, recentReplies: [], updatedAt: "" }),
          settings: auth.settings,
          updatedAt: new Date(now()).toISOString(),
          ...(linked ? { session: { username: linked.username, sealed: linked.sealed, linkedAt: new Date(now()).toISOString() } } : {}),
        }),
        auth.issuedAtMs,
      );
      // Hot reload: the new settings are read on the next update; a new session swaps the client in place.
      if (linked) deps.accounts.invalidate(mint);
      if (!prev) deps.sentinel.watch(mint);
      await deps.sentinel.onCurve(mint, curve);
      return send(200, status(mint));
    } catch (e) {
      if (e instanceof AccountError) return send(e.status, { error: e.message });
      const code = (e as { status?: number }).status ?? 500;
      if (code === 500) log(`API error: ${e instanceof Error ? e.message : String(e)}`);
      return send(code, { error: code === 500 ? "the sentinel hit an error; see its log" : (e as Error).message });
    }
  });
}

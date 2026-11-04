/**
 * HTTP API for the app's X automation modal:
 *   GET  /health
 *   GET  /api/sentinel/:mint   status and settings (never any credentials)
 *   PUT  /api/sentinel/:mint   settings signed by the coin's creator (see app/src/lib/sentinelMessage.ts)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PublicKey } from "@solana/web3.js";
import { DEFAULT_SETTINGS, type SentinelStatus } from "../../../app/src/lib/sentinelMessage";
import { verifySignedSettings } from "./auth";
import type { ChainSource } from "./chain";
import type { Sentinel } from "./sentinel";
import type { Store } from "./store";
import type { XClient } from "./x";

export interface ServerDeps {
  store: Store;
  chain: ChainSource;
  sentinel: Sentinel;
  xFor: (mint: string) => XClient | null;
  /** Origins allowed to call the API from a browser; ["*"] allows any. */
  allowedOrigins: string[];
  now?: () => number;
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
  const status = (mint: string): SentinelStatus => {
    const rec = deps.store.get(mint);
    const x = deps.xFor(mint);
    return { mint, mode: x?.live ? "live" : "dry-run", account: x ? { username: x.username } : null, settings: rec?.settings ?? null, updatedAt: rec?.updatedAt ?? null };
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && (deps.allowedOrigins.includes("*") || deps.allowedOrigins.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
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
      const m = /^\/api\/sentinel\/([^/]+)$/.exec(url.pathname);
      if (!m) return send(404, { error: "not found" });
      const mint = m[1];
      if (!validMint(mint)) return send(400, { error: "not a mint address" });
      if (req.method === "GET") return send(200, status(mint));
      if (req.method !== "PUT") return send(405, { error: "method not allowed" });

      const body = await readBody(req);
      const curve = await deps.chain.curve(mint);
      if (!curve) return send(404, { error: "no Parabull bonding curve for this mint" });
      const prev = deps.store.get(mint);
      const auth = verifySignedSettings(body, mint, curve.creator, now(), prev?.lastIssuedAtMs ?? null);
      if (!auth.ok) return send(auth.status, { error: auth.error });
      deps.store.update(mint, (r) => ({
        ...(r ?? { settings: DEFAULT_SETTINGS, milestonesDone: null, watchingSince: now(), replied: [], lastByAuthor: {}, recentReplies: [], updatedAt: "", lastIssuedAtMs: 0 }),
        settings: auth.settings,
        updatedAt: new Date(now()).toISOString(),
        lastIssuedAtMs: auth.issuedAtMs,
      }));
      if (!prev) deps.sentinel.watch(mint);
      await deps.sentinel.onCurve(mint, curve);
      return send(200, status(mint));
    } catch (e) {
      const code = (e as { status?: number }).status ?? 500;
      return send(code, { error: code === 500 ? "the sentinel hit an error; see its log" : (e as Error).message });
    }
  });
}

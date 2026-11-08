/**
 * parabull-edge request routing (src/index.ts is the Worker entry). No Internet Computer canister stores or serves
 * media or chat: the browser talks to this Worker, its R2 bucket and its ChatRoom Durable Objects directly.
 *
 *   POST    /metadata      coin logo + metadata JSON into R2, returns { uri } (src/metadata.ts)
 *   POST    /chat/session  wallet-signed sign-in, returns a chat session token (src/session.ts)
 *   POST    /chat/upload   a chat image or GIF into R2 (Bearer session token), returns { url }
 *   GET     /chat/:mint    websocket into that coin's ChatRoom (src/chatRoom.ts)
 *   GET     /live          coins streaming now on Cloudflare Stream, with their HLS URLs (src/live.ts)
 *   POST    /live/input    the coin creator's Stream live input: RTMPS / SRT stream keys (src/broadcast.ts)
 *   GET     /callouts      callouts, newest first (mint= / author= / ids= / before=), src/callouts.ts
 *   POST    /callouts      a callout on a coin the signed-in wallet holds (Bearer session token)
 *   GET     /callouts/:id  one callout
 *   OPTIONS               CORS preflight for the POST routes
 *   GET     /health        "ok"
 *
 * Fails closed: a request from an origin outside ALLOWED_ORIGINS (or with none) is refused before anything is read,
 * as are oversized bodies, an unconfigured MEDIA_PUBLIC_URL or CHAT_SECRET, and rate-limited callers.
 */
import { isAddress } from "../../../app/src/lib/chatMessage";
import { allowedOrigins, cors, json, preflight, readJson } from "./http";
import { MAX_IMAGE_BYTES, MAX_REQUEST_BYTES, publicBase, putOnce, sha256Hex, sniffImage, storeMetadata, type MediaBucket } from "./metadata";
import type { BroadcastEnv, BroadcastResult } from "./broadcast";
import { LIVE_INPUT_PATH, LIVE_INPUT_ROOM } from "./chatRoom";
import { liveStreams } from "./live";
import { createSession, verifyToken } from "./session";
import { CALLOUT_STORE, checkCallout, type CalloutEnv } from "./callouts";
import { isCalloutId, normalizeCalloutText } from "../../../app/src/lib/callouts";

/** Cloudflare's rate limiting binding ([[ratelimits]] in wrangler.toml). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The parts of a Durable Object namespace binding the router uses. */
export interface ChatNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface Env extends BroadcastEnv, CalloutEnv {
  /** R2 bucket, public through a custom domain (MEDIA_PUBLIC_URL). */
  MEDIA: MediaBucket;
  /** https base the bucket is served from, e.g. https://media.parabull.xyz. */
  MEDIA_PUBLIC_URL: string;
  /** Comma-separated origins allowed to call the Worker: the app's canister URL and custom domain. */
  ALLOWED_ORIGINS: string;
  /** Optional per-IP limit on metadata uploads; without it, rely on a WAF rate-limiting rule. */
  UPLOAD_LIMITER?: RateLimiter;
  /** One ChatRoom Durable Object per coin mint. */
  CHAT_ROOMS?: ChatNamespace;
  /** HMAC key for chat session tokens (wrangler secret put CHAT_SECRET), at least 32 characters. */
  CHAT_SECRET?: string;
  /** Optional per-IP limit on chat sign-ins and uploads. */
  CHAT_LIMITER?: RateLimiter;
  /**
   * Optional per-IP limit on chat socket handshakes. Origin can be spoofed outside a browser, so this is what bounds
   * how many rooms one client can open; rooms allocate storage only when a signed-in wallet posts.
   */
  CHAT_CONNECT_LIMITER?: RateLimiter;
  /** The one CalloutStore Durable Object (named CALLOUT_STORE): callouts in SQLite. */
  CALLOUTS?: ChatNamespace;
  /** Per-IP limit on callout reads, which all reach that one object. */
  CALLOUT_READ_LIMITER?: RateLimiter;
}

async function limited(limiter: RateLimiter | undefined, request: Request, scope: string): Promise<boolean> {
  if (!limiter) return false;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key: `${scope}:${ip}` });
  return !success;
}

async function metadataRoute(request: Request, env: Env, allow: Record<string, string>): Promise<Response> {
  const base = publicBase(env.MEDIA_PUBLIC_URL);
  if (!base) return json(500, { error: "MEDIA_PUBLIC_URL is not configured" }, allow);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return json(415, { error: "send multipart/form-data" }, allow);
  const length = Number(request.headers.get("content-length"));
  if (!request.headers.has("content-length") || !Number.isFinite(length)) return json(411, { error: "content-length is required" }, allow);
  if (length > MAX_REQUEST_BYTES) return json(413, { error: `request is larger than ${MAX_REQUEST_BYTES} bytes` }, allow);
  if (await limited(env.UPLOAD_LIMITER, request, "metadata")) return json(429, { error: "too many uploads, try again in a minute" }, { ...allow, "retry-after": "60" });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { error: "body is not valid multipart/form-data" }, allow);
  }
  const result = await storeMetadata(form, env.MEDIA, base);
  return result.ok ? json(200, { uri: result.uri, image: result.image }, allow) : json(result.status, { error: result.error }, allow);
}

async function sessionRoute(request: Request, env: Env, allow: Record<string, string>, now: number): Promise<Response> {
  if (await limited(env.CHAT_LIMITER, request, "chat-session")) return json(429, { error: "too many sign-ins, try again in a minute" }, { ...allow, "retry-after": "60" });
  const body = await readJson(request, 2_048);
  if (body === null) return json(400, { error: "expected a small JSON body" }, allow);
  const result = await createSession(body, env.CHAT_SECRET, now);
  return result.ok ? json(200, result.value, allow) : json(result.status, { error: result.error }, allow);
}

/** A chat image or GIF, stored like coin logos: `img/<sha256>.<ext>`, written once. Needs a session token. */
async function uploadRoute(request: Request, env: Env, allow: Record<string, string>, now: number): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const session = auth.startsWith("Bearer ") ? await verifyToken(env.CHAT_SECRET, auth.slice(7), now) : null;
  if (!session) return json(401, { error: "sign in to chat first" }, allow);
  const base = publicBase(env.MEDIA_PUBLIC_URL);
  if (!base) return json(500, { error: "MEDIA_PUBLIC_URL is not configured" }, allow);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return json(415, { error: "send multipart/form-data" }, allow);
  const length = Number(request.headers.get("content-length"));
  if (!request.headers.has("content-length") || !Number.isFinite(length)) return json(411, { error: "content-length is required" }, allow);
  if (length > MAX_REQUEST_BYTES) return json(413, { error: `request is larger than ${MAX_REQUEST_BYTES} bytes` }, allow);
  // Keyed by IP (as sign-ins are), so switching between wallets doesn't buy more uploads.
  if (await limited(env.CHAT_LIMITER, request, "chat-upload")) return json(429, { error: "too many uploads, try again in a minute" }, { ...allow, "retry-after": "60" });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { error: "body is not valid multipart/form-data" }, allow);
  }
  const file = form.get("image");
  if (typeof file !== "object" || file === null || typeof (file as Blob).arrayBuffer !== "function") return json(400, { error: "image file is required" }, allow);
  if ((file as Blob).size > MAX_IMAGE_BYTES) return json(413, { error: `image is larger than ${MAX_IMAGE_BYTES} bytes` }, allow);
  const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
  const type = bytes.length ? sniffImage(bytes) : null;
  if (!type) return json(415, { error: "image must be a PNG, JPEG, WebP or GIF" }, allow);
  const key = `img/${await sha256Hex(bytes)}.${type.ext}`;
  await putOnce(env.MEDIA, key, bytes, type.mime);
  return json(200, { url: `${base}/${key}` }, allow);
}

/**
 * GET /callouts, GET /callouts/:id and POST /callouts. Reads go straight to the store; a post is checked first
 * (session, per-IP limit, text, the wallet's holding and the coin's market cap) and the store applies the per-wallet
 * limits.
 */
async function calloutsRoute(request: Request, env: Env, allow: Record<string, string>, origin: string, pathname: string, now: number, fetchImpl: typeof fetch): Promise<Response> {
  const one = pathname.startsWith("/callouts/") ? pathname.slice("/callouts/".length) : null;
  if (request.method === "OPTIONS") return preflight(origin, one === null ? "GET, POST" : "GET", "authorization, content-type");
  if (!env.CALLOUTS) return json(503, { error: "callouts are not configured" }, allow);
  const store = env.CALLOUTS.get(env.CALLOUTS.idFromName(CALLOUT_STORE));
  const forward = async (r: Request, headers: Record<string, string> = {}) => {
    const res = await store.fetch(r);
    const body = (await res.json()) as { ok: boolean; body?: unknown; error?: string };
    return body.ok ? json(res.status, body.body, { ...allow, ...headers }) : json(res.status, { error: body.error }, allow);
  };
  if (request.method === "GET") {
    if (await limited(env.CALLOUT_READ_LIMITER, request, "callout-read")) return json(429, { error: "too many requests, try again in a minute" }, { ...allow, "retry-after": "60" });
    if (one !== null) return isCalloutId(one) ? forward(new Request(`https://store/get?id=${one}`), { "cache-control": "public, max-age=30" }) : json(400, { error: "not a callout id" }, allow);
    return forward(new Request(`https://store/list${new URL(request.url).search}`), { "cache-control": "public, max-age=5" });
  }
  if (request.method !== "POST" || one !== null) return json(405, { error: "method not allowed" }, { ...allow, allow: one === null ? "GET, POST, OPTIONS" : "GET, OPTIONS" });
  const auth = request.headers.get("authorization") ?? "";
  const session = auth.startsWith("Bearer ") ? await verifyToken(env.CHAT_SECRET, auth.slice(7), now) : null;
  if (!session) return json(401, { error: "sign in with your wallet first" }, allow);
  if (await limited(env.CHAT_LIMITER, request, "callout")) return json(429, { error: "too many requests, try again in a minute" }, { ...allow, "retry-after": "60" });
  const body = await readJson(request, 4_096);
  if (body === null) return json(400, { error: "expected a small JSON body" }, allow);
  const { mint, text: raw } = body as { mint?: unknown; text?: unknown };
  if (!isAddress(mint)) return json(400, { error: "mint must be a Solana address" }, allow);
  const text = normalizeCalloutText(raw);
  if (!text) return json(400, { error: "write 1-280 characters" }, allow);
  const checked = await checkCallout(env, session.wallet, mint, text, fetchImpl);
  if (!checked.ok) return json(checked.status, { error: checked.error }, allow);
  return forward(new Request("https://store/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(checked.callout) }));
}

/** `fetchImpl` reaches the Stream API and lifecycle endpoints (tests and the local harness pass a stand-in). */
export async function handle(request: Request, env: Env, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/health" && request.method === "GET") return new Response("ok", { headers: { "cache-control": "no-store" } });
  const route =
    pathname === "/live/input" ? "broadcast"
    : pathname === "/live" ? "live"
    : pathname === "/metadata" ? "metadata"
    : pathname === "/chat/session" ? "session"
    : pathname === "/chat/upload" ? "upload"
    : /^\/chat\/[^/]+$/.test(pathname) ? "room"
    : pathname === "/callouts" || /^\/callouts\/[^/]+$/.test(pathname) ? "callouts"
    : null;
  if (!route) return json(404, { error: "not found" });

  const origin = request.headers.get("origin") ?? "";
  if (!allowedOrigins(env.ALLOWED_ORIGINS).has(origin)) return json(403, { error: "origin not allowed" });
  const allow = cors(origin);

  if (route === "live") {
    if (request.method === "OPTIONS") return preflight(origin, "GET");
    if (request.method !== "GET") return json(405, { error: "method not allowed" }, { ...allow, allow: "GET, OPTIONS" });
    const result = await liveStreams(env, now, fetchImpl);
    // Short shared caching: every viewer of /live polls this, and the Worker caches the upstream answer too.
    return result.ok ? json(200, { streams: result.streams }, { ...allow, "cache-control": "public, max-age=15" }) : json(result.status, { error: result.error, streams: [] }, allow);
  }

  if (route === "callouts") return calloutsRoute(request, env, allow, origin, pathname, now, fetchImpl);

  if (route === "broadcast") {
    if (request.method === "OPTIONS") return preflight(origin, "POST", "authorization, content-type");
    if (request.method !== "POST") return json(405, { error: "method not allowed" }, { ...allow, allow: "POST, OPTIONS" });
    const auth = request.headers.get("authorization") ?? "";
    const session = auth.startsWith("Bearer ") ? await verifyToken(env.CHAT_SECRET, auth.slice(7), now) : null;
    if (!session) return json(401, { error: "sign in with your wallet first" }, allow);
    if (await limited(env.CHAT_LIMITER, request, "live-input")) return json(429, { error: "too many requests, try again in a minute" }, { ...allow, "retry-after": "60" });
    const body = await readJson(request, 1_024);
    if (body === null) return json(400, { error: "expected a small JSON body" }, allow);
    const mint = (body as { mint?: unknown }).mint;
    if (!isAddress(mint)) return json(400, { error: "mint must be a Solana address" }, allow);
    // One object runs these one at a time: racing requests must not create two inputs for a coin, or pass the cap.
    if (!env.CHAT_ROOMS) return json(503, { error: "going live is not configured" }, allow);
    const room = env.CHAT_ROOMS.get(env.CHAT_ROOMS.idFromName(LIVE_INPUT_ROOM));
    const forwarded = await room.fetch(new Request(`https://room${LIVE_INPUT_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: session.wallet, body }) }));
    const result = (await forwarded.json()) as BroadcastResult;
    // Carries the stream key: never cached anywhere.
    return result.ok ? json(200, result.value, allow) : json(result.status, { error: result.error }, allow);
  }

  if (route === "room") {
    // Browsers send Origin on websocket upgrades, so the check above also stops cross-site socket hijacking.
    if (request.method !== "GET") return json(405, { error: "method not allowed" }, { ...allow, allow: "GET" });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(426, { error: "expected a websocket upgrade" }, allow);
    const mint = pathname.slice("/chat/".length);
    if (!isAddress(mint)) return json(400, { error: "not a coin mint" }, allow);
    if (!env.CHAT_ROOMS) return json(503, { error: "chat is not configured" }, allow);
    if (await limited(env.CHAT_CONNECT_LIMITER, request, "chat-connect")) return json(429, { error: "too many chat connections, try again in a minute" }, { ...allow, "retry-after": "60" });
    return env.CHAT_ROOMS.get(env.CHAT_ROOMS.idFromName(mint)).fetch(request);
  }

  if (request.method === "OPTIONS") return preflight(origin, "POST", route === "upload" ? "authorization, content-type" : "content-type");
  if (request.method !== "POST") return json(405, { error: "method not allowed" }, { ...allow, allow: "POST, OPTIONS" });
  if (route === "metadata") return metadataRoute(request, env, allow);
  if (route === "session") return sessionRoute(request, env, allow, now);
  return uploadRoute(request, env, allow, now);
}

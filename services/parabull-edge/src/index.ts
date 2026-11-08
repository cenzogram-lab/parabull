/**
 * parabull-edge: the Cloudflare Worker for Parabull media, so no Internet Computer canister stores or serves media.
 *
 *   POST    /metadata  coin logo + metadata JSON into R2, returns { uri } (src/metadata.ts)
 *   OPTIONS /metadata  CORS preflight
 *   GET     /health    "ok"
 *
 * Fails closed: a request from an origin outside ALLOWED_ORIGINS (or with none), a missing or oversized body, an
 * unconfigured MEDIA_PUBLIC_URL, or a rate-limited caller is refused before anything is read or stored.
 */
import { MAX_REQUEST_BYTES, publicBase, storeMetadata, type MediaBucket } from "./metadata";

/** Cloudflare's rate limiting binding ([[ratelimits]] in wrangler.toml). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** R2 bucket, public through a custom domain (MEDIA_PUBLIC_URL). */
  MEDIA: MediaBucket;
  /** https base the bucket is served from, e.g. https://media.parabull.xyz. */
  MEDIA_PUBLIC_URL: string;
  /** Comma-separated origins allowed to upload: the app's canister URL and custom domain. */
  ALLOWED_ORIGINS: string;
  /** Optional per-IP upload limit; without it, rely on a WAF rate-limiting rule. */
  UPLOAD_LIMITER?: RateLimiter;
}

export function allowedOrigins(env: Pick<Env, "ALLOWED_ORIGINS">): Set<string> {
  return new Set(
    (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

function cors(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/health" && request.method === "GET") return new Response("ok", { headers: { "cache-control": "no-store" } });
  if (pathname !== "/metadata") return json(404, { error: "not found" });

  const origin = request.headers.get("origin") ?? "";
  if (!allowedOrigins(env).has(origin)) return json(403, { error: "origin not allowed" });
  const allow = cors(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...allow, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" },
    });
  }
  if (request.method !== "POST") return json(405, { error: "method not allowed" }, { ...allow, allow: "POST, OPTIONS" });

  const base = publicBase(env.MEDIA_PUBLIC_URL);
  if (!base) return json(500, { error: "MEDIA_PUBLIC_URL is not configured" }, allow);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return json(415, { error: "send multipart/form-data" }, allow);
  const length = Number(request.headers.get("content-length"));
  if (!request.headers.has("content-length") || !Number.isFinite(length)) return json(411, { error: "content-length is required" }, allow);
  if (length > MAX_REQUEST_BYTES) return json(413, { error: `request is larger than ${MAX_REQUEST_BYTES} bytes` }, allow);

  if (env.UPLOAD_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.UPLOAD_LIMITER.limit({ key: `metadata:${ip}` });
    if (!success) return json(429, { error: "too many uploads, try again in a minute" }, { ...allow, "retry-after": "60" });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { error: "body is not valid multipart/form-data" }, allow);
  }
  const result = await storeMetadata(form, env.MEDIA, base);
  return result.ok ? json(200, { uri: result.uri, image: result.image }, allow) : json(result.status, { error: result.error }, allow);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env).catch((e) => {
      console.error("parabull-edge:", e);
      return json(500, { error: "internal error" });
    });
  },
};

/** Small HTTP helpers shared by the routes. */

export function cors(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

export function allowedOrigins(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

/** CORS preflight for an allowed origin. */
export function preflight(origin: string, methods: string, headers = "content-type"): Response {
  return new Response(null, { status: 204, headers: { ...cors(origin), "access-control-allow-methods": methods, "access-control-allow-headers": headers, "access-control-max-age": "86400" } });
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function base64ToBytes(s: string): Uint8Array | null {
  if (!B64.test(s) || s.length % 4 !== 0) return null;
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function bytesToBase64Url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

/** Reads a JSON body of at most `max` bytes, or null. */
export async function readJson(request: Request, max: number): Promise<unknown | null> {
  const length = Number(request.headers.get("content-length"));
  if (request.headers.has("content-length") && (!Number.isFinite(length) || length > max)) return null;
  const text = await request.text();
  if (text.length > max) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

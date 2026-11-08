/**
 * Chat sessions. A wallet signs `chatSignInMessage` once (ed25519, the Solana key itself); POST /chat/session checks
 * that signature and returns a session token, an HMAC over the wallet and an expiry keyed by CHAT_SECRET. The
 * ChatRoom checks the token when a socket sends `{type:"auth"}`, so posting needs no signature per message.
 *
 * Token: `<wallet>.<expiresAtMs>.<base64url HMAC-SHA256(CHAT_SECRET, "parabull-chat:v1:<wallet>:<expiresAtMs>")>`.
 * Fails closed: without a CHAT_SECRET of at least 32 characters no session is issued and no token verifies.
 */
import { CHAT_SESSION_MS, CHAT_SIGN_IN_WINDOW_MS, base58Decode, chatSignInMessage, isAddress, type ChatSessionResponse } from "../../../app/src/lib/chatMessage";
import { base64ToBytes, base64UrlToBytes, bytesToBase64Url } from "./http";

export const MIN_SECRET = 32;
const utf8 = new TextEncoder();

export const secretOk = (secret: string | undefined): secret is string => typeof secret === "string" && secret.length >= MIN_SECRET;

/** The ed25519 signature check (WebCrypto, as in Workers and Node 22). */
export async function verifyWalletSignature(wallet: string, message: string, signature: Uint8Array): Promise<boolean> {
  const pub = base58Decode(wallet);
  if (!pub || pub.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, utf8.encode(message));
  } catch {
    return false;
  }
}

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function hmacKey(secret: string): Promise<Key> {
  return crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const tokenPayload = (wallet: string, exp: number) => utf8.encode(`parabull-chat:v1:${wallet}:${exp}`);

export async function issueToken(secret: string, wallet: string, expiresAt: number): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), tokenPayload(wallet, expiresAt)));
  return `${wallet}.${expiresAt}.${bytesToBase64Url(sig)}`;
}

/** The wallet a token is for and when it expires, or null when it is forged, malformed or expired. */
export async function verifyToken(secret: string | undefined, token: string, now: number): Promise<{ wallet: string; expiresAt: number } | null> {
  if (!secretOk(secret) || typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [wallet, expRaw, sigRaw] = parts;
  if (!isAddress(wallet) || !/^\d{1,15}$/.test(expRaw)) return null;
  const expiresAt = Number(expRaw);
  if (expiresAt <= now) return null;
  const sig = base64UrlToBytes(sigRaw);
  if (!sig || sig.length !== 32) return null;
  // crypto.subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, tokenPayload(wallet, expiresAt));
  return ok ? { wallet, expiresAt } : null;
}

export type SessionResult = { ok: true; value: ChatSessionResponse } | { ok: false; status: number; error: string };

/** Checks a POST /chat/session body and issues a token. */
export async function createSession(body: unknown, secret: string | undefined, now: number): Promise<SessionResult> {
  if (!secretOk(secret)) return { ok: false, status: 503, error: "chat sign-in is not configured" };
  if (typeof body !== "object" || body === null) return { ok: false, status: 400, error: "expected a JSON body" };
  const { wallet, issuedAt, nonce, signature } = body as Record<string, unknown>;
  if (!isAddress(wallet)) return { ok: false, status: 400, error: "wallet must be a Solana address" };
  if (typeof issuedAt !== "string" || typeof nonce !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return { ok: false, status: 400, error: "issuedAt and nonce are required" };
  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued) || new Date(issued).toISOString() !== issuedAt) return { ok: false, status: 400, error: "issuedAt must be an ISO timestamp" };
  if (Math.abs(now - issued) > CHAT_SIGN_IN_WINDOW_MS) return { ok: false, status: 401, error: "sign-in expired: check your clock and sign again" };
  const sig = typeof signature === "string" ? base64ToBytes(signature) : null;
  if (!sig) return { ok: false, status: 400, error: "signature must be base64" };
  if (!(await verifyWalletSignature(wallet, chatSignInMessage(wallet, issuedAt, nonce), sig))) return { ok: false, status: 401, error: "signature does not match the wallet" };
  const expiresAt = now + CHAT_SESSION_MS;
  return { ok: true, value: { token: await issueToken(secret, wallet, expiresAt), wallet, expiresAt } };
}

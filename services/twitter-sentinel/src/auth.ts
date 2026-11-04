/**
 * Checks a creator's signed request: valid input, a fresh timestamp newer than the last accepted one, and an ed25519
 * signature by the coin's creator over the action and a SHA-256 of the payload (app/src/lib/sentinelMessage.ts).
 */
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import { normalizeSession, normalizeSettings, sentinelMessage, signedPayloadJson, type SentinelAction, type SentinelSettings, type XSession } from "../../../app/src/lib/sentinelMessage";

export const MAX_SKEW_MS = 5 * 60 * 1000;

export const payloadDigest = (settings: SentinelSettings | null, session: XSession | null) => createHash("sha256").update(signedPayloadJson(settings, session)).digest("hex");

type Fail = { ok: false; status: 400 | 401 | 403 | 409; error: string };
export type UpdateResult = { ok: true; settings: SentinelSettings; session: XSession | null; issuedAtMs: number; signer: string } | Fail;
export type DisconnectResult = { ok: true; issuedAtMs: number; signer: string } | Fail;

/** The error for a request validly signed by someone other than the coin's creator. */
export const NOT_CREATOR: Fail = { ok: false, status: 403, error: "only the coin's creator can change its X automation" };

/**
 * `creator` null skips the creator check: the signature is verified against the wallet the request names, which the
 * caller then compares with the on-chain creator. The server works that way so unsigned, stale, replayed or forged
 * requests are refused before it makes any RPC call.
 */
function checkSignature(action: SentinelAction, b: Record<string, unknown>, mint: string, creator: string | null, now: number, lastIssuedAtMs: number | null, settings: SentinelSettings | null, session: XSession | null): { ok: true; issuedAtMs: number; signer: string } | Fail {
  if (typeof b.issuedAt !== "string" || typeof b.signer !== "string" || typeof b.signature !== "string") return { ok: false, status: 400, error: "issuedAt, signer and signature are required" };
  const issuedAtMs = Date.parse(b.issuedAt);
  if (!Number.isFinite(issuedAtMs) || Math.abs(now - issuedAtMs) > MAX_SKEW_MS) return { ok: false, status: 401, error: "the signature is expired or from the future; sign again" };
  if (lastIssuedAtMs !== null && issuedAtMs <= lastIssuedAtMs) return { ok: false, status: 409, error: "a newer change was already saved; sign again" };
  let signerKey: Uint8Array;
  try {
    signerKey = new PublicKey(b.signer).toBytes();
  } catch {
    return { ok: false, status: 400, error: "signer is not a valid address" };
  }
  if (creator !== null && b.signer !== creator) return NOT_CREATOR;
  const message = new TextEncoder().encode(sentinelMessage(action, mint, b.issuedAt, payloadDigest(settings, session)));
  let valid = false;
  try {
    valid = ed25519.verify(Buffer.from(b.signature, "base64"), message, signerKey);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, status: 401, error: "the signature doesn't match this request" };
  return { ok: true, issuedAtMs, signer: b.signer };
}

/** PUT: settings, and optionally a new X session. */
export function verifySignedSettings(body: unknown, mint: string, creator: string | null, now: number, lastIssuedAtMs: number | null): UpdateResult {
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const settings = normalizeSettings(b.settings);
  if (!settings.ok) return { ok: false, status: 400, error: settings.error };
  let session: XSession | null = null;
  if (b.session !== undefined && b.session !== null) {
    const s = normalizeSession(b.session);
    if (!s.ok) return { ok: false, status: 400, error: s.error };
    session = s.value;
  }
  const sig = checkSignature("update settings", b, mint, creator, now, lastIssuedAtMs, settings.value, session);
  return sig.ok ? { ok: true, settings: settings.value, session, issuedAtMs: sig.issuedAtMs, signer: sig.signer } : sig;
}

/** DELETE: stop watching the coin and forget its X session. */
export function verifySignedDisconnect(body: unknown, mint: string, creator: string | null, now: number, lastIssuedAtMs: number | null): DisconnectResult {
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "body must be a JSON object" };
  return checkSignature("disconnect", body as Record<string, unknown>, mint, creator, now, lastIssuedAtMs, null, null);
}

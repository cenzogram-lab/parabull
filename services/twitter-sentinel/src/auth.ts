/** Checks a creator's signed settings change: valid settings, a fresh timestamp, and an ed25519 signature by the coin's creator. */
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import { canonicalSettingsJson, normalizeSettings, settingsMessage, type SentinelSettings } from "../../../app/src/lib/sentinelMessage";

export const MAX_SKEW_MS = 5 * 60 * 1000;

export const settingsDigest = (s: SentinelSettings) => createHash("sha256").update(canonicalSettingsJson(s)).digest("hex");

export type AuthResult = { ok: true; settings: SentinelSettings; issuedAtMs: number } | { ok: false; status: 400 | 401 | 403 | 409; error: string };

/**
 * `creator` is the coin's creator from its bonding curve. `lastIssuedAtMs` is the timestamp of the last accepted
 * change: a change must be newer, so a signed request can't be replayed.
 */
export function verifySignedSettings(body: unknown, mint: string, creator: string, now: number, lastIssuedAtMs: number | null): AuthResult {
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const norm = normalizeSettings(b.settings);
  if (!norm.ok) return { ok: false, status: 400, error: norm.error };
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
  if (b.signer !== creator) return { ok: false, status: 403, error: "only the coin's creator can change its X automation" };
  const message = new TextEncoder().encode(settingsMessage(mint, b.issuedAt, settingsDigest(norm.value)));
  let valid = false;
  try {
    valid = ed25519.verify(Buffer.from(b.signature, "base64"), message, signerKey);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, status: 401, error: "the signature doesn't match these settings" };
  return { ok: true, settings: norm.value, issuedAtMs };
}

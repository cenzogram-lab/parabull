/**
 * Sealing creator-linked X sessions at rest: AES-256-GCM with a key derived from SENTINEL_SECRET. Without the
 * secret, the sentinel refuses to accept sessions from creators (operator sessions in accounts.json still work).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { XSession } from "../../../app/src/lib/sentinelMessage";

export type Key = Buffer;

export const MIN_SECRET_LENGTH = 32;

/** A 32-byte key from any secret of at least 32 characters. */
export function keyFromSecret(secret: string | undefined): Key | null {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return createHash("sha256").update(`parabull-sentinel:${secret}`).digest();
}

/**
 * Why `SENTINEL_SECRET` can't be used, or null when it's fine or unset. Unset only turns creator sessions off; a value
 * that is set but too short is a mistake, so the service refuses to start instead of quietly running without it.
 */
export function secretProblem(secret: string | undefined): string | null {
  if (secret === undefined || secret === "") return null;
  if (secret.length < MIN_SECRET_LENGTH) return `SENTINEL_SECRET is set but only ${secret.length} characters long; use at least ${MIN_SECRET_LENGTH} random characters (e.g. openssl rand -base64 48), or unset it to turn creator sessions off`;
  return null;
}

/** Base64 of iv (12) || tag (16) || ciphertext. The mint is bound in as associated data, so a sealed session can't be moved to another coin. */
export function seal(key: Key, mint: string, session: XSession): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(mint));
  const data = Buffer.concat([c.update(JSON.stringify(session), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}

export function unseal(key: Key, mint: string, sealed: string): XSession {
  const raw = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(mint));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
}

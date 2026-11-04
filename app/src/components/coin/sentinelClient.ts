/** Client for the X sentinel service (services/twitter-sentinel). The app reads status and sends requests signed by the creator's wallet. */
import { CONFIG } from "../../config";
import { sentinelMessage, signedPayloadJson, type SentinelAction, type SentinelSettings, type SentinelStatus, type SignedDisconnect, type SignedSettings, type XSession } from "../../lib/sentinelMessage";

export const sentinelConfigured = () => !!CONFIG.sentinelUrl;

const endpoint = (mint: string) => `${CONFIG.sentinelUrl}/api/sentinel/${encodeURIComponent(mint)}/settings`;

type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `The sentinel answered ${res.status}`);
  return body as T;
}

export async function fetchSentinelStatus(mint: string, signal?: AbortSignal): Promise<SentinelStatus> {
  return json<SentinelStatus>(await fetch(endpoint(mint), { signal }));
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function sign(action: SentinelAction, mint: string, settings: SentinelSettings | null, session: XSession | null, signMessage: SignMessage) {
  const issuedAt = new Date().toISOString();
  const message = sentinelMessage(action, mint, issuedAt, await sha256Hex(signedPayloadJson(settings, session)));
  return { issuedAt, signature: base64(await signMessage(new TextEncoder().encode(message))) };
}

/** Signs and saves the settings; `session` (already normalized) links or replaces the X account, null keeps the current one. */
export async function saveSentinelSettings(mint: string, settings: SentinelSettings, session: XSession | null, signer: string, signMessage: SignMessage): Promise<SentinelStatus> {
  const { issuedAt, signature } = await sign("update settings", mint, settings, session, signMessage);
  const body: SignedSettings = { settings, ...(session ? { session } : {}), issuedAt, signer, signature };
  return json<SentinelStatus>(await fetch(endpoint(mint), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

/** Signs a disconnect: the sentinel stops watching the coin and forgets its X session. */
export async function disconnectSentinel(mint: string, signer: string, signMessage: SignMessage): Promise<SentinelStatus> {
  const { issuedAt, signature } = await sign("disconnect", mint, null, null, signMessage);
  const body: SignedDisconnect = { issuedAt, signer, signature };
  return json<SentinelStatus>(await fetch(endpoint(mint), { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

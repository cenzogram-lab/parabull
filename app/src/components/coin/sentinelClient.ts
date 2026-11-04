/** Client for the X sentinel service (services/twitter-sentinel). The app only reads status and sends signed settings. */
import { CONFIG } from "../../config";
import { canonicalSettingsJson, settingsMessage, type SentinelSettings, type SentinelStatus, type SignedSettings } from "../../lib/sentinelMessage";

export const sentinelConfigured = () => !!CONFIG.sentinelUrl;

const endpoint = (mint: string) => `${CONFIG.sentinelUrl}/api/sentinel/${encodeURIComponent(mint)}`;

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

/** Signs the settings with the creator's wallet (signMessage) and saves them. */
export async function saveSentinelSettings(mint: string, settings: SentinelSettings, signer: string, signMessage: (message: Uint8Array) => Promise<Uint8Array>): Promise<SentinelStatus> {
  const issuedAt = new Date().toISOString();
  const message = settingsMessage(mint, issuedAt, await sha256Hex(canonicalSettingsJson(settings)));
  const signature = base64(await signMessage(new TextEncoder().encode(message)));
  const body: SignedSettings = { settings, issuedAt, signer, signature };
  return json<SentinelStatus>(await fetch(endpoint(mint), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

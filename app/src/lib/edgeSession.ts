/**
 * The wallet's session with the edge Worker (services/parabull-edge/src/session.ts), shared by the coin chat and
 * going live: the wallet signs the sign-in text once, POST /chat/session returns a token, and both use it. Tokens are
 * kept in memory for this tab only (never in storage), and dropped a minute before they expire.
 */
import { chatSignIn } from "./chatClient";
import type { ChatSessionResponse } from "./chatMessage";

const sessions = new Map<string, ChatSessionResponse>();

export function validSession(wallet: string): ChatSessionResponse | null {
  const s = sessions.get(wallet);
  return s && s.expiresAt - Date.now() > 60_000 ? s : null;
}

/** Forgets a wallet's session (the Worker said it expired or was refused). */
export const dropSession = (wallet: string) => void sessions.delete(wallet);

/** The wallet's session, asking it to sign in first when there is none. Throws with a message to show. */
export async function signInToEdge(sessionUrl: string, wallet: string, signMessage: ((m: Uint8Array) => Promise<Uint8Array>) | undefined): Promise<ChatSessionResponse> {
  const existing = validSession(wallet);
  if (existing) return existing;
  if (!signMessage) throw new Error("This wallet can't sign messages");
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const { message, body } = chatSignIn(wallet, new Date(), nonce);
  const signature = await signMessage(new TextEncoder().encode(message));
  const res = await fetch(sessionUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(signature)) });
  const json = (await res.json().catch(() => ({}))) as Partial<ChatSessionResponse> & { error?: string };
  if (!res.ok || !json.token || json.wallet !== wallet || !json.expiresAt) throw new Error(json.error ? `Sign-in failed: ${json.error}` : `Sign-in failed (${res.status})`);
  const s = { token: json.token, wallet, expiresAt: json.expiresAt };
  sessions.set(wallet, s);
  return s;
}

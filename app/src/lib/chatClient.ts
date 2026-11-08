/**
 * Coin chat client helpers (hooks/useChatRoom.ts): where the edge Worker's routes are for a VITE_CHAT_URL, and the
 * sign-in request a wallet signature turns into. Pure, so they are unit-tested (test/chat.test.ts).
 */
import { chatSignInMessage, type ChatSessionRequest } from "./chatMessage";

export interface ChatEndpoints {
  /** wss://host/chat/<mint> */
  room(mint: string): string;
  session: string;
  upload: string;
  /** GET: coins streaming now (Cloudflare Stream), from the same Worker. */
  live: string;
}

/**
 * VITE_CHAT_URL is the edge Worker's origin, as `wss://edge.example` or `https://edge.example` (a trailing slash or
 * `/chat` is ignored). Null for anything else.
 */
export function chatEndpoints(raw: string | undefined): ChatEndpoints | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const secure = u.protocol === "wss:" || u.protocol === "https:";
  if (!secure && u.protocol !== "ws:" && u.protocol !== "http:") return null;
  const path = u.pathname.replace(/\/+$/, "").replace(/\/chat$/, "");
  const ws = `${secure ? "wss" : "ws"}://${u.host}${path}`;
  const http = `${secure ? "https" : "http"}://${u.host}${path}`;
  return { room: (mint) => `${ws}/chat/${encodeURIComponent(mint)}`, session: `${http}/chat/session`, upload: `${http}/chat/upload`, live: `${http}/live` };
}

export const bytesToBase64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));

/** A fresh sign-in: the text to sign and, given the signature, the POST /chat/session body. */
export function chatSignIn(wallet: string, now: Date, nonceBytes: Uint8Array): { message: string; body: (signature: Uint8Array) => ChatSessionRequest } {
  const issuedAt = now.toISOString();
  const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const message = chatSignInMessage(wallet, issuedAt, nonce);
  return { message, body: (signature) => ({ wallet, issuedAt, nonce, signature: bytesToBase64(signature) }) };
}

/** Reconnect delay after `attempt` failed connections: 1s, 2s, 4s ... up to 30s. */
export const reconnectDelay = (attempt: number) => Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));

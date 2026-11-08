/**
 * Coin chat protocol, shared byte for byte by the app (hooks/useChatRoom.ts) and the edge Worker's ChatRoom Durable
 * Object (services/parabull-edge, which imports this file): the sign-in text a wallet signs, the limits, the
 * validation, and the messages on the socket. Pure: no imports, no browser or Node APIs.
 *
 * Flow: the wallet signs `chatSignInMessage` once; POST /chat/session checks the ed25519 signature and returns an
 * HMAC session token; the socket to GET /chat/:mint reads without one, and posts only after `{type:"auth",token}`.
 */

/** Characters per message (code points, so an emoji counts once). */
export const CHAT_MAX_CHARS = 280;
/** One message per wallet per room this often. */
export const CHAT_COOLDOWN_MS = 2_000;
/** Messages a room keeps and replays to a new reader. */
export const CHAT_HISTORY = 200;
/** Attachments per message. */
export const CHAT_MAX_ATTACHMENTS = 4;
/** How far a sign-in's `Issued` time may be from the server's clock. */
export const CHAT_SIGN_IN_WINDOW_MS = 5 * 60_000;
/** Session tokens last this long; the app signs in again after. */
export const CHAT_SESSION_MS = 24 * 60 * 60_000;
/** Largest frame a client may send (a message plus attachment URLs fits well inside). */
export const CHAT_MAX_FRAME = 4_096;

export type ChatAttachmentKind = "image" | "gif";
export interface ChatAttachment {
  kind: ChatAttachmentKind;
  url: string;
}

export interface ChatMessage {
  id: string;
  mint: string;
  /** Wallet address (base58) that signed in. */
  author: string;
  text: string;
  attachments: ChatAttachment[];
  /** Server time, ms. */
  ts: number;
}

/**
 * Client → room. `cid` on a send is the client's id for it: the room answers that socket alone with
 * `{type:"sent", cid, id}`, or with an error carrying the same `cid`, so a tab never mistakes another tab's message
 * (same wallet, same text) for its own confirmation.
 */
export type ClientFrame = { type: "auth"; token: string } | { type: "signout" } | { type: "send"; text: string; attachments?: string[]; cid?: string };

export type ChatErrorCode = "sign_in_required" | "session_expired" | "rate_limited" | "too_long" | "empty" | "bad_attachment" | "bad_request";

/** Room → client. */
export type ServerFrame =
  | { type: "history"; messages: ChatMessage[] }
  | { type: "message"; message: ChatMessage }
  | { type: "presence"; count: number }
  | { type: "ready"; wallet: string | null }
  | { type: "sent"; cid: string; id: string }
  | { type: "error"; code: ChatErrorCode; error: string; retryAfterMs?: number; cid?: string };

/** A client send id: 1 to 64 of [A-Za-z0-9_-]. */
export const isCid = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/** The text a wallet signs to start a chat session. */
export function chatSignInMessage(wallet: string, issuedAt: string, nonce: string): string {
  return ["Parabull chat sign-in", `Wallet: ${wallet}`, `Issued: ${issuedAt}`, `Nonce: ${nonce}`, "Signing proves you own this wallet. It sends no transaction and costs nothing."].join("\n");
}

/** What POST /chat/session takes. `signature` is base64 of the 64-byte ed25519 signature. */
export interface ChatSessionRequest {
  wallet: string;
  issuedAt: string;
  nonce: string;
  signature: string;
}

export interface ChatSessionResponse {
  token: string;
  wallet: string;
  expiresAt: number;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet) to bytes, or null for anything that isn't. */
export function base58Decode(s: string): Uint8Array | null {
  if (!s || s.length > 64) return null;
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const le: number[] = []; // the value, little-endian bytes
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < le.length; i++) {
      carry += le[i] * 58;
      le[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      le.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + le.length);
  for (let i = 0; i < le.length; i++) out[zeros + i] = le[le.length - 1 - i];
  return out;
}

/** A Solana address (wallet or mint): base58 of exactly 32 bytes. */
export function isAddress(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  return base58Decode(s)?.length === 32;
}

type Check<T> = { ok: true; value: T } | { ok: false; code: ChatErrorCode; error: string };

/** Message text: trimmed, at most CHAT_MAX_CHARS code points, no control characters but newlines, at most 3 blank-line runs collapsed. */
export function checkText(raw: unknown): Check<string> {
  if (typeof raw !== "string") return { ok: false, code: "bad_request", error: "text must be a string" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(raw)) return { ok: false, code: "bad_request", error: "text has control characters" };
  const text = raw.trim().replace(/\n{3,}/g, "\n\n");
  if ([...text].length > CHAT_MAX_CHARS) return { ok: false, code: "too_long", error: `Messages are at most ${CHAT_MAX_CHARS} characters` };
  return { ok: true, value: text };
}

/**
 * An attachment URL must be an image this deployment's media bucket serves: `<mediaBase>/img/<sha256>.<ext>`, as
 * POST /chat/upload and POST /metadata store them. GIFs are `gif`, everything else `image`.
 */
export function checkAttachment(url: unknown, mediaBase: string): ChatAttachment | null {
  if (typeof url !== "string" || !mediaBase) return null;
  const base = mediaBase.replace(/\/+$/, "");
  if (!url.startsWith(`${base}/img/`)) return null;
  const rest = url.slice(base.length);
  const m = /^\/img\/[0-9a-f]{64}\.(png|jpg|webp|gif)$/.exec(rest);
  if (!m) return null;
  return { kind: m[1] === "gif" ? "gif" : "image", url };
}

export function checkAttachments(urls: unknown, mediaBase: string): Check<ChatAttachment[]> {
  if (urls === undefined || urls === null) return { ok: true, value: [] };
  if (!Array.isArray(urls) || urls.length > CHAT_MAX_ATTACHMENTS) return { ok: false, code: "bad_attachment", error: `At most ${CHAT_MAX_ATTACHMENTS} attachments` };
  const out: ChatAttachment[] = [];
  for (const u of urls) {
    const a = checkAttachment(u, mediaBase);
    if (!a) return { ok: false, code: "bad_attachment", error: "Attachments must be images uploaded to Parabull's media storage" };
    if (!out.some((x) => x.url === a.url)) out.push(a);
  }
  return { ok: true, value: out };
}

/** A client frame from raw socket text, or null when it isn't one. */
export function parseClientFrame(raw: unknown): ClientFrame | null {
  if (typeof raw !== "string" || raw.length > CHAT_MAX_FRAME) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const f = v as Record<string, unknown>;
  if (f.type === "auth" && typeof f.token === "string" && f.token.length <= 512) return { type: "auth", token: f.token };
  if (f.type === "signout") return { type: "signout" };
  if (f.type === "send" && typeof f.text === "string") {
    if (f.cid !== undefined && !isCid(f.cid)) return null;
    return { type: "send", text: f.text, attachments: Array.isArray(f.attachments) ? (f.attachments as string[]) : undefined, ...(f.cid !== undefined ? { cid: f.cid as string } : {}) };
  }
  return null;
}

/** A short display name for a wallet: "Abcd…wxyz". */
export const shortWallet = (w: string) => (w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);

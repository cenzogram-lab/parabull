/**
 * One coin's chat room: the logic of the ChatRoom Durable Object (src/chatRoomDO.ts wraps it for the Workers runtime;
 * the tests drive it directly with node:sqlite and fake sockets).
 *
 * - Sockets are accepted through the WebSocket Hibernation API, so an idle room costs nothing: the object can be
 *   evicted between messages. Everything a socket needs after waking (its mint, the signed-in wallet and its session
 *   expiry) lives in its serialized attachment; everything the room needs (history, each wallet's last send) lives in
 *   the object's SQLite storage. Nothing is kept only in memory.
 * - Anyone can read: a new socket gets the last CHAT_HISTORY messages and the reader count. Posting needs
 *   `{type:"auth",token}` with a session token (src/session.ts), at most one message per CHAT_COOLDOWN_MS per wallet,
 *   CHAT_MAX_CHARS characters, and attachments only from MEDIA_PUBLIC_URL/img/.
 */
import {
  CHAT_COOLDOWN_MS,
  CHAT_HISTORY,
  CHAT_MAX_FRAME,
  checkAttachments,
  checkText,
  isAddress,
  parseClientFrame,
  type ChatAttachment,
  type ChatErrorCode,
  type ChatMessage,
  type ServerFrame,
} from "../../../app/src/lib/chatMessage";
import { verifyToken } from "./session";

/** The parts of the Durable Object APIs the room uses (the runtime's objects satisfy them). */
export interface SqlCursor<T> {
  toArray(): T[];
}
export interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T>;
}
export interface RoomSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
export interface RoomState {
  storage: { sql: SqlStorage };
  acceptWebSocket(ws: RoomSocket, tags?: string[]): void;
  getWebSockets(tag?: string): RoomSocket[];
}
export interface RoomEnv {
  CHAT_SECRET?: string;
  MEDIA_PUBLIC_URL?: string;
}
export interface RoomDeps {
  now(): number;
  newId(): string;
  /** A connected client/server socket pair (WebSocketPair in Workers). */
  newPair?(): { client: unknown; server: RoomSocket };
  /** The 101 response handing `client` to the caller (`new Response(null, {status: 101, webSocket})` in Workers). */
  upgradeResponse?(client: unknown): Response;
}

/** What a socket remembers across hibernation. */
export interface SocketInfo {
  mint: string;
  wallet: string | null;
  expiresAt: number;
}

const ERR: Record<ChatErrorCode, string> = {
  sign_in_required: "Sign in with your wallet to chat",
  session_expired: "Your chat session expired: sign in again",
  rate_limited: "Slow down: one message every 2 seconds",
  too_long: "Message too long",
  empty: "Write something or attach an image",
  bad_attachment: "Attachments must be images uploaded to Parabull",
  bad_request: "Bad request",
};

type Row = { id: string; author: string; text: string; attachments: string; ts: number };

export class ChatRoomCore {
  private ready = false;

  constructor(
    private readonly state: RoomState,
    private readonly env: RoomEnv,
    private readonly deps: RoomDeps,
  ) {}

  private sql<T = Record<string, unknown>>(q: string, ...b: unknown[]): T[] {
    return this.state.storage.sql.exec<T>(q, ...b).toArray();
  }

  /** Creates the tables on first use (idempotent, so it is safe after every wake). */
  private schema(): void {
    if (this.ready) return;
    this.sql("CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, author TEXT NOT NULL, text TEXT NOT NULL, attachments TEXT NOT NULL, ts INTEGER NOT NULL)");
    this.sql("CREATE TABLE IF NOT EXISTS senders (wallet TEXT PRIMARY KEY, last_ms INTEGER NOT NULL)");
    this.ready = true;
  }

  history(mint: string): ChatMessage[] {
    this.schema();
    const rows = this.sql<Row>("SELECT id, author, text, attachments, ts FROM messages ORDER BY seq DESC LIMIT ?", CHAT_HISTORY);
    return rows.reverse().map((r) => ({ id: r.id, mint, author: r.author, text: r.text, attachments: JSON.parse(r.attachments) as ChatAttachment[], ts: Number(r.ts) }));
  }

  /** GET /chat/:mint with Upgrade: websocket, forwarded by the Worker (which already checked the origin and mint). */
  async fetch(request: Request): Promise<Response> {
    const mint = new URL(request.url).pathname.split("/")[2] ?? "";
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a websocket", { status: 426 });
    if (!isAddress(mint)) return new Response("bad mint", { status: 400 });
    if (!this.deps.newPair || !this.deps.upgradeResponse) return new Response("websockets unavailable", { status: 500 });
    const { client, server } = this.deps.newPair();
    this.accept(server, mint);
    return this.deps.upgradeResponse(client);
  }

  /** Takes a server-side socket into the room: hibernatable, replayed the history, counted. */
  accept(ws: RoomSocket, mint: string): void {
    this.state.acceptWebSocket(ws);
    const info: SocketInfo = { mint, wallet: null, expiresAt: 0 };
    ws.serializeAttachment(info);
    this.send(ws, { type: "history", messages: this.history(mint) });
    this.broadcastPresence();
  }

  private info(ws: RoomSocket): SocketInfo | null {
    const v = ws.deserializeAttachment() as SocketInfo | null;
    return v && typeof v.mint === "string" ? v : null;
  }

  private send(ws: RoomSocket, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // A socket closing under us: the close handler cleans up.
    }
  }

  private error(ws: RoomSocket, code: ChatErrorCode, retryAfterMs?: number): void {
    this.send(ws, { type: "error", code, error: ERR[code], ...(retryAfterMs ? { retryAfterMs } : {}) });
  }

  private broadcast(frame: ServerFrame, except?: RoomSocket): void {
    const data = JSON.stringify(frame);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        // ignore
      }
    }
  }

  /** `leaving`: a socket that is closing, which the runtime may still list. */
  private broadcastPresence(leaving?: RoomSocket): void {
    const count = this.state.getWebSockets().filter((ws) => ws !== leaving).length;
    this.broadcast({ type: "presence", count }, leaving);
  }

  async webSocketMessage(ws: RoomSocket, raw: string | ArrayBuffer): Promise<void> {
    if (raw === "ping") return void ws.send("pong");
    const info = this.info(ws);
    if (!info) return ws.close(1011, "lost state");
    if (typeof raw !== "string" || raw.length > CHAT_MAX_FRAME) return this.error(ws, "bad_request");
    const frame = parseClientFrame(raw);
    if (!frame) return this.error(ws, "bad_request");
    const now = this.deps.now();

    if (frame.type === "signout") {
      ws.serializeAttachment({ ...info, wallet: null, expiresAt: 0 } satisfies SocketInfo);
      return this.send(ws, { type: "ready", wallet: null });
    }
    if (frame.type === "auth") {
      const session = await verifyToken(this.env.CHAT_SECRET, frame.token, now);
      if (!session) {
        ws.serializeAttachment({ ...info, wallet: null, expiresAt: 0 } satisfies SocketInfo);
        return this.error(ws, "session_expired");
      }
      ws.serializeAttachment({ ...info, wallet: session.wallet, expiresAt: session.expiresAt } satisfies SocketInfo);
      return this.send(ws, { type: "ready", wallet: session.wallet });
    }

    // send
    if (!info.wallet) return this.error(ws, "sign_in_required");
    if (info.expiresAt <= now) {
      ws.serializeAttachment({ ...info, wallet: null, expiresAt: 0 } satisfies SocketInfo);
      return this.error(ws, "session_expired");
    }
    const text = checkText(frame.text);
    if (!text.ok) return this.error(ws, text.code);
    const attachments = checkAttachments(frame.attachments, this.env.MEDIA_PUBLIC_URL ?? "");
    if (!attachments.ok) return this.error(ws, attachments.code);
    if (!text.value && attachments.value.length === 0) return this.error(ws, "empty");

    this.schema();
    const last = this.sql<{ last_ms: number }>("SELECT last_ms FROM senders WHERE wallet = ?", info.wallet)[0];
    if (last && now - Number(last.last_ms) < CHAT_COOLDOWN_MS) return this.error(ws, "rate_limited", CHAT_COOLDOWN_MS - (now - Number(last.last_ms)));

    const message: ChatMessage = { id: this.deps.newId(), mint: info.mint, author: info.wallet, text: text.value, attachments: attachments.value, ts: now };
    this.sql("INSERT INTO senders (wallet, last_ms) VALUES (?, ?) ON CONFLICT(wallet) DO UPDATE SET last_ms = excluded.last_ms", info.wallet, now);
    this.sql("INSERT INTO messages (id, author, text, attachments, ts) VALUES (?, ?, ?, ?, ?)", message.id, message.author, message.text, JSON.stringify(message.attachments), message.ts);
    // Keep the newest CHAT_HISTORY.
    this.sql("DELETE FROM messages WHERE seq <= (SELECT seq FROM messages ORDER BY seq DESC LIMIT 1 OFFSET ?)", CHAT_HISTORY);
    this.broadcast({ type: "message", message });
  }

  webSocketClose(ws: RoomSocket, code: number): void {
    try {
      // Completes the close handshake; 1005/1006 are reserved and can't be sent back.
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
    this.broadcastPresence(ws);
  }

  webSocketError(ws: RoomSocket): void {
    this.webSocketClose(ws, 1011);
  }
}

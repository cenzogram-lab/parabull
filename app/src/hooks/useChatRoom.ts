/**
 * A coin's live chat (services/parabull-edge ChatRoom): the socket to GET /chat/:mint, the replayed history and new
 * messages, the reader count, and posting as the connected wallet.
 *
 * - Reading needs nothing. Posting needs a wallet that can sign messages: the first post (or image) asks the wallet to
 *   sign the chat sign-in text once, POST /chat/session turns that into a session token, and the socket authenticates
 *   with it. Tokens are kept in memory per wallet for the tab (never in storage), so other coins' chats reuse them.
 * - The socket reconnects with backoff and re-authenticates; a keepalive "ping" goes out every 25s.
 * - Without VITE_CHAT_URL the room is "off" and the UI says chat isn't connected; there is no simulated feed.
 */
import { useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CONFIG } from "../config";
import { chatEndpoints, chatSignIn, reconnectDelay } from "../lib/chatClient";
import { CHAT_COOLDOWN_MS, CHAT_HISTORY, checkText, type ChatMessage, type ChatSessionResponse, type ServerFrame } from "../lib/chatMessage";

export type ChatStatus = "off" | "connecting" | "open" | "reconnecting";

/** Session tokens by wallet, for this tab only. */
const sessions = new Map<string, ChatSessionResponse>();
const validSession = (wallet: string) => {
  const s = sessions.get(wallet);
  return s && s.expiresAt - Date.now() > 60_000 ? s : null;
};

export interface ChatRoom {
  status: ChatStatus;
  messages: ChatMessage[];
  /** Sockets in the room, as the room last reported. */
  online: number | null;
  /** The connected wallet, if any. */
  wallet: string | null;
  /** Whether the connected wallet can sign the sign-in message. */
  canSign: boolean;
  /** The wallet the socket is signed in as. */
  signedInAs: string | null;
  /** Waiting on the wallet's signature or the session. */
  signingIn: boolean;
  /** No post before this time (the room's 2-second cooldown). */
  cooldownUntil: number;
  error: string | null;
  clearError(): void;
  send(text: string, attachments?: string[]): Promise<boolean>;
  upload(file: File): Promise<string>;
}

export function useChatRoom(mint: string): ChatRoom {
  const endpoints = chatEndpoints(CONFIG.chatUrl);
  const { publicKey, signMessage } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [status, setStatus] = useState<ChatStatus>(endpoints ? "connecting" : "off");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [online, setOnline] = useState<number | null>(null);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  /** The token the socket last authenticated with: a replacement session must be sent even for the same wallet. */
  const socketToken = useRef<string | null>(null);
  const readyWaiters = useRef<((wallet: string | null) => void)[]>([]);
  /** A post waiting for the room's answer: its own message coming back, or an error. */
  const pendingSend = useRef<{ text: string; resolve: (ok: boolean) => void } | null>(null);
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const roomUrl = endpoints?.room(mint) ?? null;

  const authenticate = useCallback((ws: WebSocket, w: string | null) => {
    const s = w ? validSession(w) : null;
    socketToken.current = s?.token ?? null;
    if (s) ws.send(JSON.stringify({ type: "auth", token: s.token }));
    else ws.send(JSON.stringify({ type: "signout" }));
  }, []);
  const settleSend = (ok: boolean) => {
    pendingSend.current?.resolve(ok);
    pendingSend.current = null;
  };

  // The socket: connect, replay, reconnect with backoff.
  useEffect(() => {
    if (!roomUrl) return;
    let closed = false;
    let attempt = 0;
    let retry: number | undefined;
    let ping: number | undefined;
    setMessages([]);
    setOnline(null);
    setSignedInAs(null);

    const connect = () => {
      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      const ws = new WebSocket(roomUrl);
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setStatus("open");
        if (walletRef.current && validSession(walletRef.current)) authenticate(ws, walletRef.current);
        ping = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 25_000);
      };
      ws.onmessage = (e) => {
        if (e.data === "pong" || typeof e.data !== "string") return;
        let f: ServerFrame;
        try {
          f = JSON.parse(e.data) as ServerFrame;
        } catch {
          return;
        }
        if (f.type === "history") setMessages(f.messages.slice(-CHAT_HISTORY));
        else if (f.type === "message") {
          setMessages((m) => (m.some((x) => x.id === f.message.id) ? m : [...m, f.message].slice(-CHAT_HISTORY)));
          const p = pendingSend.current;
          if (p && f.message.author === walletRef.current && f.message.text === p.text) settleSend(true);
        }
        else if (f.type === "presence") setOnline(f.count);
        else if (f.type === "ready") {
          setSignedInAs(f.wallet);
          readyWaiters.current.splice(0).forEach((r) => r(f.wallet));
        } else if (f.type === "error") {
          if (f.code === "session_expired" || f.code === "sign_in_required") {
            if (walletRef.current) sessions.delete(walletRef.current);
            socketToken.current = null;
            setSignedInAs(null);
            readyWaiters.current.splice(0).forEach((r) => r(null));
          }
          settleSend(false);
          if (f.code === "rate_limited" && f.retryAfterMs) setCooldownUntil(Date.now() + f.retryAfterMs);
          setError(f.error);
        }
      };
      ws.onclose = () => {
        window.clearInterval(ping);
        if (socket.current === ws) socket.current = null;
        socketToken.current = null;
        settleSend(false);
        setSignedInAs(null);
        readyWaiters.current.splice(0).forEach((r) => r(null));
        if (closed) return;
        setStatus("reconnecting");
        retry = window.setTimeout(connect, reconnectDelay(attempt++));
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      window.clearInterval(ping);
      socket.current?.close(1000, "left");
      socket.current = null;
    };
  }, [roomUrl, authenticate]);

  // A wallet switch: authenticate as the new wallet if it has a session, otherwise read-only.
  useEffect(() => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) authenticate(ws, wallet);
  }, [wallet, authenticate]);

  /** A session for the connected wallet, asking it to sign in if there is none, and the socket signed in with it. */
  const ensureSignedIn = useCallback(async (): Promise<ChatSessionResponse> => {
    if (!endpoints) throw new Error("Live chat isn't connected in this build");
    if (!publicKey || !wallet) throw new Error("Connect a wallet to chat");
    let s = validSession(wallet);
    if (!s) {
      if (!signMessage) throw new Error("This wallet can't sign messages, so it can't chat");
      setSigningIn(true);
      try {
        const nonce = crypto.getRandomValues(new Uint8Array(16));
        const { message, body } = chatSignIn(wallet, new Date(), nonce);
        const signature = await signMessage(new TextEncoder().encode(message));
        const res = await fetch(endpoints.session, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(signature)) });
        const json = (await res.json().catch(() => ({}))) as Partial<ChatSessionResponse> & { error?: string };
        if (!res.ok || !json.token || json.wallet !== wallet || !json.expiresAt) throw new Error(json.error ? `Chat sign-in failed: ${json.error}` : `Chat sign-in failed (${res.status})`);
        s = { token: json.token, wallet, expiresAt: json.expiresAt };
        sessions.set(wallet, s);
      } finally {
        setSigningIn(false);
      }
    }
    // Authenticate unless the socket already holds this very token: a replacement session (the old one ran out)
    // has to be sent even though the socket is signed in as the same wallet.
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN && (signedInAs !== wallet || socketToken.current !== s.token)) {
      const ready = new Promise<string | null>((resolve) => {
        readyWaiters.current.push(resolve);
        window.setTimeout(() => resolve(null), 5_000);
      });
      socketToken.current = s.token;
      ws.send(JSON.stringify({ type: "auth", token: s.token }));
      if ((await ready) !== wallet) throw new Error("Couldn't sign in to the chat: try again");
    }
    return s;
  }, [endpoints, publicKey, wallet, signMessage, signedInAs]);

  const send = useCallback(
    async (text: string, attachments: string[] = []): Promise<boolean> => {
      setError(null);
      const t = checkText(text);
      if (!t.ok) return setError(t.error), false;
      if (!t.value && attachments.length === 0) return false;
      if (Date.now() < cooldownUntil) return setError("Slow down: one message every 2 seconds"), false;
      try {
        await ensureSignedIn();
        const ws = socket.current;
        if (ws?.readyState !== WebSocket.OPEN) throw new Error("Chat is reconnecting: try again in a moment");
        // Done when the room answers: our message comes back (true) or an error does (false, the draft stays).
        settleSend(false);
        const answered = new Promise<boolean>((resolve) => {
          pendingSend.current = { text: t.value, resolve };
          window.setTimeout(() => pendingSend.current?.resolve === resolve && (settleSend(false), setError("The chat didn't answer: try again")), 8_000);
        });
        ws.send(JSON.stringify({ type: "send", text: t.value, attachments }));
        setCooldownUntil(Date.now() + CHAT_COOLDOWN_MS);
        return await answered;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
    [cooldownUntil, ensureSignedIn],
  );

  const upload = useCallback(
    async (file: File): Promise<string> => {
      const s = await ensureSignedIn();
      const form = new FormData();
      form.append("image", file);
      const res = await fetch(endpoints!.upload, { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: form });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !json.url) throw new Error(json.error ?? `Upload failed (${res.status})`);
      return json.url;
    },
    [endpoints, ensureSignedIn],
  );

  return {
    status,
    messages,
    online,
    wallet,
    canSign: !!signMessage,
    signedInAs,
    signingIn,
    cooldownUntil,
    error,
    clearError: () => setError(null),
    send,
    upload,
  };
}

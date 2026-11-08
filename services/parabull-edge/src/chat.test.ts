import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CHAT_COOLDOWN_MS, CHAT_HISTORY, CHAT_SESSION_MS, chatSignInMessage, type ServerFrame } from "../../../app/src/lib/chatMessage";
import { ChatRoomCore, type RoomSocket, type RoomState } from "./chatRoom";
import { handle, type ChatNamespace, type Env } from "./router";
import { createSession, issueToken, verifyToken } from "./session";

const SECRET = "s".repeat(40);
const APP = "https://abcde-aaaaa-aaaaa-aaaaa-cai.icp0.io";
const MEDIA = "https://media.parabull.test";
const HASH = "b".repeat(64);
const T0 = Date.parse("2026-11-08T03:00:00.000Z");

// --- wallets -------------------------------------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}
async function wallet() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as { publicKey: CryptoKeyLike; privateKey: CryptoKeyLike };
  const address = b58(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey as never)));
  const sign = async (text: string) => Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey as never, new TextEncoder().encode(text))).toString("base64");
  return { address, sign };
}
type CryptoKeyLike = unknown;
async function signedIn(w: Awaited<ReturnType<typeof wallet>>, now = T0, nonce = "nonce-12345") {
  const issuedAt = new Date(now).toISOString();
  return { wallet: w.address, issuedAt, nonce, signature: await w.sign(chatSignInMessage(w.address, issuedAt, nonce)) };
}

// --- a Durable Object stand-in: node:sqlite storage, sockets that keep their attachment ---------------------------

class FakeSocket implements RoomSocket {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private attachment: string | null = null;
  send(data: string) {
    if (this.closed) throw new Error("socket closed");
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  serializeAttachment(v: unknown) {
    this.attachment = JSON.stringify(v);
  }
  deserializeAttachment() {
    return this.attachment === null ? null : JSON.parse(this.attachment);
  }
  frames(): ServerFrame[] {
    return this.sent.filter((s) => s !== "pong").map((s) => JSON.parse(s) as ServerFrame);
  }
  last<T extends ServerFrame["type"]>(type: T): Extract<ServerFrame, { type: T }> | undefined {
    return this.frames().filter((f) => f.type === type).pop() as Extract<ServerFrame, { type: T }> | undefined;
  }
  clear() {
    this.sent = [];
  }
}

function sqlStorage(db: DatabaseSync) {
  return {
    exec<T>(query: string, ...bindings: unknown[]) {
      const st = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? (st.all(...(bindings as never[])) as T[]) : (st.run(...(bindings as never[])), [] as T[]);
      return { toArray: () => rows };
    },
  };
}

/** The runtime's view of one object: storage and accepted sockets survive; the ChatRoomCore instance doesn't. */
function durableObject() {
  const db = new DatabaseSync(":memory:");
  const sockets: FakeSocket[] = [];
  const state: RoomState = {
    storage: { sql: sqlStorage(db) },
    acceptWebSocket: (ws) => void sockets.push(ws as FakeSocket),
    getWebSockets: () => sockets.filter((s) => !s.closed),
  };
  let now = T0;
  let n = 0;
  const clock = { now: () => now, set: (t: number) => (now = t), advance: (ms: number) => (now += ms) };
  const wake = () => new ChatRoomCore(state, { CHAT_SECRET: SECRET, MEDIA_PUBLIC_URL: MEDIA }, { now: clock.now, newId: () => `m${++n}` });
  return { db, sockets, clock, wake };
}

const MINT = "So11111111111111111111111111111111111111112";
const send = (room: ChatRoomCore, ws: FakeSocket, frame: unknown) => room.webSocketMessage(ws, typeof frame === "string" ? frame : JSON.stringify(frame));

// --- sessions ------------------------------------------------------------------------------------------------------

test("session: a wallet's ed25519 signature on the sign-in text gets a token for that wallet", async () => {
  const w = await wallet();
  const res = await createSession(await signedIn(w), SECRET, T0);
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.value.wallet, w.address);
  assert.equal(res.value.expiresAt, T0 + CHAT_SESSION_MS);
  assert.deepEqual(await verifyToken(SECRET, res.value.token, T0 + 1), { wallet: w.address, expiresAt: T0 + CHAT_SESSION_MS });
  assert.equal(await verifyToken(SECRET, res.value.token, T0 + CHAT_SESSION_MS), null, "expired");
  assert.equal(await verifyToken("t".repeat(40), res.value.token, T0), null, "another secret");
  const [addr, exp, sig] = res.value.token.split(".");
  assert.equal(await verifyToken(SECRET, `${addr}.${Number(exp) + 1}.${sig}`, T0), null, "expiry tampered");
  const other = await wallet();
  assert.equal(await verifyToken(SECRET, `${other.address}.${exp}.${sig}`, T0), null, "wallet swapped");
  assert.equal(await verifyToken(SECRET, "junk", T0), null);
});

test("session: refused for another wallet's signature, altered text, stale time, bad input or no secret", async () => {
  const w = await wallet();
  const other = await wallet();
  const good = await signedIn(w);
  const status = async (body: unknown, secret: string | undefined = SECRET, now = T0) => {
    const r = await createSession(body, secret, now);
    return r.ok ? 200 : r.status;
  };
  assert.equal(await status({ ...good, wallet: other.address }), 401, "signed by someone else");
  assert.equal(await status({ ...good, nonce: "nonce-99999" }), 401, "text changed after signing");
  assert.equal(await status(good, SECRET, T0 + 6 * 60_000), 401, "signed 6 minutes ago");
  assert.equal(await status(good, SECRET, T0 - 6 * 60_000), 401, "signed in the future");
  assert.equal(await status({ ...good, issuedAt: "yesterday" }), 400);
  assert.equal(await status({ ...good, wallet: "not-a-wallet" }), 400);
  assert.equal(await status({ ...good, nonce: "x" }), 400);
  assert.equal(await status({ ...good, signature: "%%%" }), 400);
  assert.equal(await status(null), 400);
  assert.deepEqual(await createSession(good, undefined, T0), { ok: false, status: 503, error: "chat sign-in is not configured" }, "no CHAT_SECRET: fails closed");
  assert.equal(await status(good, "short"), 503, "a short secret is refused too");
  assert.equal(await verifyToken(undefined, await issueToken(SECRET, w.address, T0 + 1000), T0), null, "nothing verifies without a secret");
});

// --- the room ------------------------------------------------------------------------------------------------------

test("room: readers get history and presence; only signed-in wallets post; posts reach every socket", async () => {
  const obj = durableObject();
  const room = obj.wake();
  const a = new FakeSocket();
  const reader = new FakeSocket();
  room.accept(a, MINT);
  assert.deepEqual(a.frames()[0], { type: "history", messages: [] });
  assert.deepEqual(a.last("presence"), { type: "presence", count: 1 });
  room.accept(reader, MINT);
  assert.deepEqual(a.last("presence"), { type: "presence", count: 2 }, "everyone hears the new reader");

  await send(room, a, { type: "send", text: "gm" });
  assert.equal(a.last("error")?.code, "sign_in_required");

  await send(room, a, { type: "auth", token: "forged" });
  assert.equal(a.last("error")?.code, "session_expired");

  const w = await wallet();
  await send(room, a, { type: "auth", token: await issueToken(SECRET, w.address, T0 + CHAT_SESSION_MS) });
  assert.deepEqual(a.last("ready"), { type: "ready", wallet: w.address });

  reader.clear();
  await send(room, a, { type: "send", text: "  gm bulls  " });
  const got = reader.last("message")?.message;
  assert.ok(got, "the reader (not signed in) receives it");
  assert.deepEqual({ ...got, id: "x" }, { id: "x", mint: MINT, author: w.address, text: "gm bulls", attachments: [], ts: T0 });
  assert.deepEqual(a.last("message")?.message, got, "and so does the sender");
  assert.equal(room.history(MINT).length, 1);
});

test("room: 280 characters, no empty posts, one message per 2 seconds per wallet", async () => {
  const obj = durableObject();
  const room = obj.wake();
  const ws = new FakeSocket();
  room.accept(ws, MINT);
  const w = await wallet();
  await send(room, ws, { type: "auth", token: await issueToken(SECRET, w.address, T0 + CHAT_SESSION_MS) });

  await send(room, ws, { type: "send", text: "x".repeat(281) });
  assert.equal(ws.last("error")?.code, "too_long");
  await send(room, ws, { type: "send", text: "   " });
  assert.equal(ws.last("error")?.code, "empty");

  await send(room, ws, { type: "send", text: "x".repeat(280) });
  assert.equal(ws.last("message")?.message.text.length, 280);
  obj.clock.advance(500);
  await send(room, ws, { type: "send", text: "too soon" });
  const err = ws.last("error");
  assert.equal(err?.code, "rate_limited");
  assert.equal(err?.retryAfterMs, CHAT_COOLDOWN_MS - 500);
  assert.equal(room.history(MINT).length, 1, "the refused message isn't stored");

  // Another wallet isn't held back by the first one's cooldown.
  const other = new FakeSocket();
  room.accept(other, MINT);
  const w2 = await wallet();
  await send(room, other, { type: "auth", token: await issueToken(SECRET, w2.address, T0 + CHAT_SESSION_MS) });
  await send(room, other, { type: "send", text: "me too" });
  assert.equal(other.last("message")?.message.author, w2.address);

  obj.clock.advance(CHAT_COOLDOWN_MS);
  await send(room, ws, { type: "send", text: "now" });
  assert.equal(ws.last("message")?.message.text, "now");
});

test("room: image and GIF attachments only from MEDIA_PUBLIC_URL/img/", async () => {
  const obj = durableObject();
  const room = obj.wake();
  const ws = new FakeSocket();
  room.accept(ws, MINT);
  const w = await wallet();
  await send(room, ws, { type: "auth", token: await issueToken(SECRET, w.address, T0 + CHAT_SESSION_MS) });

  await send(room, ws, { type: "send", text: "", attachments: [`${MEDIA}/img/${HASH}.gif`, `${MEDIA}/img/${HASH}.png`] });
  assert.deepEqual(ws.last("message")?.message.attachments, [
    { kind: "gif", url: `${MEDIA}/img/${HASH}.gif` },
    { kind: "image", url: `${MEDIA}/img/${HASH}.png` },
  ]);
  for (const url of [`https://evil.test/img/${HASH}.png`, `${MEDIA}/meta/${HASH}.json`, `${MEDIA}/img/${HASH}.svg`, "javascript:alert(1)"]) {
    obj.clock.advance(CHAT_COOLDOWN_MS);
    await send(room, ws, { type: "send", text: "look", attachments: [url] });
    assert.equal(ws.last("error")?.code, "bad_attachment", url);
  }
});

test("room: sign-out, expired sessions, junk frames and keepalive pings", async () => {
  const obj = durableObject();
  const room = obj.wake();
  const ws = new FakeSocket();
  room.accept(ws, MINT);
  const w = await wallet();
  await send(room, ws, { type: "auth", token: await issueToken(SECRET, w.address, T0 + 10_000) });
  await send(room, ws, { type: "signout" });
  assert.deepEqual(ws.last("ready"), { type: "ready", wallet: null });
  await send(room, ws, { type: "send", text: "gm" });
  assert.equal(ws.last("error")?.code, "sign_in_required");

  await send(room, ws, { type: "auth", token: await issueToken(SECRET, w.address, T0 + 10_000) });
  obj.clock.advance(10_000);
  await send(room, ws, { type: "send", text: "gm" });
  assert.equal(ws.last("error")?.code, "session_expired", "a session that ran out while connected");

  for (const junk of ["not json", '{"type":"nuke"}', JSON.stringify({ type: "send", text: "x".repeat(5000) })]) {
    await send(room, ws, junk);
    assert.equal(ws.last("error")?.code, "bad_request", junk.slice(0, 20));
  }
  ws.clear();
  await send(room, ws, "ping");
  assert.deepEqual(ws.sent, ["pong"]);
});

test("room: hibernation keeps history, signed-in sockets and cooldowns (a fresh instance, same storage and sockets)", async () => {
  const obj = durableObject();
  let room = obj.wake();
  const a = new FakeSocket();
  room.accept(a, MINT);
  const w = await wallet();
  await send(room, a, { type: "auth", token: await issueToken(SECRET, w.address, T0 + CHAT_SESSION_MS) });
  await send(room, a, { type: "send", text: "before sleep", attachments: [`${MEDIA}/img/${HASH}.gif`] });

  // Evicted: the instance and everything in its memory is gone. The runtime keeps the sockets and the SQLite file.
  room = obj.wake();
  obj.clock.advance(1_000);

  await send(room, a, { type: "send", text: "right after waking" });
  assert.equal(a.last("error")?.code, "rate_limited", "the cooldown was in SQLite, not memory");
  obj.clock.advance(CHAT_COOLDOWN_MS);
  await send(room, a, { type: "send", text: "after waking" });
  assert.equal(a.last("message")?.message.author, w.address, "still signed in: the wallet was in the socket's attachment");

  const late = new FakeSocket();
  room.accept(late, MINT);
  const history = late.last("history")?.messages ?? [];
  assert.deepEqual(
    history.map((m) => [m.text, m.attachments.length]),
    [
      ["before sleep", 1],
      ["after waking", 0],
    ],
  );
  assert.deepEqual(late.last("presence"), { type: "presence", count: 2 });
});

test("room: keeps the newest 200 messages", async () => {
  const obj = durableObject();
  const room = obj.wake();
  const ws = new FakeSocket();
  room.accept(ws, MINT);
  const w = await wallet();
  await send(room, ws, { type: "auth", token: await issueToken(SECRET, w.address, T0 + CHAT_SESSION_MS * 2) });
  for (let i = 1; i <= CHAT_HISTORY + 5; i++) {
    await send(room, ws, { type: "send", text: `#${i}` });
    obj.clock.advance(CHAT_COOLDOWN_MS);
  }
  const h = room.history(MINT);
  assert.equal(h.length, CHAT_HISTORY);
  assert.equal(h[0].text, "#6");
  assert.equal(h.at(-1)!.text, `#${CHAT_HISTORY + 5}`);
  const { n } = obj.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
  assert.equal(n, CHAT_HISTORY, "trimmed in storage too");
});

test("room: a closing socket completes the close and the others see the new count", async () => {
  const obj = durableObject();
  const room = obj.wake();
  const [a, b] = [new FakeSocket(), new FakeSocket()];
  room.accept(a, MINT);
  room.accept(b, MINT);
  room.webSocketClose(b, 1001);
  assert.deepEqual(b.closed, { code: 1001, reason: "closing" });
  assert.deepEqual(a.last("presence"), { type: "presence", count: 1 });
  const c = new FakeSocket();
  room.accept(c, MINT);
  room.webSocketClose(c, 1006);
  assert.equal(c.closed?.code, 1000, "reserved codes aren't sent back");
});

test("room: fetch() upgrades websockets only, for a valid mint", async () => {
  const obj = durableObject();
  const server = new FakeSocket();
  const room = new ChatRoomCore(
    { storage: { sql: sqlStorage(obj.db) }, acceptWebSocket: (ws) => void obj.sockets.push(ws as FakeSocket), getWebSockets: () => obj.sockets },
    { CHAT_SECRET: SECRET, MEDIA_PUBLIC_URL: MEDIA },
    { now: () => T0, newId: () => "id", newPair: () => ({ client: "client-end", server }), upgradeResponse: (client) => new Response(String(client), { status: 200 }) },
  );
  assert.equal((await room.fetch(new Request(`https://edge.test/chat/${MINT}`))).status, 426);
  assert.equal((await room.fetch(new Request("https://edge.test/chat/nope", { headers: { upgrade: "websocket" } }))).status, 400);
  const ok = await room.fetch(new Request(`https://edge.test/chat/${MINT}`, { headers: { upgrade: "websocket" } }));
  assert.equal(await ok.text(), "client-end");
  assert.equal(obj.sockets[0], server);
  assert.equal(server.last("history")?.type, "history");
});

// --- routing -------------------------------------------------------------------------------------------------------

function env(over: Partial<Env> = {}): Env & { forwarded: { name: string; url: string }[]; stored: Map<string, { body: unknown; type?: string }> } {
  const forwarded: { name: string; url: string }[] = [];
  const stored = new Map<string, { body: unknown; type?: string }>();
  const ns: ChatNamespace = {
    idFromName: (name) => ({ name }),
    get: (id) => ({ fetch: async (r: Request) => (forwarded.push({ name: (id as { name: string }).name, url: r.url }), new Response("room")) }),
  };
  return {
    MEDIA: { head: async (k) => (stored.has(k) ? {} : null), put: async (k, v, o) => void stored.set(k, { body: v, type: o?.httpMetadata?.contentType }) },
    MEDIA_PUBLIC_URL: MEDIA,
    ALLOWED_ORIGINS: APP,
    CHAT_ROOMS: ns,
    CHAT_SECRET: SECRET,
    ...over,
    forwarded,
    stored,
  };
}

test("routing: POST /chat/session with CORS, origin allowlist and preflight", async () => {
  const w = await wallet();
  const body = JSON.stringify(await signedIn(w));
  const post = (origin: string | null, b = body) => new Request("https://edge.test/chat/session", { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: b });
  const res = await handle(post(APP), env(), T0);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), APP);
  const { token, wallet: addr } = (await res.json()) as { token: string; wallet: string };
  assert.equal(addr, w.address);
  assert.ok(await verifyToken(SECRET, token, T0));
  assert.equal((await handle(post("https://evil.test"), env(), T0)).status, 403);
  assert.equal((await handle(post(null), env(), T0)).status, 403);
  assert.equal((await handle(post(APP, "x".repeat(3000)), env(), T0)).status, 400, "oversized body");
  assert.equal((await handle(post(APP), env({ CHAT_SECRET: undefined }), T0)).status, 503);
  const pre = await handle(new Request("https://edge.test/chat/upload", { method: "OPTIONS", headers: { origin: APP } }), env(), T0);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /authorization/);
  const limited = env({ CHAT_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal((await handle(post(APP), limited, T0)).status, 429);
});

test("routing: GET /chat/:mint goes to that mint's ChatRoom, websockets from allowed origins only", async () => {
  const e = env();
  const ws = (path: string, origin: string | null = APP, upgrade = true) =>
    new Request(`https://edge.test${path}`, { headers: { ...(origin ? { origin } : {}), ...(upgrade ? { upgrade: "websocket" } : {}) } });
  assert.equal(await (await handle(ws(`/chat/${MINT}`), e)).text(), "room");
  assert.deepEqual(e.forwarded, [{ name: MINT, url: `https://edge.test/chat/${MINT}` }]);
  assert.equal((await handle(ws(`/chat/${MINT}`, "https://evil.test"), e)).status, 403, "cross-site socket hijacking");
  assert.equal((await handle(ws(`/chat/${MINT}`, null), e)).status, 403);
  assert.equal((await handle(ws(`/chat/${MINT}`, APP, false), e)).status, 426);
  assert.equal((await handle(ws("/chat/not-a-mint"), e)).status, 400);
  assert.equal((await handle(ws(`/chat/${MINT}`), env({ CHAT_ROOMS: undefined }))).status, 503);
  assert.equal(e.forwarded.length, 1, "nothing else reached a room");
});

test("routing: POST /chat/upload stores a chat image for a signed-in wallet", async () => {
  const e = env();
  const w = await wallet();
  const token = await issueToken(SECRET, w.address, T0 + CHAT_SESSION_MS);
  const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
  const upload = async (bytes: Uint8Array, auth: string | null) => {
    const form = new FormData();
    form.append("image", new File([bytes], "x.gif", { type: "image/gif" }));
    const encoded = new Response(form);
    const body = new Uint8Array(await encoded.arrayBuffer());
    return handle(
      new Request("https://edge.test/chat/upload", {
        method: "POST",
        headers: { origin: APP, "content-type": encoded.headers.get("content-type")!, "content-length": String(body.length), ...(auth ? { authorization: auth } : {}) },
        body,
      }),
      e,
      T0,
    );
  };
  assert.equal((await upload(GIF, null)).status, 401);
  assert.equal((await upload(GIF, "Bearer forged")).status, 401);
  const ok = await upload(GIF, `Bearer ${token}`);
  assert.equal(ok.status, 200);
  const { url } = (await ok.json()) as { url: string };
  assert.match(url, /^https:\/\/media\.parabull\.test\/img\/[0-9a-f]{64}\.gif$/);
  assert.equal(e.stored.get(url.slice(MEDIA.length + 1))?.type, "image/gif");
  assert.equal((await upload(new TextEncoder().encode("<svg/>"), `Bearer ${token}`)).status, 415);
  // The uploaded URL is exactly what a room accepts as an attachment.
  const obj = durableObject();
  const room = obj.wake();
  const sock = new FakeSocket();
  room.accept(sock, MINT);
  await send(room, sock, { type: "auth", token });
  await send(room, sock, { type: "send", text: "", attachments: [url] });
  assert.deepEqual(sock.last("message")?.message.attachments, [{ kind: "gif", url }]);
});

test("review: /chat/session caps a streamed body without Content-Length at 2 KB while reading", async () => {
  const { readJson } = await import("./http");
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(1024).fill(0x20));
    },
  });
  const req = new Request("https://edge.test/chat/session", { method: "POST", body: endless, duplex: "half" } as RequestInit);
  assert.equal(req.headers.has("content-length"), false);
  assert.equal(await readJson(req, 2048), null);
  assert.ok(pulled <= 4, `stopped reading early (${pulled} chunks)`);
  // Bytes, not characters: 1,000 three-byte characters are 3,000 bytes.
  const wide = new Request("https://edge.test/chat/session", { method: "POST", body: JSON.stringify("€".repeat(1000)) });
  assert.equal(await readJson(wide, 2048), null);
  const ok = new Request("https://edge.test/chat/session", { method: "POST", body: '{"a":1}' });
  assert.deepEqual(await readJson(ok, 2048), { a: 1 });
  // Through the route: refused, nothing issued.
  const e = env();
  const streamed = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(1024).fill(0x20)) });
  const res = await handle(new Request("https://edge.test/chat/session", { method: "POST", headers: { origin: APP }, body: streamed, duplex: "half" } as RequestInit), e, T0);
  assert.equal(res.status, 400);
});

test("review: chat uploads are limited per IP, whichever wallet signs them", async () => {
  const keys: string[] = [];
  const e = env({ CHAT_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: true }) } });
  for (const w of [await wallet(), await wallet()]) {
    const token = await issueToken(SECRET, w.address, T0 + CHAT_SESSION_MS);
    const form = new FormData();
    form.append("image", new File([new TextEncoder().encode("GIF89a\x01\x00\x01\x00")], "x.gif"));
    const encoded = new Response(form);
    const body = new Uint8Array(await encoded.arrayBuffer());
    const res = await handle(
      new Request("https://edge.test/chat/upload", {
        method: "POST",
        headers: { origin: APP, authorization: `Bearer ${token}`, "cf-connecting-ip": "198.51.100.9", "content-type": encoded.headers.get("content-type")!, "content-length": String(body.length) },
        body,
      }),
      e,
      T0,
    );
    assert.equal(res.status, 200);
  }
  assert.deepEqual(keys, ["chat-upload:198.51.100.9", "chat-upload:198.51.100.9"], "one key for the IP, not one per wallet");
});

test("review: a send is confirmed to its own socket by cid, never by another tab's identical message", async () => {
  const obj = durableObject();
  const room = obj.wake();
  const [tab1, tab2] = [new FakeSocket(), new FakeSocket()];
  room.accept(tab1, MINT);
  room.accept(tab2, MINT);
  const w = await wallet();
  const token = await issueToken(SECRET, w.address, T0 + CHAT_SESSION_MS);
  for (const t of [tab1, tab2]) await send(room, t, { type: "auth", token });
  tab1.clear();
  tab2.clear();
  await send(room, tab1, { type: "send", text: "same words", cid: "tab1-1" });
  await send(room, tab2, { type: "send", text: "same words", cid: "tab2-1" }); // same wallet, inside the cooldown
  assert.deepEqual(tab1.last("sent"), { type: "sent", cid: "tab1-1", id: tab1.last("message")!.message.id });
  assert.equal(tab2.last("sent"), undefined, "tab 2 sees tab 1's broadcast but no confirmation of its own");
  assert.equal(tab2.last("message")?.message.text, "same words", "(it does see the broadcast)");
  const err = tab2.last("error");
  assert.equal(err?.code, "rate_limited");
  assert.equal(err?.cid, "tab2-1", "the refusal names tab 2's send");
  // Every refusal of a send carries its cid.
  await send(room, tab1, { type: "signout" });
  await send(room, tab1, { type: "send", text: "x", cid: "c-2" });
  assert.equal(tab1.last("error")?.cid, "c-2");
  // A malformed cid is refused outright.
  await send(room, tab2, JSON.stringify({ type: "send", text: "x", cid: "has spaces" }));
  assert.equal(tab2.last("error")?.code, "bad_request");
});

test("review: readers allocate no storage; only a signed-in post creates the room's tables", async () => {
  const obj = durableObject();
  const room = obj.wake();
  const tables = () => (obj.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name).sort();
  for (let i = 0; i < 5; i++) room.accept(new FakeSocket(), MINT);
  assert.deepEqual(room.history(MINT), []);
  assert.deepEqual(tables(), [], "five readers, no tables");
  const ws = new FakeSocket();
  room.accept(ws, MINT);
  await send(room, ws, { type: "send", text: "gm" });
  assert.deepEqual(tables(), [], "an unauthenticated send doesn't create them either");
  const w = await wallet();
  await send(room, ws, { type: "auth", token: await issueToken(SECRET, w.address, T0 + CHAT_SESSION_MS) });
  await send(room, ws, { type: "send", text: "gm" });
  assert.deepEqual(tables(), ["messages", "senders"]);
  // A woken instance finds the tables again.
  const late = new FakeSocket();
  obj.wake().accept(late, MINT);
  assert.equal(late.last("history")?.messages.length, 1);
});

test("review: sender rows are pruned once their cooldown has passed", async () => {
  const obj = durableObject();
  const room = obj.wake();
  const count = () => (obj.db.prepare("SELECT COUNT(*) AS n FROM senders").get() as { n: number }).n;
  for (let i = 0; i < 5; i++) {
    const ws = new FakeSocket();
    room.accept(ws, MINT);
    const w = await wallet();
    await send(room, ws, { type: "auth", token: await issueToken(SECRET, w.address, T0 + CHAT_SESSION_MS) });
    await send(room, ws, { type: "send", text: `from wallet ${i}` });
    obj.clock.advance(CHAT_COOLDOWN_MS);
  }
  assert.equal(count(), 1, "only the wallet still inside its cooldown has a row");
  assert.equal(room.history(MINT).length, 5);
});

test("review: chat socket handshakes are rate-limited per IP", async () => {
  const keys: string[] = [];
  let allow = true;
  const e = env({ CHAT_CONNECT_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: allow }) } });
  const ws = () => new Request(`https://edge.test/chat/${MINT}`, { headers: { origin: APP, upgrade: "websocket", "cf-connecting-ip": "203.0.113.5" } });
  assert.equal((await handle(ws(), e)).status, 200);
  allow = false;
  const res = await handle(ws(), e);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.deepEqual(keys, ["chat-connect:203.0.113.5", "chat-connect:203.0.113.5"]);
  assert.equal(e.forwarded.length, 1, "the limited handshake never reached a room");
});

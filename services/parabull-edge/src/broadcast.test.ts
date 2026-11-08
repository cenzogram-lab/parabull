import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { base58Decode, CHAT_SESSION_MS } from "../../../app/src/lib/chatMessage";
import { broadcastInput, type BroadcastEnv } from "./broadcast";
import { ChatRoomCore, type RoomState } from "./chatRoom";
import { resetLiveCache } from "./live";
import { handle, type ChatNamespace, type Env } from "./router";
import { issueToken } from "./session";
import { base58Encode, bondingCurveAddress, BONDING_CURVE_DISCRIMINATOR, curveCreator, isOnCurve, PARABULL_PROGRAM_ID } from "./solana";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const HOST = "customer-abc123.cloudflarestream.com";
const RPC = "https://rpc.test";
const APP = "https://abcde-aaaaa-aaaaa-aaaaa-cai.icp0.io";
const SECRET = "s".repeat(40);
const MINT = "DrLUh4S9VS1rsJwPKexAmJsUhpZa89At8ea11ASTCUGn";
const CREATOR = "7Z41mBaP2t5tbxJDRCGUdHC2Gw4dwbBgrmYzkFZq73cW";
const STRANGER = "J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf";
const env: BroadcastEnv = { CF_ACCOUNT_ID: ACCOUNT, CF_STREAM_TOKEN: "write-token", STREAM_HOST: HOST, SOLANA_RPC_URL: RPC };

// @solana/web3.js PublicKey.findProgramAddressSync([b"bonding-curve", mint], program), computed with web3.js 1.99.
const VECTORS: [string, string, number][] = [
  ["DrLUh4S9VS1rsJwPKexAmJsUhpZa89At8ea11ASTCUGn", "6A4xX8dBR9v59U4hEbzpdHYZEQbJwm2bYcrHeFUWwzuc", 250],
  ["So11111111111111111111111111111111111111112", "7ZuRwkQdj2Zg2gDf5SLw9Nk3DRDNDEQ74MMLw53R19M1", 255],
  ["CWh5S2rBmLoHGSvGfSHQDkUhZzCxAGVDYbspyu2MN7R2", "7MeEjJV8hGKhWboVg3nFAEXZ4sL8BV2CuVfhWvwGQu2T", 255],
  ["J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf", "85qtinUuuXnHZQLTbpt9B3ueURm94cmrXjLykjM47qmL", 255],
];

/** A BondingCurve account's bytes: discriminator, 4 flag bytes, mint, creator, then the rest zeroed. */
function curveAccount(mint: string, creator: string, disc = BONDING_CURVE_DISCRIMINATOR): string {
  const data = new Uint8Array(8 + 4 + 32 + 32 + 200);
  data.set(disc, 0);
  data.set(base58Decode(mint)!, 12);
  data.set(base58Decode(creator)!, 44);
  return Buffer.from(data).toString("base64");
}

/** RPC + Stream API stand-in. */
function upstream(opts: { creator?: string; owner?: string; disc?: number[]; accountMint?: string; missing?: boolean; rpcDown?: boolean; inputs?: Record<string, unknown>[]; streamDown?: boolean } = {}) {
  const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
  // Like the real API, the list shows the inputs created so far.
  const inputs = [...(opts.inputs ?? [])];
  const creds = (uid: string, meta: unknown) => ({
    uid,
    meta,
    rtmps: { url: "rtmps://live.cloudflare.com:443/live/", streamKey: `key-${uid}` },
    srt: { url: "srt://live.cloudflare.com:778", streamId: uid, passphrase: `pass-${uid}` },
    webRTC: { url: `https://${HOST}/whipkey${uid}/webRTC/publish` },
  });
  const f = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body, auth: new Headers(init?.headers).get("authorization") });
    await new Promise((r) => setTimeout(r, 2)); // network time: racing requests interleave as they would for real
    if (url === RPC) {
      if (opts.rpcDown) return new Response("down", { status: 503 });
      if (opts.missing) return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: null } });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { owner: opts.owner ?? PARABULL_PROGRAM_ID, data: [curveAccount(opts.accountMint ?? MINT, opts.creator ?? CREATOR, opts.disc), "base64"] } } });
    }
    const api = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/stream/live_inputs`;
    if (opts.streamDown) return Response.json({ success: false }, { status: 500 });
    if (url === api && method === "GET") return Response.json({ success: true, result: { liveInputs: inputs.map((i) => ({ uid: i.uid, meta: i.meta, enabled: true })) } });
    if (url === api && method === "POST") {
      const uid = "cdef"[(inputs.length - (opts.inputs?.length ?? 0)) % 4].repeat(32);
      inputs.push({ uid, meta: body.meta });
      return Response.json({ success: true, result: creds(uid, body.meta) });
    }
    const one = url.startsWith(`${api}/`) ? url.slice(api.length + 1) : null;
    if (one && method === "GET") return Response.json({ success: true, result: creds(one, inputs.find((i) => i.uid === one)?.meta) });
    if (one && method === "PUT") return Response.json({ success: true, result: creds(one, body.meta) });
    return new Response("unexpected", { status: 599 });
  };
  return { fetchImpl: f as unknown as typeof fetch, calls };
}

/** A coin's room for going live: no sockets, and storage that must never be touched. */
function liveRoom(fetchImpl: typeof fetch, e: BroadcastEnv = env) {
  const state: RoomState = {
    storage: { sql: { exec: () => assert.fail("going live must not touch chat storage") } },
    acceptWebSocket: () => assert.fail("no sockets"),
    getWebSockets: () => [],
  };
  return new ChatRoomCore(state, e, { now: () => 0, newId: () => "id", fetch: fetchImpl });
}

/** CHAT_ROOMS as the Worker sees it: one room per mint, made on first use, like Durable Objects. */
function rooms(fetchImpl: typeof fetch) {
  const made = new Map<string, ChatRoomCore>();
  const ns: ChatNamespace = {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: (req) => {
        const key = id as string;
        if (!made.has(key)) made.set(key, liveRoom(fetchImpl));
        return made.get(key)!.fetch(req);
      },
    }),
  };
  return { ns, made };
}

beforeEach(resetLiveCache);

test("solana: bonding curve addresses match @solana/web3.js, base58 round-trips", async () => {
  for (const [mint, pda, bump] of VECTORS) assert.deepEqual(await bondingCurveAddress(mint), { address: pda, bump }, mint);
  assert.equal(isOnCurve(base58Decode("J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf")!), true, "a wallet key is on the curve");
  assert.equal(isOnCurve(base58Decode("6A4xX8dBR9v59U4hEbzpdHYZEQbJwm2bYcrHeFUWwzuc")!), false, "a PDA is off it");
  for (const [mint] of VECTORS) assert.equal(base58Encode(base58Decode(mint)!), mint);
  assert.equal(base58Encode(new Uint8Array(32)), "11111111111111111111111111111111");
});

test("solana: the creator comes from the curve account, with owner, discriminator and mint checked", async () => {
  const ok = upstream();
  assert.deepEqual(await curveCreator(RPC, MINT, PARABULL_PROGRAM_ID, ok.fetchImpl), { ok: true, creator: CREATOR });
  const req = ok.calls[0].body as { method: string; params: [string, { encoding: string }] };
  assert.equal(req.method, "getAccountInfo");
  assert.equal(req.params[0], "6A4xX8dBR9v59U4hEbzpdHYZEQbJwm2bYcrHeFUWwzuc", "asks for the derived curve address");
  assert.equal(req.params[1].encoding, "base64");
  const status = async (o: Parameters<typeof upstream>[0]) => {
    const r = await curveCreator(RPC, MINT, PARABULL_PROGRAM_ID, upstream(o).fetchImpl);
    return r.ok ? 200 : r.status;
  };
  assert.equal(await status({ missing: true }), 404, "no curve: not a Parabull coin here");
  assert.equal(await status({ owner: STRANGER }), 404, "owned by another program");
  assert.equal(await status({ disc: [1, 2, 3, 4, 5, 6, 7, 8] }), 404, "another account type");
  assert.equal(await status({ accountMint: STRANGER }), 404, "a curve for another mint");
  assert.equal(await status({ rpcDown: true }), 502);
});

test("broadcast: the on-chain creator gets a new live input on first use", async () => {
  const u = upstream();
  const r = await broadcastInput(env, CREATOR, { mint: MINT, title: "  Dev AMA  " }, u.fetchImpl);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.value, {
    input: "c".repeat(32),
    mint: MINT,
    title: "Dev AMA",
    rtmps: { url: "rtmps://live.cloudflare.com:443/live/", streamKey: `key-${"c".repeat(32)}` },
    srt: { url: "srt://live.cloudflare.com:778", streamId: "c".repeat(32), passphrase: `pass-${"c".repeat(32)}` },
    hls: `https://${HOST}/${"c".repeat(32)}/manifest/video.m3u8`,
  });
  const create = u.calls.find((c) => c.method === "POST" && c.url.startsWith("https://api.cloudflare.com"))!;
  assert.deepEqual(create.body, { meta: { mint: MINT, creator: CREATOR, title: "Dev AMA" }, recording: { mode: "automatic" }, enabled: true });
  assert.ok(u.calls.filter((c) => c.url.startsWith("https://api.cloudflare.com")).every((c) => c.auth === "Bearer write-token"));
});

test("broadcast: racing first-time requests for a coin make one input (serialized in the coin's room)", async () => {
  const creates = (u: ReturnType<typeof upstream>) => u.calls.filter((c) => c.method === "POST" && c.url.startsWith("https://api.cloudflare.com")).length;
  // Unserialized, both requests list no input and both create one: two inputs, two stream keys.
  const raw = upstream();
  const [x, y] = await Promise.all([broadcastInput(env, CREATOR, { mint: MINT }, raw.fetchImpl), broadcastInput(env, CREATOR, { mint: MINT }, raw.fetchImpl)]);
  assert.ok(x.ok && y.ok);
  assert.equal(creates(raw), 2, "the race this guards against");
  assert.notEqual(x.value.input, y.value.input);
  // Through the room, the second waits for the first, finds its input and reuses it.
  const u = upstream();
  const room = liveRoom(u.fetchImpl);
  const results = await Promise.all([room.liveInput(CREATOR, { mint: MINT }), room.liveInput(CREATOR, { mint: MINT, title: "AMA" }), room.liveInput(CREATOR, { mint: MINT })]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(creates(u), 1, "one input for the coin");
  assert.equal(new Set(results.map((r) => r.ok && r.value.rtmps?.streamKey)).size, 1, "one stream key");
  // A failed request doesn't block the next one.
  const flaky = upstream({ rpcDown: true });
  const r2 = liveRoom(flaky.fetchImpl);
  assert.equal((await r2.liveInput(CREATOR, { mint: MINT })).ok, false);
  assert.equal((await r2.liveInput(STRANGER, { mint: MINT })).ok, false);
});

test("broadcast: the coin's existing input is reused; a new title updates it", async () => {
  const existing = { uid: "e".repeat(32), meta: { mint: MINT, creator: CREATOR, title: "Old" } };
  const reuse = upstream({ inputs: [{ uid: "f".repeat(32), meta: { mint: STRANGER } }, existing] });
  const r = await broadcastInput(env, CREATOR, { mint: MINT }, reuse.fetchImpl);
  assert.ok(r.ok);
  assert.equal(r.value.input, "e".repeat(32));
  assert.equal(r.value.rtmps?.streamKey, `key-${"e".repeat(32)}`, "credentials come from the single input");
  assert.equal(reuse.calls.filter((c) => c.url.startsWith("https://api.cloudflare.com") && (c.method === "POST" || c.method === "PUT")).length, 0, "nothing created or changed");
  const retitle = upstream({ inputs: [existing] });
  const r2 = await broadcastInput(env, CREATOR, { mint: MINT, title: "New title" }, retitle.fetchImpl);
  assert.ok(r2.ok);
  const put = retitle.calls.find((c) => c.method === "PUT")!;
  assert.deepEqual(put.body, { meta: { mint: MINT, creator: CREATOR, title: "New title" } });
});

test("broadcast: refused for anyone but the creator, bad input, missing config, upstream failures", async () => {
  const status = async (o: Parameters<typeof upstream>[0], wallet = CREATOR, body: unknown = { mint: MINT }, e: BroadcastEnv = env) => {
    const u = upstream(o);
    const r = await broadcastInput(e, wallet, body, u.fetchImpl);
    return { status: r.ok ? 200 : r.status, streamCalls: u.calls.filter((c) => c.url.startsWith("https://api.cloudflare.com")).length };
  };
  assert.deepEqual(await status({}, STRANGER), { status: 403, streamCalls: 0 }, "not the creator: no Stream call at all");
  assert.deepEqual(await status({ missing: true }), { status: 404, streamCalls: 0 }, "a demo coin isn't on chain");
  assert.equal((await status({}, CREATOR, { mint: "nope" })).status, 400);
  assert.equal((await status({}, CREATOR, { mint: MINT, title: 5 })).status, 400);
  for (const missing of ["CF_ACCOUNT_ID", "CF_STREAM_TOKEN", "STREAM_HOST", "SOLANA_RPC_URL"] as const)
    assert.equal((await status({}, CREATOR, { mint: MINT }, { ...env, [missing]: undefined })).status, 503, missing);
  assert.equal((await status({ rpcDown: true })).status, 502);
  assert.equal((await status({ streamDown: true })).status, 502);
});

test("broadcast: POST /live/input needs a wallet session; the answer is never cached", async () => {
  const u = upstream();
  const r = rooms(u.fetchImpl);
  const e = { ...env, MEDIA: { head: async () => null, put: async () => ({}) }, MEDIA_PUBLIC_URL: "https://media.parabull.test", ALLOWED_ORIGINS: APP, CHAT_SECRET: SECRET, CHAT_ROOMS: r.ns } as Env;
  const post = (auth: string | null, origin = APP) =>
    new Request("https://edge.test/live/input", { method: "POST", headers: { origin, "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ mint: MINT, title: "AMA" }) });
  assert.equal((await handle(post(null), e, 0, u.fetchImpl)).status, 401);
  assert.equal((await handle(post("Bearer forged"), e, 0, u.fetchImpl)).status, 401);
  const asStranger = await issueToken(SECRET, STRANGER, CHAT_SESSION_MS);
  assert.equal((await handle(post(`Bearer ${asStranger}`), e, 0, u.fetchImpl)).status, 403);
  const token = await issueToken(SECRET, CREATOR, CHAT_SESSION_MS);
  const res = await handle(post(`Bearer ${token}`), e, 0, u.fetchImpl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("access-control-allow-origin"), APP);
  assert.ok(((await res.json()) as { rtmps: { streamKey: string } }).rtmps.streamKey);
  assert.deepEqual([...r.made.keys()], [MINT], "handled in the coin's own room");
  // Racing requests through the Worker: one input.
  const racing = await Promise.all([1, 2, 3].map(() => handle(post(`Bearer ${token}`), e, 0, u.fetchImpl)));
  assert.equal(new Set(await Promise.all(racing.map(async (x) => ((await x.json()) as { input: string }).input))).size, 1);
  assert.equal(u.calls.filter((c) => c.method === "POST" && c.url.startsWith("https://api.cloudflare.com")).length, 1);
  // A bad mint never reaches a room; no CHAT_ROOMS binding fails closed.
  const bad = await handle(new Request("https://edge.test/live/input", { method: "POST", headers: { origin: APP, authorization: `Bearer ${token}` }, body: JSON.stringify({ mint: "../x" }) }), e, 0, u.fetchImpl);
  assert.equal(bad.status, 400);
  assert.deepEqual([...r.made.keys()], [MINT]);
  assert.equal((await handle(post(`Bearer ${token}`), { ...e, CHAT_ROOMS: undefined }, 0, u.fetchImpl)).status, 503);
  assert.equal((await handle(post(`Bearer ${token}`, "https://evil.test"), e, 0, u.fetchImpl)).status, 403);
  const pre = await handle(new Request("https://edge.test/live/input", { method: "OPTIONS", headers: { origin: APP } }), e, 0, u.fetchImpl);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /authorization/);
  const keys: string[] = [];
  const limited = { ...e, CHAT_LIMITER: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } };
  assert.equal((await handle(new Request("https://edge.test/live/input", { method: "POST", headers: { origin: APP, authorization: `Bearer ${token}`, "cf-connecting-ip": "203.0.113.1" }, body: "{}" }), limited, 0, u.fetchImpl)).status, 429);
  assert.deepEqual(keys, ["live-input:203.0.113.1"]);
});

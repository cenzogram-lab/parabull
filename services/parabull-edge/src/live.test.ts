import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { hlsUrl, LIVE_TTL_MS, liveStreams, resetLiveCache, streamHost, type LiveEnv } from "./live";
import { handle, type Env } from "./router";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const HOST = "customer-abc123.cloudflarestream.com";
const APP = "https://abcde-aaaaa-aaaaa-aaaaa-cai.icp0.io";
const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "DrLUh4S9VS1rsJwPKexAmJsUhpZa89At8ea11ASTCUGn";
const CREATOR = "7Z41mBaP2t5tbxJDRCGUdHC2Gw4dwbBgrmYzkFZq73cW";
const id = (c: string) => c.repeat(32);
const env: LiveEnv = { CF_ACCOUNT_ID: ACCOUNT, CF_STREAM_TOKEN: "token-123", STREAM_HOST: HOST };

/** A Stream API stand-in: the inputs listed, and which of them are live. */
function stream(inputs: unknown[], live: Set<string>, opts: { listStatus?: number; lifecycleFails?: Set<string> } = {}) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (url === `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/stream/live_inputs`) {
      const status = opts.listStatus ?? 200;
      return Response.json({ success: status === 200, errors: [], messages: [], result: { liveInputs: inputs, range: 0, total: inputs.length } }, { status });
    }
    const m = new RegExp(`^https://${HOST.replace(/\./g, "\\.")}/([0-9a-f]{32})/lifecycle$`).exec(url);
    if (m) {
      if (opts.lifecycleFails?.has(m[1])) return new Response("boom", { status: 500 });
      return Response.json({ isInput: true, videoUID: live.has(m[1]) ? "v".repeat(32) : null, live: live.has(m[1]) });
    }
    return new Response("unexpected", { status: 599 });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

beforeEach(resetLiveCache);

test("live: only enabled inputs for a coin mint that the lifecycle endpoint reports live", async () => {
  const inputs = [
    { uid: id("a"), enabled: true, meta: { mint: MINT_A, title: "  Dev AMA  ", creator: CREATOR } },
    { uid: id("b"), enabled: true, meta: { mint: MINT_B, name: "fallback name" } },
    { uid: id("c"), enabled: true, meta: { mint: MINT_A } }, // not live
    { uid: id("d"), enabled: false, meta: { mint: MINT_A } }, // disabled
    { uid: id("e"), enabled: true, meta: { mint: "not-a-mint" } },
    { uid: id("f"), enabled: true, meta: {} },
    { uid: "short", enabled: true, meta: { mint: MINT_A } },
  ];
  const s = stream(inputs, new Set([id("a"), id("b"), id("d"), id("e")]));
  const r = await liveStreams(env, 0, s.fetchImpl);
  assert.ok(r.ok);
  assert.deepEqual(r.streams, [
    { mint: MINT_A, input: id("a"), title: "Dev AMA", creator: CREATOR, hls: `https://${HOST}/${id("a")}/manifest/video.m3u8` },
    { mint: MINT_B, input: id("b"), title: "fallback name", creator: null, hls: `https://${HOST}/${id("b")}/manifest/video.m3u8` },
  ]);
  assert.ok(s.calls.every((c) => c.auth === "Bearer token-123"), "the API token goes with every call");
  assert.equal(s.calls.filter((c) => c.url.endsWith("/lifecycle")).length, 3, "lifecycle checked only for enabled inputs with a mint");
});

test("live: answers are cached for 15 seconds", async () => {
  const s = stream([{ uid: id("a"), enabled: true, meta: { mint: MINT_A } }], new Set([id("a")]));
  await liveStreams(env, 1_000, s.fetchImpl);
  await liveStreams(env, 1_000 + LIVE_TTL_MS - 1, s.fetchImpl);
  assert.equal(s.calls.length, 2, "one list + one lifecycle call for both requests");
  await liveStreams(env, 1_000 + LIVE_TTL_MS, s.fetchImpl);
  assert.equal(s.calls.length, 4, "refreshed after the TTL");
});

test("live: fails closed without configuration or when Stream fails", async () => {
  const s = stream([], new Set());
  for (const bad of [{}, { ...env, CF_ACCOUNT_ID: "nope" }, { ...env, CF_STREAM_TOKEN: "" }, { ...env, STREAM_HOST: "evil.example.com" }]) {
    const r = await liveStreams(bad as LiveEnv, 0, s.fetchImpl);
    assert.deepEqual(r, { ok: false, status: 503, error: "live streams are not configured" });
  }
  assert.equal(s.calls.length, 0, "nothing was called");
  const down = stream([], new Set(), { listStatus: 500 });
  assert.equal(((await liveStreams(env, 0, down.fetchImpl)) as { status: number }).status, 502, "an API error isn't 'nobody is live'");
  resetLiveCache();
  const thrown = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  assert.equal(((await liveStreams(env, 0, thrown)) as { status: number }).status, 502);
  // A single input whose lifecycle check fails is treated as not live; the rest still answer.
  resetLiveCache();
  const partial = stream(
    [
      { uid: id("a"), enabled: true, meta: { mint: MINT_A } },
      { uid: id("b"), enabled: true, meta: { mint: MINT_B } },
    ],
    new Set([id("a"), id("b")]),
    { lifecycleFails: new Set([id("a")]) },
  );
  const r = await liveStreams(env, 0, partial.fetchImpl);
  assert.ok(r.ok);
  assert.deepEqual(r.streams.map((x) => x.mint), [MINT_B]);
});

test("live: stream host and HLS URL formats", () => {
  assert.equal(streamHost("customer-abc123.cloudflarestream.com"), HOST);
  assert.equal(streamHost("https://customer-abc123.cloudflarestream.com/"), HOST);
  for (const bad of ["cloudflarestream.com", "customer-abc.evil.com", "customer-ABC.cloudflarestream.com.evil.com", undefined]) assert.equal(streamHost(bad), null, String(bad));
  assert.equal(hlsUrl(HOST, id("a")), `https://${HOST}/${id("a")}/manifest/video.m3u8`);
});

test("live: GET /live through the router, allowed origins only, cacheable", async () => {
  const s = stream([{ uid: id("a"), enabled: true, meta: { mint: MINT_A, title: "AMA" } }], new Set([id("a")]));
  const e = { ...env, MEDIA: { head: async () => null, put: async () => ({}) }, MEDIA_PUBLIC_URL: "https://media.parabull.test", ALLOWED_ORIGINS: APP } as Env;
  const res = await handle(new Request("https://edge.test/live", { headers: { origin: APP } }), e, 0, s.fetchImpl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), APP);
  assert.equal(res.headers.get("cache-control"), "public, max-age=15");
  const body = (await res.json()) as { streams: { mint: string; hls: string }[] };
  assert.deepEqual(body.streams.map((x) => x.mint), [MINT_A]);
  assert.equal((await handle(new Request("https://edge.test/live", { headers: { origin: "https://evil.test" } }), e, 0, s.fetchImpl)).status, 403);
  assert.equal((await handle(new Request("https://edge.test/live", { method: "POST", headers: { origin: APP } }), e, 0, s.fetchImpl)).status, 405);
  resetLiveCache();
  const off = await handle(new Request("https://edge.test/live", { headers: { origin: APP } }), { ...e, CF_STREAM_TOKEN: undefined }, 0, s.fetchImpl);
  assert.equal(off.status, 503);
  assert.deepEqual(((await off.json()) as { streams: unknown[] }).streams, []);
});

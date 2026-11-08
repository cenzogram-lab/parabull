import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectSources, contentSecurityPolicy, headersFile, originOf, rpcWebsocketOrigin } from "../src/lib/icHeaders";
import { dexScreenerUrl, raydiumSwapUrl } from "../src/lib/links";

test("IC hosting: RPC websocket origin follows web3.js (wss for https, port + 1)", () => {
  assert.equal(rpcWebsocketOrigin("https://api.devnet.solana.com"), "wss://api.devnet.solana.com");
  assert.equal(rpcWebsocketOrigin("https://mainnet.helius-rpc.com/?api-key=abc"), "wss://mainnet.helius-rpc.com");
  assert.equal(rpcWebsocketOrigin("http://127.0.0.1:8899"), "ws://127.0.0.1:8900");
  assert.equal(rpcWebsocketOrigin("https://rpc.example.com:8443/x"), "wss://rpc.example.com:8444");
  assert.equal(rpcWebsocketOrigin("not a url"), null);
  assert.equal(originOf("https://sentinel.example.com/api"), "https://sentinel.example.com");
  assert.equal(originOf("ftp://x"), null);
});

test("IC hosting: connect-src covers the configured endpoints, hosted RPCs, websockets, price APIs and wallets", () => {
  const src = connectSources({
    VITE_CLUSTER: "mainnet-beta",
    VITE_RPC_URL: "https://my-node.example.com/rpc?token=secret",
    VITE_SENTINEL_URL: "https://sentinel.example.com",
    VITE_METADATA_UPLOAD_URL: "https://upload.example.com/pin",
    VITE_REWARDS_BASE_URL: "https://rewards.example.com/epochs/",
  });
  for (const s of [
    "'self'",
    "https://my-node.example.com",
    "wss://my-node.example.com",
    "https://sentinel.example.com",
    "https://upload.example.com",
    "https://rewards.example.com",
    "https://api.devnet.solana.com",
    "wss://api.mainnet-beta.solana.com",
    "https://*.helius-rpc.com",
    "wss://*.helius-rpc.com",
    "https://*.quiknode.pro",
    "wss://*.quiknode.pro",
    "https://*.rpcpool.com",
    "wss://*.rpcpool.com",
    "https://lite-api.jup.ag",
    "https://api.coingecko.com",
    "ws://localhost:*",
    "https://id.ai",
    "https://identity.ic0.app",
    "https://icp-api.io",
    "https://*.icp0.io",
  ])
    assert.ok(src.includes(s), s);
  assert.ok(!src.join(" ").includes("secret"), "only origins: an RPC URL's path or query (API keys) never lands in the header");
  // With nothing configured, the cluster default RPC is still allowed.
  assert.ok(connectSources({}).includes("https://api.devnet.solana.com"));
  assert.ok(connectSources({ VITE_CLUSTER: "localnet" }).includes("ws://127.0.0.1:8900"));
});

test("IC hosting: the CSP stays strict and the _headers file is well formed", () => {
  const csp = contentSecurityPolicy({});
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /googleapis|gstatic/, "no third-party fonts");
  assert.match(csp, /frame-src [^;]*https:\/\/id\.ai[^;]*https:\/\/identity\.ic0\.app/, "Internet Identity can be framed if ever embedded");
  assert.doesNotMatch(headersFile({}), /Cross-Origin-Opener-Policy/, "no COOP: it would cut the II popup off from the page");
  const file = headersFile({});
  const blocks = file.split("\n").filter((l) => l && !l.startsWith(" ") && !l.startsWith("#"));
  assert.deepEqual(blocks, ["/*", "/assets/*", "/*.html"]);
  // The certified-assets sync plugin rejects these headers outright.
  for (const reserved of ["Content-Length", "Content-Encoding", "ETag", "Transfer-Encoding", "Accept-Ranges", "Content-Range", "IC-Certificate", "Location"])
    assert.ok(!new RegExp(`^\\s+${reserved}:`, "mi").test(file), reserved);
});

test("IC hosting: _redirects rewrites client routes to the shell and 404s missing build assets", () => {
  const rules = readFileSync(new URL("../public/_redirects", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/));
  assert.deepEqual(rules, [
    ["/assets/*", "/404.html", "404"],
    ["/*", "/index.html", "200"],
  ]);
});

test("graduated coins link to their Raydium pool and DexScreener", () => {
  const mint = "DrLUh4S9VS1rsJwPKexAmJsUhpZa89At8ea11ASTCUGn";
  assert.equal(raydiumSwapUrl(mint), `https://raydium.io/swap/?inputMint=sol&outputMint=${mint}`);
  assert.equal(dexScreenerUrl(mint), `https://dexscreener.com/solana/${mint}`);
});

test("IC hosting: media CDN, chat socket and stream host open connect-src and media-src, nothing else", async () => {
  const { mediaSources, socketOrigins, streamOrigin } = await import("../src/lib/icHeaders");
  const env = {
    VITE_MEDIA_URL: "https://media.parabull.xyz/",
    VITE_CHAT_URL: "wss://edge.parabull.xyz/chat",
    VITE_STREAM_HOST: "customer-abc123.cloudflarestream.com",
  };
  const connect = connectSources(env);
  for (const o of ["https://media.parabull.xyz", "wss://edge.parabull.xyz", "https://edge.parabull.xyz", "https://customer-abc123.cloudflarestream.com"]) assert.ok(connect.includes(o), o);
  assert.deepEqual(mediaSources(env), ["'self'", "blob:", "https://media.parabull.xyz", "https://customer-abc123.cloudflarestream.com"]);
  const csp = contentSecurityPolicy(env);
  assert.match(csp, /media-src 'self' blob: https:\/\/media\.parabull\.xyz https:\/\/customer-abc123\.cloudflarestream\.com(;|$)/);
  // Unset: no extra origins, and video only from the app itself (plus blob: for hls.js).
  assert.match(contentSecurityPolicy({}), /media-src 'self' blob:(;|$)/);
  assert.ok(!connectSources({}).some((o) => /parabull\.xyz|cloudflarestream/.test(o)));

  assert.deepEqual(socketOrigins("https://edge.parabull.xyz/chat"), ["wss://edge.parabull.xyz", "https://edge.parabull.xyz"]);
  assert.deepEqual(socketOrigins("ws://127.0.0.1:8787"), ["ws://127.0.0.1:8787", "http://127.0.0.1:8787"]);
  assert.deepEqual(socketOrigins("ftp://x.test"), []);
  assert.deepEqual(socketOrigins("not a url"), []);
  assert.equal(streamOrigin("https://customer-abc123.cloudflarestream.com/"), "https://customer-abc123.cloudflarestream.com");
  for (const bad of ["http://customer-abc.cloudflarestream.com", "customer abc", "localhost", "https://u:p@customer-abc.cloudflarestream.com", "*.cloudflarestream.com"])
    assert.equal(streamOrigin(bad), null, bad);
});

test("IC hosting: camera and microphone only for a streaming build, and only for this origin", async () => {
  const { permissionsPolicy, headersFile } = await import("../src/lib/icHeaders");
  assert.equal(permissionsPolicy({}), "camera=(), microphone=(), geolocation=(), payment=()");
  assert.equal(permissionsPolicy({ VITE_STREAM_HOST: "customer-abc123.cloudflarestream.com" }), "camera=(self), microphone=(self), geolocation=(), payment=()");
  assert.equal(permissionsPolicy({ VITE_STREAM_HOST: "not a host" }), "camera=(), microphone=(), geolocation=(), payment=()");
  assert.match(headersFile({}), /Permissions-Policy: camera=\(\), microphone=\(\)/);
});

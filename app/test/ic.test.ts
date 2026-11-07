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
    "https://lite-api.jup.ag",
    "https://api.coingecko.com",
    "ws://localhost:*",
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

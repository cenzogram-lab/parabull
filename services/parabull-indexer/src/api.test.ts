import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { Api, type ApiOptions } from "./api";
import { Indexer } from "./indexer";
import { MockChain, addressOf } from "./mockChain";
import type { CoinJson, TradeJson } from "./model";
import { Rpc } from "./rpc";
import { wsUrlFor } from "./main";

const ALICE = addressOf("alice");
const BOB = addressOf("bob");
const APP = "https://app.parabull.test";

async function serve(t: TestContext, apiOpts: ApiOptions = {}) {
  const chain = new MockChain();
  await chain.initGlobal();
  const ix = new Indexer({ rpc: new Rpc("http://rpc.test", chain.fetch, 2_000), now: () => chain.time * 1000 });
  const api = new Api(ix, apiOpts);
  const server: Server = api.attach(createServer());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { headers });
    return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as any };
  };
  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    api.closeStreams();
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  };
  // Closed however the test ends, so a failed assertion fails the test instead of hanging the run.
  t.after(close);
  return { chain, ix, api, server, base, get, close };
}

async function launch(chain: MockChain, symbol: string, n: bigint) {
  const ticket = chain.requestLaunch(ALICE, symbol, n);
  const mint = addressOf(`mint:${symbol}`);
  await chain.create(ticket, { mint, name: `${symbol} coin`, symbol, uri: "" });
  return { ticket, mint };
}

test("api: GET /coins filters, sorts and pages with a cursor; bad parameters are 400", async (t) => {
  const s = await serve(t);
  const mints: string[] = [];
  for (const [i, sym] of ["AAA", "BBB", "CCC", "DDD", "EEE"].entries()) {
    const { mint } = await launch(s.chain, sym, BigInt(i + 1));
    mints.push(mint);
    await s.chain.trade(mint, BOB, true, BigInt(i + 1) * 10_000_000_000_000n);
  }
  await s.ix.start();
  const health = await s.get("/health");
  assert.equal(health.body.coins, 5);

  const p1 = await s.get("/coins?sort=mcap&limit=2");
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.body.coins.map((c: CoinJson) => c.symbol), ["EEE", "DDD"]);
  assert.equal(p1.body.next, "2");
  const p2 = await s.get(`/coins?sort=mcap&limit=2&cursor=${p1.body.next}`);
  const p3 = await s.get(`/coins?sort=mcap&limit=2&cursor=${p2.body.next}`);
  assert.deepEqual([...p2.body.coins, ...p3.body.coins].map((c: CoinJson) => c.symbol), ["CCC", "BBB", "AAA"]);
  assert.equal(p3.body.next, null);
  assert.deepEqual((await s.get("/coins?sort=new")).body.coins.map((c: CoinJson) => c.symbol), ["EEE", "DDD", "CCC", "BBB", "AAA"]);
  assert.equal((await s.get("/coins?status=new")).body.coins.length, 5);
  assert.equal((await s.get("/coins?status=graduated")).body.coins.length, 0);
  const c = p1.body.coins[0] as CoinJson;
  assert.equal(typeof c.reserves.virtualSol, "string");
  assert.equal(c.stats.buys24h, 1);
  assert.ok(c.mcapSol > 0 && c.progress > 0 && c.priceSol > 0);
  for (const bad of ["/coins?sort=hype", "/coins?status=dead", "/coins?limit=0", "/coins?limit=x", "/coins?cursor=-1"]) assert.equal((await s.get(bad)).status, 400, bad);
  assert.equal(p1.headers.get("access-control-allow-origin"), "*");
  await s.close();
});

test("api: GET /coins/:mint finds a coin created since the last poll; trades page newest first", async (t) => {
  const s = await serve(t);
  await s.ix.start();
  const { mint } = await launch(s.chain, "NEWB", 1n); // on-chain, not yet indexed
  const r = await s.get(`/coins/${mint}`);
  assert.equal(r.status, 200, "no 'Coin not found' for a coin that exists");
  assert.equal(r.body.symbol, "NEWB");
  assert.equal(r.body.status, "new");
  assert.equal((await s.get(`/coins/${addressOf("nothing")}`)).status, 404);
  assert.equal((await s.get("/coins/not-an-address")).status, 400);

  for (let i = 0; i < 7; i++) await s.chain.trade(mint, i % 2 ? ALICE : BOB, i !== 3, 1_000_000_000_000n);
  await s.ix.pollTransactions();
  const a = await s.get(`/coins/${mint}/trades?limit=3`);
  const b = await s.get(`/coins/${mint}/trades?limit=3&before=${encodeURIComponent(a.body.next)}`);
  const c = await s.get(`/coins/${mint}/trades?limit=3&before=${encodeURIComponent(b.body.next)}`);
  const all = [...a.body.trades, ...b.body.trades, ...c.body.trades] as TradeJson[];
  assert.equal(all.length, 7);
  assert.equal(c.body.next, null);
  assert.ok(all.every((t, i) => i === 0 || t.slot <= all[i - 1].slot), "newest first");
  assert.equal(new Set(all.map((t) => t.signature)).size, 7);
  assert.deepEqual(all.map((t) => t.side), ["buy", "buy", "buy", "sell", "buy", "buy", "buy"]);
  assert.equal(typeof all[0].solAmount, "string");
  assert.equal((await s.get(`/coins/${mint}/trades?before=nope`)).status, 400);
  await s.close();
});

test("api: holders, portfolio and tickets", async (t) => {
  const s = await serve(t);
  const { mint, ticket } = await launch(s.chain, "HOLD", 1n);
  await s.chain.trade(mint, BOB, true, 20_000_000_000_000n);
  const pending = s.chain.requestLaunch(BOB, "NEXT", 9n);
  await s.ix.start();

  const h = await s.get(`/coins/${mint}/holders?limit=1`);
  assert.equal(h.status, 200);
  assert.equal(h.body.count, 2);
  assert.equal(h.body.holders.length, 1);
  assert.equal(h.body.holders[0].label, "bonding_curve");

  const p = await s.get(`/portfolio/${BOB}`);
  assert.equal(p.status, 200);
  assert.equal(p.body.holdings[0].mint, mint);
  assert.equal(p.body.holdings[0].coin.symbol, "HOLD");
  assert.equal(p.body.trades.length, 1);
  assert.equal(p.body.trades[0].user, BOB);
  assert.equal((await s.get("/portfolio/xyz")).status, 400);

  assert.deepEqual([(await s.get(`/tickets/${ticket}`)).body.state, (await s.get(`/tickets/${ticket}`)).body.mint], ["created", mint]);
  const mine = await s.get(`/tickets?payer=${BOB}`);
  assert.deepEqual(mine.body.tickets.map((t: { ticket: string; state: string }) => [t.ticket, t.state]), [[pending, "pending"]]);
  assert.equal((await s.get(`/tickets/${addressOf("x")}`)).status, 404);
  assert.equal((await s.get("/tickets?payer=")).status, 400);
  await s.close();
});

test("api: per-IP limit on RPC-backed requests, 502 when the RPC is down, CORS allowlist", async (t) => {
  const s = await serve(t, { rpcRequestsPerMinute: 2, allowedOrigins: [APP] });
  const { mint } = await launch(s.chain, "LIM", 1n);
  await s.ix.start();
  assert.equal((await s.get(`/coins/${mint}/holders`)).status, 200);
  assert.equal((await s.get(`/portfolio/${BOB}`)).status, 200);
  assert.equal((await s.get(`/coins/${mint}/holders`)).status, 429);
  assert.equal((await s.get(`/coins/${mint}`)).status, 200, "indexed reads aren't limited");

  const u = await serve(t);
  await u.ix.start();
  u.chain.failing = "getTokenAccountsByOwner";
  const down = await u.get(`/portfolio/${BOB}`);
  assert.deepEqual([down.status, down.body.error], [502, "Solana RPC unavailable"]);

  const ok = await s.get(`/coins/${mint}`, { origin: APP });
  assert.equal(ok.headers.get("access-control-allow-origin"), APP);
  const other = await s.get(`/coins/${mint}`, { origin: "https://evil.test" });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  assert.equal((await fetch(`${s.base}/coins`, { method: "POST" })).status, 405);
  await s.close();
  await u.close();
});

test("api: /stream pushes trades and coin updates (all, or one mint); origins outside the allowlist are refused", async (t) => {
  const s = await serve(t, { allowedOrigins: [APP] });
  const a = await launch(s.chain, "AAA", 1n);
  const b = await launch(s.chain, "BBB", 2n);
  await s.ix.start();
  const wsBase = s.base.replace("http", "ws");
  const open = (path: string, origin = APP) =>
    new Promise<{ ws: WebSocket; got: any[] }>((resolve, reject) => {
      const ws = new WebSocket(wsBase + path, { headers: { origin } } as never);
      const got: any[] = [];
      ws.addEventListener("message", (e) => got.push(JSON.parse(String(e.data))));
      ws.addEventListener("open", () => resolve({ ws, got }));
      ws.addEventListener("error", () => reject(new Error("refused")));
    });
  const all = await open("/stream");
  const onlyA = await open(`/stream?mint=${a.mint}`);
  try {
  assert.equal(s.api.streamCount, 2);
  await s.chain.trade(a.mint, BOB, true, 1_000_000_000_000n);
  await s.chain.trade(b.mint, BOB, true, 1_000_000_000_000n);
  await s.ix.pollTransactions();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(all.got.filter((m) => m.type === "trade").map((m) => m.trade.mint), [a.mint, b.mint]);
  assert.ok(all.got.some((m) => m.type === "coin" && m.coin.mint === b.mint && m.coin.stats.buys24h === 1));
  assert.ok(onlyA.got.length > 0 && onlyA.got.every((m) => (m.trade ?? m.coin).mint === a.mint), "the mint filter holds");
  await assert.rejects(open("/stream", "https://evil.test"));
  await assert.rejects(open("/stream?mint=bad"));
  all.ws.close();
  onlyA.ws.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.api.streamCount, 0, "closed sockets are dropped");
  } finally {
    all.ws.close();
    onlyA.ws.close();
    await s.close();
  }
});

test("main: the RPC websocket URL is derived from RPC_URL", () => {
  assert.equal(wsUrlFor("https://api.devnet.solana.com"), "wss://api.devnet.solana.com/");
  assert.equal(wsUrlFor("http://127.0.0.1:8899"), "ws://127.0.0.1:8900/");
  assert.equal(wsUrlFor("https://rpc.example.com/v1/key"), "wss://rpc.example.com/v1/key");
});

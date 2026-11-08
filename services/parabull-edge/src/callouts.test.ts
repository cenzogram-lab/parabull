import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CALLOUT_MAX_CHARS, isCalloutId, newCalloutId, normalizeCalloutText, parseRefMemo, refMemo, type CalloutJson } from "../../../app/src/lib/callouts";
import { CalloutStoreCore, DAILY_LIMIT } from "./callouts";
import { handle, type ChatNamespace, type Env } from "./router";
import { issueToken } from "./session";

const APP = "https://abcde-aaaaa-aaaaa-aaaaa-cai.icp0.io";
const SECRET = "s".repeat(40);
const RPC = "https://rpc.test";
const INDEXER = "https://indexer.test";
const MINT = "DrLUh4S9VS1rsJwPKexAmJsUhpZa89At8ea11ASTCUGn";
const OTHER_MINT = "CWh5S2rBmLoHGSvGfSHQDkUhZzCxAGVDYbspyu2MN7R2";
const ALICE = "7Z41mBaP2t5tbxJDRCGUdHC2Gw4dwbBgrmYzkFZq73cW";
const BOB = "J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf";
const T0 = 1_800_000_000_000;

function sqlStorage(db: DatabaseSync) {
  return {
    exec<T>(query: string, ...bindings: unknown[]) {
      const st = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? (st.all(...(bindings as never[])) as T[]) : (st.run(...(bindings as never[])), [] as T[]);
      return { toArray: () => rows };
    },
  };
}

/** The Worker with a CalloutStore stand-in (node:sqlite), a fake RPC (balances) and a fake indexer (coins). */
function world(over: Partial<Env> = {}) {
  const db = new DatabaseSync(":memory:");
  let now = T0;
  let seed = 0;
  const store = new CalloutStoreCore({ sql: sqlStorage(db) }, { now: () => now, randomBytes: (n) => Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) >>> 0) & 0xff) });
  const ns: ChatNamespace = { idFromName: (n) => n, get: (id) => (assert.equal(id, "callouts"), { fetch: (r) => store.fetch(r) }) };
  const balances = new Map<string, { mint: string; amount: string }[]>([[ALICE, [{ mint: MINT, amount: "25000000" }, { mint: OTHER_MINT, amount: "9" }]], [BOB, [{ mint: MINT, amount: "999999" }]]]);
  const coins = new Map([[MINT, { mint: MINT, mcapSol: 41.5, priceSol: 0.0000000415 }]]);
  const down = { rpc: false, indexer: false };
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === RPC) {
      if (down.rpc) return new Response("down", { status: 503 });
      const { params } = JSON.parse(String(init?.body)) as { params: [string, { mint: string }] };
      const [wallet, { mint }] = params;
      // Two accounts for Alice's MINT balance, to check they're summed; other mints are ignored.
      const rows = (balances.get(wallet) ?? []).flatMap((b) => (b.mint === mint ? (wallet === ALICE ? [{ ...b, amount: String(BigInt(b.amount) - 5n) }, { ...b, amount: "5" }] : [b]) : []));
      return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: rows.map((b) => ({ pubkey: "x", account: { data: { parsed: { info: { mint: b.mint, tokenAmount: { amount: b.amount } } } } } })) } });
    }
    if (url.startsWith(`${INDEXER}/coins/`)) {
      if (down.indexer) throw new TypeError("fetch failed");
      const c = coins.get(url.slice(`${INDEXER}/coins/`.length));
      return c ? Response.json(c) : Response.json({ error: "not found" }, { status: 404 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const env: Env = { MEDIA: { head: async () => null, put: async () => ({}) }, MEDIA_PUBLIC_URL: "https://media.test", ALLOWED_ORIGINS: APP, CHAT_SECRET: SECRET, CALLOUTS: ns, SOLANA_RPC_URL: RPC, INDEXER_URL: INDEXER, ...over };
  const token = (wallet: string) => issueToken(SECRET, wallet, now + 3_600_000);
  const call = async (method: string, path: string, o: { wallet?: string; body?: unknown; origin?: string | null } = {}) => {
    const headers: Record<string, string> = {};
    if (o.origin !== null) headers.origin = o.origin ?? APP;
    if (o.wallet) headers.authorization = `Bearer ${await token(o.wallet)}`;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await handle(new Request(`https://edge.test${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, now, fetchImpl);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: string; callout?: CalloutJson; callouts?: CalloutJson[]; next?: string | null }, headers: res.headers };
  };
  return { db, env, call, calls, down, balances, coins, clock: { advance: (ms: number) => (now += ms), now: () => now } };
}

test("callouts lib: ids, the referral memo and the text rules", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newCalloutId((n) => crypto.getRandomValues(new Uint8Array(n)))));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.ok(isCalloutId(id), id);
  // Bytes 232-255 are skipped (4 * 58 = 232), so every character is equally likely.
  assert.equal(newCalloutId(() => Uint8Array.from([255, 254, 233, 232, ...Array(30).fill(0)])), "111111111111");
  assert.equal(parseRefMemo(refMemo("AbCdEfGhJkLm")), "AbCdEfGhJkLm");
  for (const bad of ["parabull:ref:short", "parabull:ref:AbCdEfGhJkL0", "parabull:ref:AbCdEfGhJkLmn", "other:AbCdEfGhJkLm", " parabull:ref:AbCdEfGhJkLm"]) assert.equal(parseRefMemo(bad), null, bad);
  assert.equal(normalizeCalloutText("  to\nthe   moon ‮​ "), "to the moon");
  assert.equal(normalizeCalloutText("🐂".repeat(CALLOUT_MAX_CHARS)), "🐂".repeat(CALLOUT_MAX_CHARS), "counted in characters, not UTF-16 units");
  for (const bad of ["", "   \n ", "x".repeat(CALLOUT_MAX_CHARS + 1), 42, null]) assert.equal(normalizeCalloutText(bad), null);
});

test("POST /callouts: a signed-in holder's call is stored with the coin's market cap now; GET lists it", async () => {
  const w = world();
  const posted = await w.call("POST", "/callouts", { wallet: ALICE, body: { mint: MINT, text: "  Charging   past 40 SOL  " } });
  assert.equal(posted.status, 201, posted.body.error);
  const c = posted.body.callout!;
  assert.ok(isCalloutId(c.id));
  assert.deepEqual({ ...c, id: "" }, { id: "", wallet: ALICE, mint: MINT, text: "Charging past 40 SOL", calledAtMcapSol: 41.5, calledAtPriceSol: 0.0000000415, holding: "25000000", ts: T0 });
  assert.equal(posted.headers.get("access-control-allow-origin"), APP);
  const list = await w.call("GET", "/callouts");
  assert.deepEqual(list.body, { callouts: [c], next: null });
  assert.equal(list.headers.get("cache-control"), "public, max-age=5");
  assert.deepEqual((await w.call("GET", `/callouts/${c.id}`)).body, { callout: c });
  assert.equal((await w.call("GET", "/callouts/AbCdEfGhJkLm")).status, 404);
  assert.equal((await w.call("GET", "/callouts/nope")).status, 400);
});

test("GET /callouts: filters by coin, author and ids, newest first, paged", async () => {
  const w = world();
  w.balances.set(BOB, [{ mint: MINT, amount: "5000000" }]);
  w.coins.set(OTHER_MINT, { mint: OTHER_MINT, mcapSol: 30, priceSol: 0.00000003 });
  w.balances.get(ALICE)!.push({ mint: OTHER_MINT, amount: "7000000" });
  const made: CalloutJson[] = [];
  for (const [wallet, mint] of [[ALICE, MINT], [BOB, MINT], [ALICE, OTHER_MINT]] as const) {
    const r = await w.call("POST", "/callouts", { wallet, body: { mint, text: `${wallet.slice(0, 4)} on ${mint.slice(0, 4)}` } });
    assert.equal(r.status, 201, r.body.error);
    made.push(r.body.callout!);
    w.clock.advance(60_000);
  }
  const ids = (r: { body: { callouts?: CalloutJson[] } }) => r.body.callouts!.map((c) => c.id);
  assert.deepEqual(ids(await w.call("GET", "/callouts")), [made[2].id, made[1].id, made[0].id]);
  assert.deepEqual(ids(await w.call("GET", `/callouts?mint=${MINT}`)), [made[1].id, made[0].id]);
  assert.deepEqual(ids(await w.call("GET", `/callouts?author=${ALICE}`)), [made[2].id, made[0].id]);
  assert.deepEqual(ids(await w.call("GET", `/callouts?ids=${made[0].id},${made[2].id}`)), [made[2].id, made[0].id]);
  const p1 = await w.call("GET", "/callouts?limit=2");
  assert.equal(p1.body.callouts!.length, 2);
  const p2 = await w.call("GET", `/callouts?limit=2&before=${p1.body.next}`);
  assert.deepEqual(ids(p2), [made[0].id]);
  assert.equal(p2.body.next, null);
  for (const q of ["mint=nope", "author=x", "ids=", "ids=bad", "limit=0", "limit=101", "before=-1"]) assert.equal((await w.call("GET", `/callouts?${q}`)).status, 400, q);
});

test("POST /callouts: refused without a session, a holding, a Parabull coin, a good body or the services", async () => {
  const w = world();
  assert.equal((await w.call("POST", "/callouts", { body: { mint: MINT, text: "hi" } })).status, 401);
  assert.equal((await w.call("POST", "/callouts", { wallet: ALICE, body: { mint: MINT, text: "hi" }, origin: "https://evil.test" })).status, 403);
  assert.equal((await w.call("POST", "/callouts", { wallet: ALICE, body: { mint: "nope", text: "hi" } })).status, 400);
  assert.equal((await w.call("POST", "/callouts", { wallet: ALICE, body: { mint: MINT, text: " \n " } })).status, 400);
  assert.equal((await w.call("POST", "/callouts", { wallet: ALICE, body: { mint: MINT, text: "x".repeat(281) } })).status, 400);
  // Bob holds 0.999999 tokens: under the 1-token minimum.
  const notHeld = await w.call("POST", "/callouts", { wallet: BOB, body: { mint: MINT, text: "trust me" } });
  assert.deepEqual([notHeld.status, notHeld.body.error], [403, "you can only call out a coin you hold"]);
  const notCoin = await w.call("POST", "/callouts", { wallet: ALICE, body: { mint: OTHER_MINT, text: "hi" } });
  assert.deepEqual([notCoin.status, notCoin.body.error], [404, "not a Parabull coin"]);
  w.down.rpc = true;
  assert.equal((await w.call("POST", "/callouts", { wallet: ALICE, body: { mint: MINT, text: "hi" } })).status, 502);
  w.down.rpc = false;
  w.down.indexer = true;
  assert.equal((await w.call("POST", "/callouts", { wallet: ALICE, body: { mint: MINT, text: "hi" } })).status, 502);
  const unconfigured = world({ INDEXER_URL: undefined });
  assert.equal((await unconfigured.call("POST", "/callouts", { wallet: ALICE, body: { mint: MINT, text: "hi" } })).status, 503);
  const noStore = world({ CALLOUTS: undefined });
  assert.equal((await noStore.call("GET", "/callouts")).status, 503);
  // Nothing was stored, and reading never created the table.
  assert.deepEqual((await w.call("GET", "/callouts")).body, { callouts: [], next: null });
  assert.equal(w.db.prepare("SELECT name FROM sqlite_master WHERE name = 'callouts'").all().length, 0);
  assert.equal((await w.call("PUT", "/callouts", { wallet: ALICE, body: {} })).status, 405);
  assert.equal((await w.call("POST", "/callouts/AbCdEfGhJkLm", { wallet: ALICE, body: {} })).status, 405);
  const pre = await handle(new Request("https://edge.test/callouts", { method: "OPTIONS", headers: { origin: APP } }), w.env);
  assert.equal(pre.headers.get("access-control-allow-headers"), "authorization, content-type");
});

test("POST /callouts: per-wallet limits (30 s apart, one per coin an hour, 20 a day)", async () => {
  const w = world();
  const post = () => w.call("POST", "/callouts", { wallet: ALICE, body: { mint: MINT, text: "again" } });
  assert.equal((await post()).status, 201);
  w.clock.advance(10_000);
  assert.deepEqual([(await post()).status, (await post()).body.error], [429, "one callout every 30 seconds"]);
  w.clock.advance(30_000);
  assert.equal((await post()).body.error, "one callout per coin an hour");
  w.clock.advance(3_600_000);
  assert.equal((await post()).status, 201);
  // The daily cap counts every coin: fill it with other coins' callouts.
  const store = new CalloutStoreCore({ sql: sqlStorage(w.db) }, { now: w.clock.now, randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)) });
  for (let i = 0; i < DAILY_LIMIT - 2; i++) {
    w.clock.advance(31_000);
    assert.equal(store.post({ wallet: ALICE, mint: `coin${i}`.padEnd(32, "x"), text: "x", calledAtMcapSol: 1, calledAtPriceSol: 1, holding: "1" }).ok, true, `#${i}`);
  }
  w.clock.advance(3_600_000);
  assert.equal((await post()).body.error, `at most ${DAILY_LIMIT} callouts a day`);
  // Another wallet isn't affected.
  w.balances.set(BOB, [{ mint: MINT, amount: "1000000" }]);
  assert.equal((await w.call("POST", "/callouts", { wallet: BOB, body: { mint: MINT, text: "mine" } })).status, 201);
});

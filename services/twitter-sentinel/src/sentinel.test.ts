/**
 * End to end in dry-run mode, against a fake chain: the settings API, linking and replacing an X session without a
 * restart, disconnecting, who may do each, and the milestone and reply loops.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair } from "@solana/web3.js";
import { DEFAULT_SETTINGS, sentinelMessage, type SentinelSettings, type SentinelStatus, type XSession } from "../../../app/src/lib/sentinelMessage";
import { XRegistry } from "./accounts";
import { payloadDigest } from "./auth";
import type { ChainSource, CurveState } from "./chain";
import { graduationRaise } from "./milestones";
import type { MentionTweet } from "./replies";
import { keyFromSecret } from "./seal";
import { Sentinel } from "./sentinel";
import { createApi } from "./server";
import { Store } from "./store";
import { DryRunX } from "./x";

const RAISE = graduationRaise({ virtualToken: 1_073_000_000_000_000n, virtualSol: 30_000_000_000n, realToken: 793_100_000_000_000n });
const at = (f: number, migrated = false): Omit<CurveState, "creator"> => ({ realSol: (RAISE * BigInt(Math.round(f * 1000)) + 999n) / 1000n, complete: f >= 1, migrated });
const cookie = (c: string) => c.repeat(40);

function harness(opts: { secret?: string; operatorUsername?: string } = {}) {
  const creator = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const operator = opts.operatorUsername ? { [mint]: { username: opts.operatorUsername, authToken: cookie("e"), ct0: cookie("f") } } : {};
  const state = { curve: { ...at(0.3), creator: creator.publicKey.toBase58() } as CurveState, watching: 0, mentions: [] as MentionTweet[], curveReads: 0 };
  const chain: ChainSource = {
    curve: async () => (state.curveReads++, state.curve),
    raise: async () => RAISE,
    ticker: async () => "BULL",
    watch: () => {
      state.watching++;
      return () => void state.watching--;
    },
  };
  /** Every client the registry creates, by handle, so the test can see who posted. */
  const clients = new Map<string, DryRunX>();
  let clock = Date.parse("2026-11-04T12:00:00Z");
  const now = () => clock;
  const dir = mkdtempSync(join(tmpdir(), "sentinel-"));
  const store = new Store(dir);
  const accounts = new XRegistry({
    store,
    key: keyFromSecret(opts.secret),
    operator,
    make: (a) => {
      const c = new DryRunX(a.username, () => {}, () => state.mentions);
      clients.set(a.username, c);
      return c;
    },
  });
  const sentinel = new Sentinel({ store, chain, xFor: (m) => accounts.for(m), coinUrl: (m) => `https://parabull.app/coin/${m}`, now, log: () => {} });
  const api = createApi({ store, chain, sentinel, accounts, dryRun: true, allowedOrigins: ["https://parabull.app"], now });
  const signed = (action: "update settings" | "disconnect", settings: SentinelSettings | null, session: XSession | null, signer: Keypair, issuedAt: string) =>
    Buffer.from(ed25519.sign(new TextEncoder().encode(sentinelMessage(action, mint, issuedAt, payloadDigest(settings, session ? { ...session, username: session.username.replace(/^@/, "") } : null))), signer.secretKey.slice(0, 32))).toString("base64");
  let base = "";
  return {
    creator,
    mint,
    state,
    clients,
    store,
    dir,
    sentinel,
    tick: (ms = 1_000) => (clock += ms),
    nowIso: () => new Date(clock).toISOString(),
    async start() {
      await new Promise<void>((ok) => api.listen(0, "127.0.0.1", ok));
      base = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/sentinel/${mint}/settings`;
    },
    stop: () => (sentinel.stop(), new Promise((ok) => api.close(ok))),
    get: async () => (await (await fetch(base)).json()) as SentinelStatus,
    put(settings: SentinelSettings, session: XSession | null = null, signer = creator, issuedAt = new Date(clock).toISOString()) {
      const body = { settings, ...(session ? { session } : {}), issuedAt, signer: signer.publicKey.toBase58(), signature: signed("update settings", settings, session, signer, issuedAt) };
      return fetch(base, { method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://parabull.app" }, body: JSON.stringify(body) });
    },
    del(signer = creator, issuedAt = new Date(clock).toISOString()) {
      const body = { issuedAt, signer: signer.publicKey.toBase58(), signature: signed("disconnect", null, null, signer, issuedAt) };
      return fetch(base, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    },
    raw: (method: string, body: unknown) => fetch(base, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  };
}

const SECRET = "test-secret-that-is-at-least-32-characters";

test("a creator links, updates and disconnects X automation after launch, live, without a restart", async () => {
  const h = harness({ secret: SECRET });
  await h.start();
  try {
    assert.deepEqual(await h.get(), { mint: h.mint, mode: "dry-run", account: null, active: false, settings: null, updatedAt: null });

    // Only the creator, and only signed.
    assert.equal((await h.put(DEFAULT_SETTINGS, null, Keypair.generate())).status, 403);
    assert.equal((await h.raw("PUT", { settings: DEFAULT_SETTINGS })).status, 400);
    assert.equal((await h.raw("DELETE", {})).status, 400);
    assert.equal((await h.del(Keypair.generate())).status, 403);

    // Link an account with the first save.
    const first: XSession = { username: "@ParabullBot", authToken: cookie("a"), ct0: cookie("b") };
    const settings: SentinelSettings = { ...DEFAULT_SETTINGS, cashtagReplies: true, tone: "macro", context: "Whitepaper v2 is live." };
    const saved = await h.put(settings, first);
    assert.equal(saved.status, 200);
    const text = await saved.text();
    assert.doesNotMatch(text, /aaaaaaaa|bbbbbbbb/, "the response never carries the cookies");
    const st = JSON.parse(text) as SentinelStatus;
    assert.equal(st.active, true);
    assert.deepEqual({ ...st.account, linkedAt: typeof st.account?.linkedAt }, { username: "ParabullBot", source: "creator", linkedAt: "string" });
    assert.doesNotMatch(readFileSync(join(h.dir, "sentinel.json"), "utf8"), /aaaaaaaa|bbbbbbbb/, "sealed at rest");
    assert.equal(h.state.watching, 1);

    h.state.curve = { ...h.state.curve, ...at(0.52) };
    await h.sentinel.tick();
    assert.equal(h.clients.get("ParabullBot")?.sent.length, 1, "50% posted by the linked account");

    // Replace the session and the persona: the next post goes out from the new account, in the new voice.
    h.tick();
    const second: XSession = { username: "NewBull", authToken: cookie("c"), ct0: cookie("d") };
    assert.equal((await h.put({ ...settings, tone: "wojak", context: "白皮书第二版现已上线。" }, second)).status, 200);
    assert.equal((await h.get()).account?.username, "NewBull");
    h.state.curve = { ...h.state.curve, ...at(0.76) };
    await h.sentinel.tick();
    assert.equal(h.clients.get("ParabullBot")?.sent.length, 1, "the old account posts nothing more");
    assert.equal(h.clients.get("NewBull")?.sent.length, 1);
    assert.match(h.clients.get("NewBull")!.sent[0].text, /白皮书第二版现已上线。/);

    // Settings-only saves keep the linked session.
    h.tick();
    assert.equal((await h.put({ ...settings, tone: "wojak", context: "Staking next week." })).status, 200);
    assert.equal((await h.get()).account?.username, "NewBull");

    // Cashtag replies come from the current account.
    h.tick(60_000);
    h.state.mentions = [{ id: "t1", text: "@NewBull is $BULL on Raydium yet?", username: "alice", timeMs: Date.parse(h.nowIso()) - 1_000 }];
    await h.sentinel.tickMentions();
    assert.equal(h.clients.get("NewBull")?.sent.at(-1)?.inReplyTo, "t1");

    // Disconnect: watching stops, the session is forgotten, nothing more is posted.
    h.tick();
    const before = h.nowIso();
    const bye = await h.del();
    assert.equal(bye.status, 200);
    const off = (await bye.json()) as SentinelStatus;
    assert.deepEqual({ active: off.active, account: off.account, settings: off.settings }, { active: false, account: null, settings: null });
    assert.equal(h.state.watching, 0, "the curve listener is gone");
    assert.doesNotMatch(readFileSync(join(h.dir, "sentinel.json"), "utf8"), /sealed|NewBull/, "no session left on disk");
    const sent = h.clients.get("NewBull")!.sent.length;
    h.state.curve = { ...h.state.curve, ...at(1, true) };
    await h.sentinel.tick();
    await h.sentinel.tickMentions();
    assert.equal(h.clients.get("NewBull")!.sent.length, sent, "graduation isn't posted after disconnecting");

    // A request signed before the disconnect can't bring it back.
    assert.equal((await h.put(settings, first, h.creator, new Date(Date.parse(before) - 500).toISOString())).status, 409);
  } finally {
    await h.stop();
  }
});

test("without SENTINEL_SECRET creators can't link a session; the operator's account posts instead", async () => {
  const h = harness({ operatorUsername: "OperatorBull" });
  await h.start();
  try {
    assert.deepEqual((await h.get()).account, { username: "OperatorBull", source: "operator", linkedAt: null });
    const linked = await h.put(DEFAULT_SETTINGS, { username: "ParabullBot", authToken: cookie("a"), ct0: cookie("b") });
    assert.equal(linked.status, 400);
    assert.match(((await linked.json()) as { error: string }).error, /SENTINEL_SECRET/);
    assert.equal((await h.get()).active, false, "a refused session saves nothing");
    h.tick();
    assert.equal((await h.put(DEFAULT_SETTINGS)).status, 200, "settings alone still save");
    h.state.curve = { ...h.state.curve, ...at(0.55) };
    await h.sentinel.tick();
    assert.equal(h.clients.get("OperatorBull")?.sent.length, 1);
  } finally {
    await h.stop();
  }
});

test("unsigned, stale, replayed and forged writes are refused before any RPC call", async () => {
  const h = harness({ secret: SECRET });
  await h.start();
  try {
    const reads = () => h.state.curveReads;
    const stranger = Keypair.generate();
    const junk: [string, Promise<Response>, number][] = [
      ["unsigned PUT", h.raw("PUT", { settings: DEFAULT_SETTINGS }), 400],
      ["unsigned DELETE", h.raw("DELETE", {}), 400],
      ["forged PUT signature", h.raw("PUT", { settings: DEFAULT_SETTINGS, issuedAt: h.nowIso(), signer: h.creator.publicKey.toBase58(), signature: Buffer.alloc(64, 7).toString("base64") }), 401],
      ["forged DELETE signature", h.raw("DELETE", { issuedAt: h.nowIso(), signer: h.creator.publicKey.toBase58(), signature: Buffer.alloc(64, 7).toString("base64") }), 401],
      ["stale PUT", h.put(DEFAULT_SETTINGS, null, h.creator, new Date(Date.parse(h.nowIso()) - 10 * 60_000).toISOString()), 401],
      ["bad signer address", h.raw("PUT", { settings: DEFAULT_SETTINGS, issuedAt: h.nowIso(), signer: "not-a-key", signature: "AA==" }), 400],
    ];
    for (const [name, res, code] of junk) assert.equal((await res).status, code, name);
    assert.equal(reads(), 0, "no RPC call for any of them");

    // A replay of an accepted request is also refused without reading the chain.
    const issuedAt = h.nowIso();
    assert.equal((await h.put(DEFAULT_SETTINGS, null, h.creator, issuedAt)).status, 200);
    const afterSave = reads();
    assert.equal((await h.put(DEFAULT_SETTINGS, null, h.creator, issuedAt)).status, 409, "replay");
    assert.equal(reads(), afterSave, "a replay costs no RPC call");

    // Only a validly signed request reads the curve: another wallet's signature then gets 403.
    h.tick();
    const before = reads();
    assert.equal((await h.put(DEFAULT_SETTINGS, null, stranger)).status, 403);
    assert.equal((await h.del(stranger)).status, 403);
    assert.equal(reads() - before, 2, "one read each, to learn the on-chain creator");
    assert.equal((await h.get()).active, true, "the stranger changed nothing");
  } finally {
    await h.stop();
  }
});

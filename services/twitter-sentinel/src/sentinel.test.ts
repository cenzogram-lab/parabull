/** End to end in dry-run mode: the API, the signed settings, and the milestone and reply loops against a fake chain. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair } from "@solana/web3.js";
import { DEFAULT_SETTINGS, settingsMessage, type SentinelSettings, type SentinelStatus } from "../../../app/src/lib/sentinelMessage";
import { settingsDigest } from "./auth";
import type { ChainSource, CurveState } from "./chain";
import { graduationRaise } from "./milestones";
import type { MentionTweet } from "./replies";
import { Sentinel } from "./sentinel";
import { createApi } from "./server";
import { Store } from "./store";
import { DryRunX } from "./x";

const RAISE = graduationRaise({ virtualToken: 1_073_000_000_000_000n, virtualSol: 30_000_000_000n, realToken: 793_100_000_000_000n });
const at = (f: number, migrated = false): Omit<CurveState, "creator"> => ({ realSol: (RAISE * BigInt(Math.round(f * 1000)) + 999n) / 1000n, complete: f >= 1, migrated });

test("a creator's signed settings drive milestone posts and cashtag replies", async () => {
  const creator = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  let curve: CurveState = { ...at(0.3), creator: creator.publicKey.toBase58() };
  const chain: ChainSource = { curve: async () => curve, raise: async () => RAISE, ticker: async () => "BULL", watch: () => () => {} };
  let mentions: MentionTweet[] = [];
  const x = new DryRunX("parabullbot", () => {}, () => mentions);
  let clock = Date.parse("2026-11-04T12:00:00Z");
  const now = () => clock;
  const store = new Store(mkdtempSync(join(tmpdir(), "sentinel-")));
  const sentinel = new Sentinel({ store, chain, xFor: () => x, coinUrl: (m) => `https://parabull.app/coin/${m}`, now, log: () => {} });
  const api = createApi({ store, chain, sentinel, xFor: () => x, allowedOrigins: ["https://parabull.app"], now });
  await new Promise<void>((ok) => api.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/sentinel/${mint}`;
  const put = (settings: SentinelSettings, signer = creator, issuedAt = new Date(clock).toISOString()) => {
    const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(settingsMessage(mint, issuedAt, settingsDigest(settings))), signer.secretKey.slice(0, 32))).toString("base64");
    return fetch(base, { method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://parabull.app" }, body: JSON.stringify({ settings, issuedAt, signer: signer.publicKey.toBase58(), signature }) });
  };
  try {
    const before = (await (await fetch(base)).json()) as SentinelStatus;
    assert.deepEqual(before, { mint, mode: "dry-run", account: { username: "parabullbot" }, settings: null, updatedAt: null });

    const stranger = await put(DEFAULT_SETTINGS, Keypair.generate());
    assert.equal(stranger.status, 403);

    const settings: SentinelSettings = { ...DEFAULT_SETTINGS, cashtagReplies: true, tone: "macro", context: "Whitepaper v2 is live." };
    const saved = await put(settings);
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get("access-control-allow-origin"), "https://parabull.app");
    assert.deepEqual(((await saved.json()) as SentinelStatus).settings, settings);
    assert.equal(x.sent.length, 0, "the 25% the curve had already passed when watching began isn't backfilled");

    curve = { ...curve, ...at(0.52) };
    await sentinel.tick();
    curve = { ...curve, ...at(0.53) };
    await sentinel.tick();
    assert.equal(x.sent.length, 1);
    // Either of the macro persona's two 50% wordings (picked from the mint), with the news line and the link.
    assert.match(x.sent[0].text, /^(\$BULL: bonding curve 50% filled|Update: \$BULL has reached the curve's midpoint)\. Whitepaper v2 is live\. https:\/\/parabull\.app\/coin\//);

    curve = { ...curve, ...at(1, true) };
    await sentinel.tick();
    assert.equal(x.sent.length, 2, "75% and graduation together post once, as graduation");
    assert.match(x.sent[1].text, /Raydium/);

    clock += 60_000;
    mentions = [
      { id: "t1", text: "@parabullbot is $BULL on Raydium yet?", username: "alice", timeMs: clock - 1_000 },
      { id: "t2", text: "$BULL $BULL $BULL", username: "bob", timeMs: clock - 900 },
    ];
    await sentinel.tickMentions();
    await sentinel.tickMentions();
    assert.equal(x.sent.length, 3, "one reply, once");
    assert.equal(x.sent[2].inReplyTo, "t1");
    assert.match(x.sent[2].text, /^@alice /);

    const replay = await put(settings, creator, new Date(clock - 60_000).toISOString());
    assert.equal(replay.status, 409);
  } finally {
    sentinel.stop();
    await new Promise((ok) => api.close(ok));
  }
});

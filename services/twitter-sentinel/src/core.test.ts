import assert from "node:assert/strict";
import { test } from "node:test";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import BN from "bn.js";
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DEFAULT_SETTINGS, normalizeSettings, sentinelMessage, SENTINEL_MILESTONES, SENTINEL_TONES, signedPayloadJson, type SentinelSettings, type XSession } from "../../../app/src/lib/sentinelMessage";
import { payloadDigest, verifySignedDisconnect, verifySignedSettings } from "./auth";
import { keyFromSecret, seal, unseal } from "./seal";
import { decodeCurve, decodeRaise, IDL } from "./chain";
import { due, graduationRaise, progress, reached } from "./milestones";
import { fillTemplate, MAX_POST, milestonePost, replyText, weightedLength } from "./persona";
import { hasCashtag, mentionsAccount, selectReplies, type MentionTweet } from "./replies";

const DEFAULT_INITIAL = { virtualToken: 1_073_000_000_000_000n, virtualSol: 30_000_000_000n, realToken: 793_100_000_000_000n };
const RAISE = graduationRaise(DEFAULT_INITIAL);
const all = { p25: true, p50: true, p75: true, graduation: true };

test("the default curve graduates at about 85 SOL, as the app shows", () => {
  assert.ok(RAISE > 84_000_000_000n && RAISE < 86_000_000_000n, `${RAISE}`);
});

test("milestones follow SOL raised; graduation needs the Raydium migration", () => {
  const at = (f: number, extra: Partial<{ complete: boolean; migrated: boolean }> = {}) => ({ realSol: (RAISE * BigInt(Math.round(f * 1000)) + 999n) / 1000n, complete: false, migrated: false, ...extra });
  assert.deepEqual(reached(at(0.24), RAISE), []);
  assert.deepEqual(reached(at(0.25), RAISE), ["p25"]);
  assert.deepEqual(reached(at(0.8), RAISE), ["p25", "p50", "p75"]);
  assert.deepEqual(reached(at(1, { complete: true }), RAISE), ["p25", "p50", "p75"]);
  assert.deepEqual(reached(at(1, { complete: true, migrated: true }), RAISE), ["p25", "p50", "p75", "graduation"]);
  assert.ok(Math.abs(progress(at(0.5), RAISE) - 0.5) < 1e-9);
  // A big buy that jumps several milestones posts only the highest, and marks them all done.
  assert.deepEqual(due(at(0.8), RAISE, new Set(), all), { post: "p75", markDone: ["p25", "p50", "p75"] });
  // A disabled milestone is passed silently, so turning it on later can't post a stale one.
  assert.deepEqual(due(at(0.55), RAISE, new Set(["p25"]), { ...all, p50: false }), { post: null, markDone: ["p50"] });
  assert.deepEqual(due(at(0.55), RAISE, new Set(["p25", "p50"]), all), { post: null, markDone: [] });
});

test("every persona's posts fit in 280 characters with the ticker and link", () => {
  const coin = { mint: "Mint111", ticker: "BULL", url: "https://parabull.app/coin/Mint111" };
  const long = "Partnership with a top-10 desk announced today, details in the thread. ".repeat(20);
  // CJK weighs 2 per character on X: 200 of them would pass a .length check and still be over the limit.
  const cjk = "白皮书第二版现已上线，质押功能下周推出。".repeat(10);
  const emoji = "🐂🚀".repeat(80);
  // Appended lore with a long link (counted as 23) mixed with CJK, as a creator might paste it.
  const mixed = `Docs: https://docs.parabull.app/${"guides/".repeat(30)}staking 质押上线 🐂 ${"更新".repeat(60)}`;
  for (const { value: tone } of SENTINEL_TONES)
    for (const { key } of SENTINEL_MILESTONES)
      for (const context of ["", "Whitepaper v2 is live.", long, cjk, emoji, mixed]) {
        const p = milestonePost(tone, key, coin, context);
        assert.ok(weightedLength(p) <= MAX_POST, `${tone}/${key}: weighted ${weightedLength(p)}`);
        assert.match(p, /\$BULL/);
        assert.ok(p.includes(coin.url), p);
        assert.doesNotMatch(p, /\{\{/);
      }
  assert.equal(weightedLength("gm"), 2);
  assert.equal(weightedLength("白皮书"), 6);
  assert.equal(weightedLength(`see ${coin.url}`), 4 + 23, "a link counts 23 whatever its length");
  const cjkReply = replyText("bull", coin, "alice", "9", 0.5, cjk);
  assert.ok(weightedLength(cjkReply) <= MAX_POST && cjkReply.includes("白皮书"), cjkReply);
  const r = replyText("macro", coin, "alice", "123", 0.42, "Staking next week.");
  assert.match(r, /^@alice /);
  assert.match(r, /42%/);
  assert.match(r, /Staking next week\./);
});

test("templates fill like elizaOS composeContext: one pass, missing keys empty, values never expanded", () => {
  assert.equal(fillTemplate("${{ticker}} at {{pct}}. {{news}}{{url}}", { ticker: "BULL", pct: "50%", url: "https://x.y" }), "$BULL at 50%. https://x.y");
  // The creator's news is inserted as written: placeholders and replacement patterns inside it stay literal.
  assert.equal(fillTemplate("{{news}}|{{ticker}}", { news: "{{ticker}} $& $1 $$", ticker: "BULL" }), "{{ticker}} $& $1 $$|BULL");
  // Only \w+ keys are placeholders; anything else in braces is left alone.
  assert.equal(fillTemplate("{{ ticker }} {{tick-er}} {{}}", { ticker: "BULL" }), "{{ ticker }} {{tick-er}} {{}}");
  // Inherited properties are never values.
  assert.equal(fillTemplate("[{{constructor}}][{{toString}}]", {}), "[][]");
});

test("replies go only to posts that mention the account and the cashtag", () => {
  assert.ok(mentionsAccount("gm @ParabullBot", "parabullbot"));
  assert.ok(!mentionsAccount("gm @ParabullBotFan", "parabullbot"));
  assert.ok(hasCashtag("loading $bull now", "BULL"));
  assert.ok(!hasCashtag("loading $BULLISH now", "BULL"));
  const t = (id: string, text: string, username: string, timeMs: number, isRetweet = false): MentionTweet => ({ id, text, username, timeMs, isRetweet });
  const tweets = [
    t("1", "@bot what's next for $BULL?", "alice", 1_000),
    t("2", "$BULL to the moon", "bob", 1_100), // no mention of the account
    t("3", "@bot gm", "carol", 1_200), // no cashtag
    t("4", "@bot $BULL again", "alice", 1_300), // same author within a day
    t("5", "@bot $BULL", "bot", 1_400), // our own post
    t("6", "@bot $BULL", "dave", 500), // before watching started
    t("7", "RT @bot $BULL", "erin", 1_500, true),
    t("8", "@bot $BULL wen raydium", "frank", 1_600),
  ];
  const picks = selectReplies(tweets, "bot", "BULL", 900, 2_000, { replied: new Set(["8"]), lastByAuthor: {}, recent: [] });
  assert.deepEqual(picks.map((p) => p.id), ["1"]);
  const capped = selectReplies([t("9", "@bot $BULL", "gina", 1_000), t("10", "@bot $BULL", "hank", 1_001)], "bot", "BULL", 0, 2_000, { replied: new Set(), lastByAuthor: {}, recent: Array(9).fill(1_500) });
  assert.deepEqual(capped.map((p) => p.id), ["9"], "the hourly cap of 10 counts earlier replies");
});

function sign(kp: Keypair, mint: string, settings: SentinelSettings | null, issuedAt: string, session: XSession | null = null, action: "update settings" | "disconnect" = "update settings") {
  const msg = new TextEncoder().encode(sentinelMessage(action, mint, issuedAt, payloadDigest(settings, session)));
  return Buffer.from(ed25519.sign(msg, kp.secretKey.slice(0, 32))).toString("base64");
}

const SESSION: XSession = { username: "ParabullBot", authToken: "a".repeat(40), ct0: "b".repeat(160) };

test("a linked session is covered by the signature, and a disconnect needs its own", () => {
  const creator = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const now = Date.parse("2026-11-04T12:00:00Z");
  const issuedAt = new Date(now).toISOString();
  const signer = creator.publicKey.toBase58();
  const body = { settings: DEFAULT_SETTINGS, session: { ...SESSION, username: "@ParabullBot" }, issuedAt, signer, signature: sign(creator, mint, DEFAULT_SETTINGS, issuedAt, SESSION) };
  const ok = verifySignedSettings(body, mint, signer, now, null);
  assert.ok(ok.ok && ok.session?.username === "ParabullBot", "the handle loses its @");
  // Swapping in other cookies breaks the signature.
  assert.equal((verifySignedSettings({ ...body, session: { ...SESSION, ct0: "c".repeat(160) } }, mint, signer, now, null) as { status: number }).status, 401);
  assert.equal((verifySignedSettings({ ...body, session: { ...SESSION, ct0: "not a cookie" } }, mint, signer, now, null) as { status: number }).status, 400);
  // A settings signature can't be reused to disconnect, and vice versa.
  assert.equal((verifySignedDisconnect(body, mint, signer, now, null) as { status: number }).status, 401);
  const bye = { issuedAt, signer, signature: sign(creator, mint, null, issuedAt, null, "disconnect") };
  assert.ok(verifySignedDisconnect(bye, mint, signer, now, null).ok);
  const stranger = Keypair.generate();
  assert.equal((verifySignedDisconnect({ issuedAt, signer: stranger.publicKey.toBase58(), signature: sign(stranger, mint, null, issuedAt, null, "disconnect") }, mint, signer, now, null) as { status: number }).status, 403);
  assert.equal((verifySignedDisconnect({}, mint, signer, now, null) as { status: number }).status, 400, "unsigned");
});

test("sealed sessions open only with the same key and mint", () => {
  assert.equal(keyFromSecret("too short"), null);
  const key = keyFromSecret("x".repeat(32))!;
  const sealed = seal(key, "MintA", SESSION);
  assert.doesNotMatch(sealed, /aaaaaaaa/, "no cookie in the clear");
  assert.deepEqual(unseal(key, "MintA", sealed), SESSION);
  assert.throws(() => unseal(key, "MintB", sealed), "bound to its mint");
  assert.throws(() => unseal(keyFromSecret("y".repeat(32))!, "MintA", sealed), "wrong key");
});

test("signed settings: only the creator, only fresh, never replayed", () => {
  const creator = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const settings: SentinelSettings = { ...DEFAULT_SETTINGS, cashtagReplies: true, context: "Roadmap: staking next week." };
  const now = Date.parse("2026-11-04T12:00:00Z");
  const issuedAt = new Date(now - 10_000).toISOString();
  const body = { settings, issuedAt, signer: creator.publicKey.toBase58(), signature: sign(creator, mint, settings, issuedAt) };
  const ok = verifySignedSettings(body, mint, creator.publicKey.toBase58(), now, null);
  assert.ok(ok.ok);

  const other = Keypair.generate();
  const forged = { ...body, signer: other.publicKey.toBase58(), signature: sign(other, mint, settings, issuedAt) };
  assert.equal((verifySignedSettings(forged, mint, creator.publicKey.toBase58(), now, null) as { status: number }).status, 403);
  const tampered = { ...body, settings: { ...settings, tone: "wojak" } };
  assert.equal((verifySignedSettings(tampered, mint, creator.publicKey.toBase58(), now, null) as { status: number }).status, 401);
  assert.equal((verifySignedSettings(body, mint, creator.publicKey.toBase58(), now + 10 * 60_000, null) as { status: number }).status, 401);
  assert.equal((verifySignedSettings(body, mint, creator.publicKey.toBase58(), now, Date.parse(issuedAt)) as { status: number }).status, 409);
  assert.equal((verifySignedSettings({ ...body, settings: { ...settings, tone: "shill" } }, mint, creator.publicKey.toBase58(), now, null) as { status: number }).status, 400);
});

test("the browser's SHA-256 of the settings matches the service's", async () => {
  const s = normalizeSettings({ ...DEFAULT_SETTINGS, context: "  Whitepaper v2 live\u0007  " });
  assert.ok(s.ok);
  assert.equal(s.value.context, "Whitepaper v2 live");
  const web = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signedPayloadJson(s.value, SESSION)))).toString("hex");
  assert.equal(web, payloadDigest(s.value, SESSION));
});

/** A zero-valued instance of an IDL struct, so the real coder can encode test accounts. */
function zero(type: unknown): unknown {
  if (type === "bool") return false;
  if (type === "pubkey") return PublicKey.default;
  if (typeof type === "string") return /^(u|i)(8|16|32)$/.test(type) ? 0 : new BN(0);
  const t = type as { array?: [unknown, number]; defined?: { name: string } };
  if (t.array) return Array.from({ length: t.array[1] }, () => zero(t.array![0]));
  throw new Error(`unsupported ${JSON.stringify(type)}`);
}
function instance(name: string, overrides: Record<string, unknown>) {
  const def = (IDL.types ?? []).find((x) => x.name === name)!.type as { fields: { name: string; type: unknown }[] };
  return Object.fromEntries(def.fields.map((f) => [f.name, f.name in overrides ? overrides[f.name] : zero(f.type)]));
}

test("decodes the program's BondingCurve and Global accounts", async () => {
  const coder = new BorshAccountsCoder(IDL);
  const creator = Keypair.generate().publicKey;
  const curve = await coder.encode("BondingCurve", instance("BondingCurve", { creator, complete: true, real_sol_reserves: new BN("42000000000") }));
  assert.deepEqual(decodeCurve(curve), { realSol: 42_000_000_000n, complete: true, migrated: false, creator: creator.toBase58() });
  const global = await coder.encode(
    "Global",
    instance("Global", { initial_virtual_token_reserves: new BN(DEFAULT_INITIAL.virtualToken.toString()), initial_virtual_sol_reserves: new BN(DEFAULT_INITIAL.virtualSol.toString()), initial_real_token_reserves: new BN(DEFAULT_INITIAL.realToken.toString()) }),
  );
  assert.equal(decodeRaise(global), RAISE);
});

test("a store file from the first release loads with every coin and its last request time", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("./store");
  const dir = mkdtempSync(join(tmpdir(), "sentinel-legacy-"));
  const legacy = {
    MintAAA: { settings: DEFAULT_SETTINGS, updatedAt: "2026-11-04T12:00:00.000Z", lastIssuedAtMs: 1_700, milestonesDone: ["p25"], watchingSince: 1_000, replied: ["t1"], lastByAuthor: {}, recentReplies: [] },
  };
  writeFileSync(join(dir, "sentinel.json"), JSON.stringify(legacy));
  const store = new Store(dir);
  assert.deepEqual(store.mints(), ["MintAAA"]);
  assert.deepEqual(store.get("MintAAA")?.milestonesDone, ["p25"]);
  assert.equal(store.lastIssued("MintAAA"), 1_700);
  assert.ok(!("lastIssuedAtMs" in (store.get("MintAAA") as object)));
  // The next write keeps the coin, in the new shape.
  store.update("MintAAA", (r) => ({ ...r!, updatedAt: "2026-11-04T13:00:00.000Z" }));
  const saved = JSON.parse(readFileSync(join(dir, "sentinel.json"), "utf8"));
  assert.deepEqual(Object.keys(saved.coins), ["MintAAA"]);
  assert.equal(saved.lastIssued.MintAAA, 1_700);
});

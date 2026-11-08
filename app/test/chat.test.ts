import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import {
  base58Decode,
  CHAT_MAX_ATTACHMENTS,
  CHAT_MAX_CHARS,
  chatSignInMessage,
  checkAttachment,
  checkAttachments,
  checkText,
  isAddress,
  parseClientFrame,
  shortWallet,
} from "../src/lib/chatMessage";

const MEDIA = "https://media.parabull.test";
const HASH = "a".repeat(64);

test("chat: base58 decoding matches bs58, leading zeros included", () => {
  for (let i = 0; i < 50; i++) {
    const bytes = Keypair.generate().publicKey.toBytes();
    if (i % 5 === 0) bytes[0] = 0;
    if (i % 10 === 0) bytes[1] = 0;
    const s = utils.bytes.bs58.encode(bytes);
    assert.deepEqual(base58Decode(s), bytes, s);
  }
  assert.deepEqual(base58Decode("1"), Uint8Array.from([0]));
  assert.equal(base58Decode("0OIl"), null, "not in the alphabet");
  assert.equal(base58Decode(""), null);
  assert.ok(isAddress(Keypair.generate().publicKey.toBase58()));
  assert.ok(isAddress("11111111111111111111111111111111"), "the system program");
  assert.equal(isAddress("abc"), false);
  assert.equal(isAddress(utils.bytes.bs58.encode(new Uint8Array(31).fill(7))), false, "31 bytes");
});

test("chat: the sign-in text names the wallet, time and nonce", () => {
  const m = chatSignInMessage("W", "2026-11-08T00:00:00.000Z", "n1");
  assert.equal(m.split("\n")[0], "Parabull chat sign-in");
  assert.match(m, /^Wallet: W$/m);
  assert.match(m, /^Issued: 2026-11-08T00:00:00.000Z$/m);
  assert.match(m, /^Nonce: n1$/m);
  assert.match(m, /no transaction/);
});

test("chat: text is trimmed, at most 280 characters (code points), no control characters", () => {
  assert.deepEqual(checkText("  gm  "), { ok: true, value: "gm" });
  assert.equal((checkText("x".repeat(CHAT_MAX_CHARS)) as { ok: boolean }).ok, true);
  assert.equal((checkText("x".repeat(CHAT_MAX_CHARS + 1)) as { code?: string }).code, "too_long");
  assert.equal((checkText("🐂".repeat(CHAT_MAX_CHARS)) as { ok: boolean }).ok, true, "an emoji counts once");
  assert.equal((checkText("a\u0000b") as { code?: string }).code, "bad_request");
  assert.deepEqual(checkText("a\n\n\n\nb"), { ok: true, value: "a\n\nb" });
  assert.equal((checkText(5) as { ok: boolean }).ok, false);
});

test("chat: attachments only from this deployment's media bucket, /img/<sha256>.<ext>", () => {
  assert.deepEqual(checkAttachment(`${MEDIA}/img/${HASH}.png`, MEDIA), { kind: "image", url: `${MEDIA}/img/${HASH}.png` });
  assert.deepEqual(checkAttachment(`${MEDIA}/img/${HASH}.gif`, `${MEDIA}/`), { kind: "gif", url: `${MEDIA}/img/${HASH}.gif` });
  for (const bad of [
    `https://evil.test/img/${HASH}.png`,
    `${MEDIA}.evil.test/img/${HASH}.png`,
    `${MEDIA}/meta/${HASH}.json`,
    `${MEDIA}/img/${HASH}.svg`,
    `${MEDIA}/img/../meta/${HASH}.png`,
    `${MEDIA}/img/${HASH}.png?x=1`,
    `http://media.parabull.test/img/${HASH}.png`,
  ])
    assert.equal(checkAttachment(bad, MEDIA), null, bad);
  assert.equal(checkAttachment(`${MEDIA}/img/${HASH}.png`, ""), null, "no media base, no attachments");
  const many = Array.from({ length: CHAT_MAX_ATTACHMENTS + 1 }, () => `${MEDIA}/img/${HASH}.png`);
  assert.equal((checkAttachments(many, MEDIA) as { code?: string }).code, "bad_attachment");
  assert.deepEqual(checkAttachments([`${MEDIA}/img/${HASH}.png`, `${MEDIA}/img/${HASH}.png`], MEDIA), { ok: true, value: [{ kind: "image", url: `${MEDIA}/img/${HASH}.png` }] }, "duplicates collapse");
  assert.deepEqual(checkAttachments(undefined, MEDIA), { ok: true, value: [] });
});

test("chat: client frames parse strictly", () => {
  assert.deepEqual(parseClientFrame('{"type":"auth","token":"t"}'), { type: "auth", token: "t" });
  assert.deepEqual(parseClientFrame('{"type":"send","text":"gm"}'), { type: "send", text: "gm", attachments: undefined });
  assert.deepEqual(parseClientFrame('{"type":"send","text":"gm","cid":"a1_-"}'), { type: "send", text: "gm", attachments: undefined, cid: "a1_-" });
  assert.equal(parseClientFrame('{"type":"send","text":"gm","cid":"no spaces"}'), null);
  assert.equal(parseClientFrame(JSON.stringify({ type: "send", text: "gm", cid: "x".repeat(65) })), null);
  assert.equal(parseClientFrame("not json"), null);
  assert.equal(parseClientFrame('{"type":"nuke"}'), null);
  assert.equal(parseClientFrame("x".repeat(5000)), null);
  assert.equal(shortWallet("ABCDEFGHIJKLMNOP"), "ABCD…MNOP");
});

test("chat client: endpoints from VITE_CHAT_URL (wss or https, trailing /chat ignored)", async () => {
  const { chatEndpoints } = await import("../src/lib/chatClient");
  const e = chatEndpoints("wss://edge.parabull.xyz/chat/")!;
  assert.equal(e.room("Mint111"), "wss://edge.parabull.xyz/chat/Mint111");
  assert.equal(e.session, "https://edge.parabull.xyz/chat/session");
  assert.equal(e.upload, "https://edge.parabull.xyz/chat/upload");
  assert.equal(chatEndpoints("https://edge.parabull.xyz")!.room("M"), "wss://edge.parabull.xyz/chat/M");
  assert.equal(chatEndpoints("http://127.0.0.1:8787")!.session, "http://127.0.0.1:8787/chat/session");
  assert.equal(chatEndpoints("ws://127.0.0.1:8787")!.room("M"), "ws://127.0.0.1:8787/chat/M");
  assert.equal(chatEndpoints(undefined), null);
  assert.equal(chatEndpoints("ftp://x.test"), null);
  assert.equal(chatEndpoints("not a url"), null);
});

test("chat client: the sign-in body carries exactly what was signed", async () => {
  const { chatSignIn, reconnectDelay } = await import("../src/lib/chatClient");
  const { createPrivateKey, createPublicKey, sign, verify } = await import("node:crypto");
  const kp = Keypair.generate();
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(kp.secretKey.slice(0, 32))]), format: "der", type: "pkcs8" });
  const wallet = kp.publicKey.toBase58();
  const at = new Date("2026-11-08T03:00:00.000Z");
  const { message, body } = chatSignIn(wallet, at, new Uint8Array(16).fill(171));
  assert.equal(message, chatSignInMessage(wallet, at.toISOString(), "ab".repeat(16)));
  const signature = new Uint8Array(sign(null, Buffer.from(message), key));
  assert.ok(verify(null, Buffer.from(message), createPublicKey(key), signature), "a real ed25519 signature by the wallet's key");
  const b = body(signature);
  assert.deepEqual({ ...b, signature: "" }, { wallet, issuedAt: "2026-11-08T03:00:00.000Z", nonce: "ab".repeat(16), signature: "" });
  assert.deepEqual(Uint8Array.from(atob(b.signature), (c) => c.charCodeAt(0)), signature);
  assert.deepEqual([0, 1, 2, 5, 9].map((a) => reconnectDelay(a, () => 0.999999)), [1000, 2000, 4000, 30000, 30000]);
});

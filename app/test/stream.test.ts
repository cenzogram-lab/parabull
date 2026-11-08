import assert from "node:assert/strict";
import { test } from "node:test";
import { liveHlsUrl, parseLiveList, streamHostOf } from "../src/lib/stream";

const HOST = "customer-abc123.cloudflarestream.com";
const MINT = "DrLUh4S9VS1rsJwPKexAmJsUhpZa89At8ea11ASTCUGn";
const CREATOR = "7Z41mBaP2t5tbxJDRCGUdHC2Gw4dwbBgrmYzkFZq73cW";
const IN = "a".repeat(32);

test("stream: VITE_STREAM_HOST must be a Cloudflare Stream customer host", () => {
  assert.equal(streamHostOf(HOST), HOST);
  assert.equal(streamHostOf(`https://${HOST}/`), HOST);
  for (const bad of [undefined, "", "cloudflarestream.com", "customer-abc.evil.test", `${HOST}.evil.test`, "http://x"]) assert.equal(streamHostOf(bad), null, String(bad));
  assert.equal(liveHlsUrl(HOST, IN), `https://${HOST}/${IN}/manifest/video.m3u8`);
});

test("stream: the live list keeps well-formed entries and rebuilds their HLS URL from our own host", () => {
  const got = parseLiveList(
    {
      streams: [
        { mint: MINT, input: IN, title: "  AMA  ", creator: CREATOR, hls: "https://evil.test/x.m3u8" },
        { mint: MINT, input: IN, title: "duplicate" },
        { mint: "nope", input: "b".repeat(32) },
        { mint: MINT, input: "not-hex" },
        { mint: MINT, input: "c".repeat(32), title: "", creator: "bad" },
        null,
        "junk",
      ],
    },
    HOST,
  );
  assert.deepEqual(got, [
    { mint: MINT, input: IN, title: "AMA", creator: CREATOR, hls: `https://${HOST}/${IN}/manifest/video.m3u8` },
    { mint: MINT, input: "c".repeat(32), title: null, creator: null, hls: `https://${HOST}/${"c".repeat(32)}/manifest/video.m3u8` },
  ]);
  assert.deepEqual(parseLiveList(null, HOST), []);
  assert.deepEqual(parseLiveList({ streams: "x" }, HOST), []);
});

test("stream: the edge endpoints include /live", async () => {
  const { chatEndpoints } = await import("../src/lib/chatClient");
  assert.equal(chatEndpoints("wss://edge.parabull.xyz")!.live, "https://edge.parabull.xyz/live");
});

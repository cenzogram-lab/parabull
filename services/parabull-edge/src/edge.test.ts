import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { checkUri, uploadMetadata } from "../../../app/src/lib/metadata";
import { handle, type Env, type RateLimiter } from "./router";
import { IMMUTABLE, MAX_IMAGE_BYTES, metadataJson, publicBase, sniffImage, validateFields, type MediaBucket } from "./metadata";

const APP = "https://abcde-aaaaa-aaaaa-aaaaa-cai.icp0.io";
const BASE = "https://media.parabull.test";
const ENDPOINT = "https://edge.parabull.test/metadata";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');

type Stored = { body: Uint8Array | string; contentType?: string; cacheControl?: string };
function memoryBucket() {
  const objects = new Map<string, Stored>();
  let puts = 0;
  const bucket: MediaBucket = {
    head: async (k) => (objects.has(k) ? { key: k } : null),
    put: async (k, v, o) => {
      puts++;
      const body = typeof v === "string" ? v : v instanceof Uint8Array ? v : new Uint8Array(v);
      objects.set(k, { body, contentType: o?.httpMetadata?.contentType, cacheControl: o?.httpMetadata?.cacheControl });
      return {};
    },
  };
  return { bucket, objects, puts: () => puts };
}

function env(over: Partial<Env> = {}): Env & { store: ReturnType<typeof memoryBucket> } {
  const store = memoryBucket();
  return { MEDIA: store.bucket, MEDIA_PUBLIC_URL: `${BASE}/`, ALLOWED_ORIGINS: `${APP}, https://parabull.test`, ...over, store };
}

/** A browser-like request: the multipart body with its content-type and content-length, from `origin`. */
async function post(form: FormData, origin: string | null = APP, extra: Record<string, string> = {}): Promise<Request> {
  const encoded = new Response(form);
  const body = new Uint8Array(await encoded.arrayBuffer());
  const headers: Record<string, string> = { "content-type": encoded.headers.get("content-type")!, "content-length": String(body.length), ...extra };
  if (origin) headers.origin = origin;
  return new Request(ENDPOINT, { method: "POST", headers, body });
}

const fields = { name: "Bronze Bull", symbol: "BRONZE", description: "Charging.", website: "https://bronze.example", twitter: "https://x.com/bronzebull" };
function form(image: Uint8Array | null, meta: unknown = fields, filename = "logo.png", type = "image/png"): FormData {
  const f = new FormData();
  if (image) f.append("image", new File([image], filename, { type }));
  f.append("metadata", typeof meta === "string" ? meta : JSON.stringify(meta));
  return f;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("sniffImage: PNG, JPEG, WebP and GIF by their bytes, nothing else", () => {
  assert.deepEqual(sniffImage(PNG), { ext: "png", mime: "image/png" });
  assert.deepEqual(sniffImage(JPEG), { ext: "jpg", mime: "image/jpeg" });
  assert.deepEqual(sniffImage(WEBP), { ext: "webp", mime: "image/webp" });
  assert.deepEqual(sniffImage(GIF), { ext: "gif", mime: "image/gif" });
  assert.equal(sniffImage(SVG), null);
  assert.equal(sniffImage(PNG.slice(0, 4)), null);
  assert.equal(sniffImage(new Uint8Array()), null);
  assert.equal(sniffImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])), null, "RIFF but WAVE");
});

test("validateFields mirrors the app's launch rules", () => {
  const ok = validateFields({ ...fields, telegram: "https://t.me/bull", extra: "dropped" });
  assert.ok(ok.ok);
  assert.deepEqual(Object.keys(ok.value).sort(), ["description", "name", "symbol", "telegram", "twitter", "website"]);
  assert.equal(validateFields({ ...fields, name: "  " }).ok, false);
  assert.equal(validateFields({ ...fields, name: "é".repeat(17) }).ok, false, "34 UTF-8 bytes");
  assert.equal(validateFields({ ...fields, name: "é".repeat(16) }).ok, true, "32 UTF-8 bytes");
  for (const symbol of ["bronze", "BRONZE!", "", "ABCDEFGHIJK", 7]) assert.equal(validateFields({ ...fields, symbol }).ok, false, `symbol ${symbol}`);
  assert.equal(validateFields({ ...fields, description: "x".repeat(501) }).ok, false);
  for (const website of ["http://bronze.example", "javascript:alert(1)", "https://user:pw@bronze.example", "not a url", 42]) assert.equal(validateFields({ ...fields, website }).ok, false, `website ${website}`);
  assert.equal(validateFields([]).ok, false);
  assert.equal(validateFields({ ...fields, website: "" }).ok, true, "empty link = none");
});

test("publicBase: https only, no trailing slash, short enough for a 200-byte metadata URI", () => {
  assert.equal(publicBase("https://media.parabull.test/"), "https://media.parabull.test");
  assert.equal(publicBase("https://cdn.parabull.test/coins"), "https://cdn.parabull.test/coins");
  assert.equal(publicBase("http://media.parabull.test"), null);
  assert.equal(publicBase("https://media.parabull.test/?x=1"), null);
  assert.equal(publicBase(undefined), null);
  assert.equal(publicBase(`https://${"a".repeat(130)}.test`), null);
});

test("metadataJson is deterministic and leaves absent links out", () => {
  const a = metadataJson({ name: "N", symbol: "S", description: "" }, `${BASE}/img/x.png`, "image/png");
  assert.equal(a, metadataJson({ name: "N", symbol: "S", description: "" }, `${BASE}/img/x.png`, "image/png"));
  assert.deepEqual(JSON.parse(a), { name: "N", symbol: "S", description: "", image: `${BASE}/img/x.png`, properties: { files: [{ uri: `${BASE}/img/x.png`, type: "image/png" }], category: "image" } });
});

test("the app's uploadMetadata gets a URI the program and the launch worker accept", async () => {
  const e = env();
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const encoded = new Response(init!.body as FormData);
    const body = new Uint8Array(await encoded.arrayBuffer());
    return handle(new Request(String(url), { method: init!.method, headers: { origin: APP, "content-type": encoded.headers.get("content-type")!, "content-length": String(body.length) }, body }), e);
  }) as typeof fetch;

  const image = new File([PNG], "anything.webp", { type: "image/webp" }); // the label is ignored: the bytes are a PNG
  const uri = await uploadMetadata(ENDPOINT, { name: "Bronze Bull", symbol: "BRONZE", description: "Charging.", image, website: "https://bronze.example", x: "https://x.com/bronzebull" });
  assert.equal(checkUri(uri), null, "fits the program's URI rules");
  assert.match(uri, /^https:\/\/media\.parabull\.test\/meta\/[0-9a-f]{64}\.json$/);

  const meta = e.store.objects.get(uri.slice(BASE.length + 1))!;
  assert.equal(meta.contentType, "application/json");
  assert.equal(meta.cacheControl, IMMUTABLE);
  const doc = JSON.parse(meta.body as string);
  assert.equal(doc.name, "Bronze Bull");
  assert.equal(doc.symbol, "BRONZE");
  assert.equal(doc.extensions.twitter, "https://x.com/bronzebull");
  assert.equal(doc.external_url, "https://bronze.example/");
  // What the launch worker checks (scripts/src/launchWorker.ts checkMetadataUri).
  assert.match(doc.image, /^https:\/\/media\.parabull\.test\/img\/[0-9a-f]{64}\.png$/);
  const img = e.store.objects.get(doc.image.slice(BASE.length + 1))!;
  assert.match(img.contentType!, /^image\/(png|jpeg|webp|gif)\b/);
  assert.equal(img.cacheControl, IMMUTABLE);
  assert.deepEqual(img.body, PNG);

  // Same coin, same image: same URI, nothing rewritten.
  const puts = e.store.puts();
  const again = await uploadMetadata(ENDPOINT, { name: "Bronze Bull", symbol: "BRONZE", description: "Charging.", image, website: "https://bronze.example", x: "https://x.com/bronzebull" });
  assert.equal(again, uri);
  assert.equal(e.store.puts(), puts, "content-addressed objects are written once");
});

test("each image type is stored under its own extension and content-type", async () => {
  for (const [bytes, ext, mime] of [[JPEG, "jpg", "image/jpeg"], [WEBP, "webp", "image/webp"], [GIF, "gif", "image/gif"]] as const) {
    const e = env();
    const res = await handle(await post(form(bytes)), e);
    assert.equal(res.status, 200);
    const { image } = (await res.json()) as { image: string };
    assert.ok(image.endsWith(`.${ext}`), image);
    assert.equal(e.store.objects.get(image.slice(BASE.length + 1))!.contentType, mime);
  }
});

test("refusals: origin, method, body, size, type, fields, config, rate limit", async () => {
  const e = env();
  const status = async (r: Request | Promise<Request>, en: Env = e) => (await handle(await r, en)).status;

  assert.equal(await status(post(form(PNG), null)), 403, "no Origin");
  assert.equal(await status(post(form(PNG), "https://evil.test")), 403, "other origin");
  assert.equal(await status(new Request(ENDPOINT, { method: "GET", headers: { origin: APP } })), 405);
  assert.equal(await status(new Request("https://edge.parabull.test/nope", { method: "POST" })), 404);

  const noLength = new Request(ENDPOINT, { method: "POST", headers: { origin: APP, "content-type": "multipart/form-data; boundary=x" }, body: "x" });
  assert.equal(await status(noLength), 411);
  assert.equal(await status(post(form(PNG), APP, { "content-length": String(MAX_IMAGE_BYTES + 70_000) })), 413, "declared length too big");
  assert.equal(await status(new Request(ENDPOINT, { method: "POST", headers: { origin: APP, "content-type": "application/json", "content-length": "2" }, body: "{}" })), 415);
  const garbled = new Request(ENDPOINT, { method: "POST", headers: { origin: APP, "content-type": "multipart/form-data; boundary=zzz", "content-length": "5" }, body: "hello" });
  assert.equal(await status(garbled), 400);

  const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
  big.set(PNG);
  assert.equal(await status(post(form(big))), 413, "image over 5,000,000 bytes");
  assert.equal(await status(post(form(SVG, fields, "logo.png", "image/png"))), 415, "an SVG labelled PNG");
  assert.equal(await status(post(form(new Uint8Array()))), 400, "empty image");
  assert.equal(await status(post(form(null))), 400, "no image");
  assert.equal(await status(post(form(PNG, "{not json"))), 400);
  assert.equal(await status(post(form(PNG, { ...fields, symbol: "lower" }))), 400);
  assert.equal(e.store.puts(), 0, "nothing stored for any refused request");

  assert.equal(await status(post(form(PNG)), env({ MEDIA_PUBLIC_URL: "" })), 500, "unconfigured public URL");
  assert.equal(await status(post(form(PNG)), env({ MEDIA_PUBLIC_URL: "http://media.parabull.test" })), 500);

  const seen: string[] = [];
  const limiter: RateLimiter = { limit: async ({ key }) => (seen.push(key), { success: seen.length <= 1 }) };
  const limited = env({ UPLOAD_LIMITER: limiter });
  assert.equal(await status(post(form(PNG), APP, { "cf-connecting-ip": "203.0.113.7" }), limited), 200);
  const res = await handle(await post(form(PNG), APP, { "cf-connecting-ip": "203.0.113.7" }), limited);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.deepEqual(seen, ["metadata:203.0.113.7", "metadata:203.0.113.7"]);
});

test("CORS: preflight and responses name only the allowed origin", async () => {
  const e = env();
  const pre = await handle(new Request(ENDPOINT, { method: "OPTIONS", headers: { origin: "https://parabull.test", "access-control-request-method": "POST" } }), e);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://parabull.test");
  assert.equal(pre.headers.get("access-control-allow-methods"), "POST");
  assert.equal(pre.headers.get("vary"), "Origin");
  const bad = await handle(new Request(ENDPOINT, { method: "OPTIONS", headers: { origin: "https://evil.test" } }), e);
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  // Errors carry CORS too, so the app can show the reason.
  const err = await handle(await post(form(SVG)), e);
  assert.equal(err.headers.get("access-control-allow-origin"), APP);
  assert.match(((await err.json()) as { error: string }).error, /PNG, JPEG, WebP or GIF/);
  const ok = await handle(new Request("https://edge.parabull.test/health"), e);
  assert.equal(await ok.text(), "ok");
});

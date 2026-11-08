/**
 * POST /metadata: the upload service behind the app's VITE_METADATA_UPLOAD_URL (app/src/lib/metadata.ts).
 *
 * The app posts multipart form data, `image` (the coin logo) and `metadata` (JSON: name, symbol, description, website,
 * twitter, telegram), and gets back `{ uri }`, which `request_launch` commits on-chain with the name and ticker. So:
 * - The stored objects never change. Both are content-addressed (`img/<sha256>.<ext>`, `meta/<sha256>.json`) and
 *   written only when absent, and served with an immutable cache policy.
 * - What is stored must pass the launch worker's own check (scripts/src/launchWorker.ts, checkMetadataUri): an https
 *   URI of at most 200 bytes, JSON naming an `image`, and that image a PNG, JPEG, WebP or GIF of at most 5,000,000
 *   bytes served with its own content-type. The image's type comes from its bytes, never from the client's label.
 * Pure apart from the bucket: no Workers-only APIs, so it runs under Node in the tests.
 */

/** The launch worker refuses larger images (checkMetadataUri reads at most 5,000,000 bytes). */
export const MAX_IMAGE_BYTES = 5_000_000;
/** Room for the multipart framing and the metadata field on top of the image. */
export const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 64 * 1024;
/** The program's MAX_URI_LEN (app/src/lib/metadata.ts checkUri). */
export const MAX_URI_BYTES = 200;
/** Mirrors app/src/lib/launchRules.ts and the Create form. */
export const MAX_NAME_BYTES = 32;
export const MAX_TICKER_LEN = 10;
export const MAX_DESCRIPTION = 500;
export const MAX_LINK = 200;

export const IMMUTABLE = "public, max-age=31536000, immutable";

/** The part of an R2 bucket binding this service uses (R2Bucket satisfies it). */
export interface MediaBucket {
  head(key: string): Promise<unknown | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
}

export type ImageType = { ext: "png" | "jpg" | "webp" | "gif"; mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };

/** The image format from its first bytes (magic numbers), or null when it isn't one of the four allowed. */
export function sniffImage(b: Uint8Array): ImageType | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: "png", mime: "image/png" };
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return { ext: "jpg", mime: "image/jpeg" };
  // "RIFF" <size> "WEBP"
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { ext: "webp", mime: "image/webp" };
  // "GIF87a" / "GIF89a"
  if (b.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return { ext: "gif", mime: "image/gif" };
  return null;
}

export interface MetadataFields {
  name: string;
  symbol: string;
  description: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

type Check<T> = { ok: true; value: T } | { ok: false; error: string };
const utf8 = new TextEncoder();

function httpsLink(v: unknown, label: string): Check<string | undefined> {
  if (v === undefined || v === null || v === "") return { ok: true, value: undefined };
  if (typeof v !== "string" || v.length > MAX_LINK) return { ok: false, error: `${label} must be a URL of at most ${MAX_LINK} characters` };
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password) return { ok: false, error: `${label} must be an https:// URL` };
    return { ok: true, value: u.href };
  } catch {
    return { ok: false, error: `${label} must be an https:// URL` };
  }
}

/** Checks the `metadata` field the app sends (lib/metadata.ts uploadMetadata). Unknown keys are dropped. */
export function validateFields(raw: unknown): Check<MetadataFields> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "metadata must be a JSON object" };
  const m = raw as Record<string, unknown>;
  const name = typeof m.name === "string" ? m.name.trim() : "";
  if (!name) return { ok: false, error: "name is required" };
  if (utf8.encode(name).length > MAX_NAME_BYTES) return { ok: false, error: `name is at most ${MAX_NAME_BYTES} bytes` };
  // The app sends the canonical ticker (canonicalTicker: letters and digits, upper case), as committed on-chain.
  const symbol = typeof m.symbol === "string" ? m.symbol : "";
  if (!new RegExp(`^[A-Z0-9]{1,${MAX_TICKER_LEN}}$`).test(symbol)) return { ok: false, error: `symbol must be 1-${MAX_TICKER_LEN} upper-case letters or digits` };
  const description = m.description === undefined ? "" : m.description;
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION) return { ok: false, error: `description is at most ${MAX_DESCRIPTION} characters` };
  const links: Partial<Record<"website" | "twitter" | "telegram", string>> = {};
  for (const k of ["website", "twitter", "telegram"] as const) {
    const r = httpsLink(m[k], k);
    if (!r.ok) return r;
    if (r.value) links[k] = r.value;
  }
  return { ok: true, value: { name, symbol, description: description.trim(), ...links } };
}

/**
 * The metadata JSON (Metaplex token-standard fields). Keys in a fixed order and absent links left out, so the same
 * coin and image always give the same bytes, and so the same `meta/<sha256>.json`.
 */
export function metadataJson(f: MetadataFields, imageUrl: string, mime: string): string {
  const extensions = Object.fromEntries((["website", "twitter", "telegram"] as const).filter((k) => f[k]).map((k) => [k, f[k]]));
  return JSON.stringify({
    name: f.name,
    symbol: f.symbol,
    description: f.description,
    image: imageUrl,
    ...(f.website ? { external_url: f.website } : {}),
    ...(Object.keys(extensions).length ? { extensions } : {}),
    properties: { files: [{ uri: imageUrl, type: mime }], category: "image" },
  });
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? utf8.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The public base URL objects are served from (the bucket's custom domain), without a trailing slash, or null when
 * it isn't an https URL short enough for a metadata URI to fit the program's 200 bytes.
 */
export function publicBase(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.search || u.hash || u.username || u.password) return null;
    const base = u.href.replace(/\/+$/, "");
    // `${base}/meta/<64 hex>.json`
    return utf8.encode(`${base}/meta/${"0".repeat(64)}.json`).length <= MAX_URI_BYTES ? base : null;
  } catch {
    return null;
  }
}

/** Writes `key` unless it already exists: content-addressed objects are never overwritten. */
export async function putOnce(bucket: MediaBucket, key: string, body: Uint8Array | string, contentType: string): Promise<void> {
  if (await bucket.head(key)) return;
  await bucket.put(key, body, { httpMetadata: { contentType, cacheControl: IMMUTABLE } });
}

export type UploadResult = { ok: true; uri: string; image: string } | { ok: false; status: number; error: string };

/** Stores the image and its metadata JSON and returns the metadata URI. `base` comes from publicBase(). */
export async function storeMetadata(form: FormData, bucket: MediaBucket, base: string): Promise<UploadResult> {
  const file = form.get("image");
  if (typeof file !== "object" || file === null || typeof (file as Blob).arrayBuffer !== "function") return { ok: false, status: 400, error: "image file is required" };
  if ((file as Blob).size > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: `image is larger than ${MAX_IMAGE_BYTES} bytes` };
  const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
  if (bytes.length === 0) return { ok: false, status: 400, error: "image is empty" };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: `image is larger than ${MAX_IMAGE_BYTES} bytes` };
  const type = sniffImage(bytes);
  if (!type) return { ok: false, status: 415, error: "image must be a PNG, JPEG, WebP or GIF" };

  const rawMeta = form.get("metadata");
  if (typeof rawMeta !== "string") return { ok: false, status: 400, error: "metadata field is required" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMeta);
  } catch {
    return { ok: false, status: 400, error: "metadata is not valid JSON" };
  }
  const fields = validateFields(parsed);
  if (!fields.ok) return { ok: false, status: 400, error: fields.error };

  const imageKey = `img/${await sha256Hex(bytes)}.${type.ext}`;
  const image = `${base}/${imageKey}`;
  const json = metadataJson(fields.value, image, type.mime);
  const metaKey = `meta/${await sha256Hex(json)}.json`;
  const uri = `${base}/${metaKey}`;
  if (utf8.encode(uri).length > MAX_URI_BYTES) return { ok: false, status: 500, error: "metadata URI would exceed 200 bytes" };
  // Image first: the JSON never points at an object that isn't there.
  await putOnce(bucket, imageKey, bytes, type.mime);
  await putOnce(bucket, metaKey, json, "application/json");
  return { ok: true, uri, image };
}

# parabull-edge

A Cloudflare Worker that holds Parabull's media in R2, so no Internet Computer canister stores or serves images.
The frontend canister serves only the app's build. The browser talks to this Worker and the R2 CDN domain directly,
cross-origin, and nothing is proxied through the canister.

This first version implements the coin-metadata upload behind the app's `VITE_METADATA_UPLOAD_URL`. The chat
(Durable Objects) and livestream (Cloudflare Stream) routes described in the media audit come later.

## Routes

| Route | What it does |
| --- | --- |
| `POST /metadata` | Multipart `image` + `metadata` (the app's `uploadMetadata`, `app/src/lib/metadata.ts`). Stores `img/<sha256>.<ext>` and `meta/<sha256>.json` in R2 and returns `{ uri, image }`. |
| `OPTIONS /metadata` | CORS preflight for the allowed origins. |
| `GET /health` | `ok` |

**The image** must be a PNG, JPEG, WebP or GIF of at most 5,000,000 bytes.
- The type is read from the file's own bytes; the browser's label is ignored, so an SVG called `logo.png` is refused.
- The size limit matches the launch worker's check (`scripts/src/launchWorker.ts`, `checkMetadataUri`), so any image
  this Worker accepts also passes when the coin is launched.

**The metadata** must use the same rules as the app's Create form:
- `name`: 1 to 32 UTF-8 bytes.
- `symbol`: the ticker as committed on-chain, 1 to 10 upper-case letters or digits.
- `description`: at most 500 characters.
- `website`, `twitter`, `telegram`: optional `https://` links.

**The stored JSON** follows the Metaplex token standard: `name`, `symbol`, `description`, `image`, `external_url`,
`extensions`, and `properties.files`. Its keys are written in a fixed order, so the same coin and image always give the
same `meta/<sha256>.json`.

**Stored objects never change.** The metadata URI is committed on-chain when the launch is requested, so:
- each object is written only if it doesn't already exist, with
  `Cache-Control: public, max-age=31536000, immutable`;
- the image is written before the JSON, so the JSON never points at an image that isn't there.

**Fails closed.** These are refused before anything is read or stored:
- a missing or unlisted `Origin`;
- a body that isn't `multipart/form-data`;
- a missing or oversized `Content-Length`;
- an unset or non-https `MEDIA_PUBLIC_URL`;
- a caller over the rate limit.

## Setup

1. Create an R2 bucket named `parabull-media`.
2. Give the bucket a public custom domain (R2 > bucket > Settings > Custom Domains), e.g. `media.parabull.xyz`.
   - Images load from that domain in `<img>` tags, which the app's CSP already allows (`img-src https:`).
   - The launch worker fetches them server-side.
   - Neither needs CORS rules on the bucket.
3. Set the variables in `wrangler.toml`:
   - `MEDIA_PUBLIC_URL`: the custom domain, e.g. `https://media.parabull.xyz`.
   - `ALLOWED_ORIGINS`: the frontend canister's URL (`https://<id>.icp0.io`) and any custom domain.
4. Deploy and route the Worker:

   ```bash
   npx wrangler@4 deploy
   ```

   Give it a route or custom domain such as `edge.parabull.xyz`.
5. Build the app with these variables:
   - `VITE_METADATA_UPLOAD_URL=https://edge.parabull.xyz/metadata`
   - `VITE_MEDIA_URL=https://media.parabull.xyz`

   The CSP's `connect-src` picks up both origins at build time (`app/src/lib/icHeaders.ts`).

**Rate limit:** 10 uploads per minute per IP, through the `UPLOAD_LIMITER` binding (`[[ratelimits]]` in
`wrangler.toml`). Without that binding, add a WAF rate-limiting rule on `/metadata` instead.

## Develop

```bash
npm ci
npm run typecheck
npm test
```

The tests run under Node with an in-memory bucket. They also run the app's own `uploadMetadata` client against the
Worker and check the stored objects against the program's URI rules and the launch worker's image rules.

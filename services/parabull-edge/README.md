# parabull-edge

A Cloudflare Worker for Parabull's media and coin chat, so no Internet Computer canister stores media or relays
messages. The frontend canister serves only the app's build. The browser talks to this Worker, its R2 bucket and its
chat rooms directly, cross-origin, and nothing is proxied through the canister.

It implements:
- the coin-metadata upload behind the app's `VITE_METADATA_UPLOAD_URL`;
- the real-time coin chat behind `VITE_CHAT_URL`: one `ChatRoom` Durable Object per coin mint, with wallet sign-in
  and image or GIF uploads.

Livestreams (Cloudflare Stream) come later.

## Routes

| Route | What it does |
| --- | --- |
| `POST /metadata` | Multipart `image` + `metadata` (the app's `uploadMetadata`, `app/src/lib/metadata.ts`). Stores `img/<sha256>.<ext>` and `meta/<sha256>.json` in R2 and returns `{ uri, image }`. |
| `POST /chat/session` | Wallet sign-in: `{ wallet, issuedAt, nonce, signature }` → `{ token, wallet, expiresAt }` (`src/session.ts`). |
| `POST /chat/upload` | A chat image or GIF (`Authorization: Bearer <token>`), stored as `img/<sha256>.<ext>`; returns `{ url }`. |
| `GET /chat/:mint` | WebSocket into that coin's `ChatRoom` (`src/chatRoom.ts`, `src/chatRoomDO.ts`). |
| `OPTIONS /metadata`, `/chat/session`, `/chat/upload` | CORS preflight for the allowed origins. |
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

## Coin chat

**One room per coin.** `GET /chat/:mint` (a websocket) goes to the `ChatRoom` Durable Object named by that mint.
- The room accepts the socket through the **WebSocket Hibernation API**, so an idle room is evicted and costs nothing.
  Keepalive `ping`s are answered by the runtime without waking it.
- Nothing lives only in memory:
  - each socket's mint, signed-in wallet and session expiry live in its serialized attachment;
  - the last 200 messages and each wallet's last send time live in the object's **SQLite storage**.
  - Storage is created only when a signed-in wallet first posts, so readers never allocate any, however many rooms
    they open. Sender rows are pruned once their 2-second cooldown has passed.
  - A woken room therefore carries on as before: history is replayed, signed-in sockets stay signed in, and cooldowns
    still apply.

**Reading needs nothing.** A new socket gets `{type:"history"}` (the last 200 messages) and everyone gets
`{type:"presence", count}`.

**Posting needs a signed-in wallet** (`src/session.ts`):
1. The wallet signs the sign-in text once (`chatSignInMessage` in `app/src/lib/chatMessage.ts`, the protocol file the
   app and this Worker share). It's a message signature, not a transaction, and costs nothing.
2. `POST /chat/session` checks the ed25519 signature against the wallet's address and requires `issuedAt` within 5
   minutes of now. It returns a 24-hour token: an HMAC-SHA256 over the wallet and expiry, keyed by `CHAT_SECRET`.
3. The socket sends `{type:"auth", token}`, and the room answers `{type:"ready", wallet}`.
4. Each `{type:"send", cid}` gets an answer for that socket alone: `{type:"sent", cid, id}`, or an error carrying the
   same `cid`. So a second tab on the same wallet never takes the first tab's message as its own confirmation.

**Rules the room enforces:**
- at most one message per wallet every 2 seconds;
- at most 280 characters (code points), with no control characters;
- up to 4 attachments, each an image `MEDIA_PUBLIC_URL/img/<sha256>.(png|jpg|webp|gif)`, exactly as `POST /chat/upload`
  and `POST /metadata` store them.

Anything else gets `{type:"error", code}`: `sign_in_required`, `session_expired`, `rate_limited` (with
`retryAfterMs`), `too_long`, `empty`, `bad_attachment` or `bad_request`.

**Fails closed:**
- Without a `CHAT_SECRET` of 32 or more characters, sign-in answers 503 and no token verifies, so chat is read-only.
- Sockets from origins outside `ALLOWED_ORIGINS` are refused, which also stops cross-site websocket hijacking.
- `CHAT_LIMITER` limits sign-ins and uploads per IP, and `CHAT_CONNECT_LIMITER` limits socket handshakes per IP. A
  client outside a browser can fake `Origin`, so the handshake limit is what caps how many rooms one client opens.

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

**Rate limits** (`[[ratelimits]]` in `wrangler.toml`; without those bindings, add WAF rate-limiting rules instead):
- `UPLOAD_LIMITER`: 10 metadata uploads per minute per IP.
- `CHAT_LIMITER`: 20 chat sign-ins and uploads per minute per IP.
- `CHAT_CONNECT_LIMITER`: 60 chat socket handshakes per minute per IP.

**Chat setup:**
1. Set the chat session key, a secret rather than a variable:

   ```bash
   openssl rand -base64 48 | npx wrangler@4 secret put CHAT_SECRET
   ```

2. `wrangler deploy` creates the `ChatRoom` class from the `[[migrations]]` entry (`new_sqlite_classes`), so the rooms
   get SQLite storage.
3. Build the app with `VITE_CHAT_URL=wss://edge.parabull.xyz` (the Worker's origin). The CSP's `connect-src` picks up
   its `wss://` and `https://` origins.

## Develop

```bash
npm ci
npm run typecheck
npm test
```

The tests run under Node with an in-memory bucket. They also run the app's own `uploadMetadata` client against the
Worker and check the stored objects against the program's URI rules and the launch worker's image rules.

The chat tests (`src/chat.test.ts`) drive the room code (`ChatRoomCore`) the way the runtime does. The stand-in
storage is a real `node:sqlite` database, and the sockets keep their serialized attachments. "Hibernation" is a fresh
`ChatRoomCore` on the same storage and sockets. They cover:
- broadcast to signed-in and anonymous sockets;
- persistence across eviction: history, signed-in sockets and cooldowns;
- sign-in: real ed25519 signatures, forged, stale, swapped or expired tokens, and a missing secret;
- the 280-character limit, the 2-second cooldown, attachment rules, the 200-message cap, presence, routing and uploads.

`src/chatRoomDO.ts` and `src/index.ts` import `cloudflare:workers`, so they load only under wrangler.

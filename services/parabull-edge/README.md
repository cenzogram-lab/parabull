# parabull-edge

A Cloudflare Worker for Parabull's media and coin chat, so no Internet Computer canister stores media or relays
messages. The frontend canister serves only the app's build. The browser talks to this Worker, its R2 bucket and its
chat rooms directly, cross-origin, and nothing is proxied through the canister.

It implements:
- the coin-metadata upload behind the app's `VITE_METADATA_UPLOAD_URL`;
- the real-time coin chat behind `VITE_CHAT_URL`: one `ChatRoom` Durable Object per coin mint, with wallet sign-in
  and image or GIF uploads;
- the list of coins live on Cloudflare Stream (`GET /live`), which the app's Stream player reads;
- going live for a coin's creator (`POST /live/input`): their Stream live input, after checking on-chain that they
  launched the coin.

## Routes

| Route | What it does |
| --- | --- |
| `POST /metadata` | Multipart `image` + `metadata` (the app's `uploadMetadata`, `app/src/lib/metadata.ts`). Stores `img/<sha256>.<ext>` and `meta/<sha256>.json` in R2 and returns `{ uri, image }`. |
| `POST /chat/session` | Wallet sign-in: `{ wallet, issuedAt, nonce, signature }` → `{ token, wallet, expiresAt }` (`src/session.ts`). |
| `POST /chat/upload` | A chat image or GIF (`Authorization: Bearer <token>`), stored as `img/<sha256>.<ext>`; returns `{ url }`. |
| `GET /chat/:mint` | WebSocket into that coin's `ChatRoom` (`src/chatRoom.ts`, `src/chatRoomDO.ts`). |
| `GET /live` | Coins streaming now: `{ streams: [{ mint, input, title, creator, hls }] }` (`src/live.ts`). |
| `POST /live/input` | `{ mint, title? }` with `Authorization: Bearer <session token>`. Returns the coin creator's live input: `{ input, rtmps {url, streamKey}, srt {url, streamId, passphrase}, hls }` (`src/broadcast.ts`). |
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

## Live streams (Cloudflare Stream)

**Each broadcaster has one Stream live input.** An input created for a coin carries `meta.mint`, and optionally
`meta.title` and `meta.creator` (the wallet). Create one with the API, using a token with Stream Edit:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/stream/live_inputs" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"meta":{"mint":"<coin mint>","title":"Dev AMA","creator":"<wallet>"},"recording":{"mode":"automatic"}}'
```

The response holds the RTMPS URL and stream key, and the SRT URL. Point OBS or any encoder at one of them. Creators
normally don't need this: `POST /live/input` does it for them, from the app.

**Not WebRTC:** the response also has a WHIP URL, but `POST /live/input` leaves it out. Stream can't play a WHIP
broadcast over HLS or record it ([WebRTC limitations](https://developers.cloudflare.com/stream/webrtc/)), and HLS is
what viewers here use. Going live from the browser would need WHEP playback, and it would have to be tested against a
real Stream account.

**Going live from the app (`POST /live/input`):**
1. **The wallet:** the request carries the same session token as chat (`Authorization: Bearer`, from the wallet's
   one-time sign-in).
2. **The creator check:** the Worker reads the coin's bonding curve over `SOLANA_RPC_URL` (`src/solana.ts`):
   - it derives the program address `["bonding-curve", mint]` the way `@solana/web3.js` does (tests compare
     against web3.js vectors);
   - it checks the account's owner, discriminator and `mint`;
   - it requires `creator` to be that wallet.
   Anyone else gets 403. A coin that isn't on chain (demo coins) gets 404, and nothing is asked of Stream.
3. **One live input per coin:** the Worker finds the input by `meta.mint` and reuses it. The first time, it creates
   one with `meta {mint, creator, title}` and automatic recording. A new title updates `meta.title`.
   - **Capacity:** `GET /live` checks at most 100 coin inputs (`MAX_INPUTS` in `src/live.ts`, one lifecycle call each
     per refresh). So no new input is created past 100; that request gets 503, and coins that already have an input
     keep it. Delete inputs you no longer need to free room. Going past 100 needs a live-status index (for example,
     from Stream's webhooks) instead of polling.
   - **Races:** two first-time requests at once (a double click, two devices) would both find no input and both create
     one, and two coins at once could both pass the capacity check. So the Worker forwards every request to one
     `ChatRoom` Durable Object, named `live-inputs` (never a mint, so never a chat room), which runs them one at a
     time (`ChatRoomCore.liveInput`). A waiting request sees what the ones before it created.
4. **The answer** carries the stream key, so it is `Cache-Control: no-store`. `CHAT_LIMITER` limits these requests per
   IP, and only allowed origins can call it.

**How `GET /live` works:**
1. It lists the account's live inputs. The list carries no live status.
2. It keeps enabled inputs whose `meta.mint` is a Solana address.
3. It asks each one's `lifecycle` endpoint (`https://<STREAM_HOST>/<input>/lifecycle`, which answers
   `{ isInput, videoUID, live }`) whether it's live.
4. It returns the live ones, each with `https://<STREAM_HOST>/<input>/manifest/video.m3u8`. A live input's id plays its
   current broadcast (Cloudflare's "Watch a live stream" page).

**Caching:** the answer is kept for 15 seconds per isolate, and responses carry `Cache-Control: public, max-age=15`.
So the Stream API sees one list call and one lifecycle check per input every 15 seconds, however many people watch.

**Fails closed:**
- Without `CF_ACCOUNT_ID`, `CF_STREAM_TOKEN` and `STREAM_HOST`, `/live` answers 503; `/live/input` also needs
  `SOLANA_RPC_URL` and the `CHAT_ROOMS` binding.
- A Stream API failure answers 502, not "nobody is live".
- An input whose lifecycle check fails counts as not live.
- Only allowed origins can call it.

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

**Stream setup:**
1. Set `CF_ACCOUNT_ID` and `STREAM_HOST` (`customer-<code>.cloudflarestream.com`, shown on the Stream dashboard) in
   `wrangler.toml`.
2. Set the Stream token, a secret rather than a variable. Give it Stream Write, so creators can go live; that also
   covers reading:

   ```bash
   npx wrangler@4 secret put CF_STREAM_TOKEN
   ```

3. Set `SOLANA_RPC_URL` (and `PARABULL_PROGRAM_ID` if the program isn't at the IDL's address) so the Worker can check
   coin creators.
4. Build the app with `VITE_STREAM_HOST=customer-<code>.cloudflarestream.com` as well:
   - The CSP's `connect-src` and `media-src` pick up that host for the player.

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

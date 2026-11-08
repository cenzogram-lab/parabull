# parabull-indexer

Indexes Parabull's on-chain state from Solana RPC and serves it to the app over REST and a WebSocket stream. In
chain mode, the app's board, coin pages, trade tape, holders and positions come from here (`VITE_INDEXER_URL`).
The API is specified in [`docs/BACKEND_SPEC.md` §5](../../docs/BACKEND_SPEC.md).

It runs apart from `app/` and has no runtime dependencies: Node 22's `fetch` and `WebSocket` and `node:http`. It
signs nothing and holds no keys.

## What it reads

- **Accounts and events, decoded from the committed IDL** (`app/src/idl/parabull.json`). CI keeps that file equal to
  the program's own IDL build, so a layout change shows up here without hand-kept offsets.
  - The codec tests pin bytes produced by Anchor's own `BorshCoder`.
  - Program events are taken only from "Program data:" lines logged while this program is the one executing, so a
    Raydium CPI's events never count as ours.
- **Coin metadata** from the mint's Token-2022 metadata extension (immutable after `create`). The URI's JSON (image,
  description, links) is fetched only from `METADATA_ORIGINS`, with no redirects and a size cap.
- **New transactions** come two ways:
  - `logsSubscribe` gives latency;
  - polling `getSignaturesForAddress` + `getTransaction` is the source of truth, backfill and gap-filler.

  The two are deduplicated by signature.
- **On-demand lookups.** A coin created since the last poll is found by its curve PDA when someone asks for it, so a
  just-launched coin's page never says "Coin not found".
- **Referred buys** (`src/memo.ts`, `src/referrals.ts`). A buy whose transaction has a top-level
  `parabull:ref:<calloutId>` SPL Memo is recorded for that callout, from the same logs as its `TradeEvent`. Served
  per callout and by time window (`/referrals`) for `scripts/src/callerEpoch.ts`.
- **Reward epochs** (`src/rewards.ts`). Every `RewardEpoch` account (root, total, claimed bitmap, expiry) and the
  snapshot file it was published from (`REWARDS_BASE_URL/epoch-<n>.json`).
  - Each file's tree is rebuilt and checked against the on-chain root before any allocation is served.
  - Proofs come from that rebuilt tree, never from the file.
  - Claims show at once from `HolderRewardClaimed` and are confirmed by the bitmap on the next sync.

Everything is rebuilt from the chain on start (in memory, `src/store.ts`). See the spec's §5.3 for limits.

## Run

```bash
npm ci
RPC_URL=https://your-rpc.example.com npm start
```

| Variable | Default | |
| --- | --- | --- |
| `RPC_URL` | (required) | Solana JSON-RPC. It must allow `getProgramAccounts`, which many free endpoints don't. |
| `RPC_WS_URL` | from `RPC_URL` | Its websocket, for `logsSubscribe`. `off` relies on polling alone. |
| `PROGRAM_ID` | the IDL's address | |
| `PORT`, `HOST` | `8790`, `0.0.0.0` | |
| `ALLOWED_ORIGINS` | any | Comma-separated origins for CORS and `/stream`. Set it to the app's canister URL and custom domain. |
| `METADATA_ORIGINS` | none | Where metadata JSON may be fetched from, e.g. `https://media.parabull.xyz` (parabull-edge's R2 domain). |
| `BACKFILL_LIMIT` | `1000` | Program transactions read on start. |
| `POLL_MS`, `CURVES_MS`, `TICKETS_MS`, `HOLDERS_MS` | `3000`, `30000`, `15000`, `120000` | |
| `RPC_REQUESTS_PER_MINUTE` | `60` | Per-IP limit on requests that reach the RPC (holders, portfolio, not-yet-indexed coins). |
| `TRUST_PROXY` | off | `1` takes the client IP from `X-Forwarded-For` (only behind your own proxy). |
| `REWARDS_BASE_URL` | none | Where `epoch-<n>.json` snapshot files are served (from `scripts/src/snapshot.ts` and `callerEpoch.ts`). Unset, epochs are listed but no allocations are served. |
| `REWARDS_MS` | `60000` | Reward-epoch sync cadence. |

Then build the app with `VITE_INDEXER_URL=https://indexer.example.com`. The app's CSP `connect-src` picks up its
`https://` and `wss://` origins.

## Develop

```bash
npm run typecheck
npm test
```

The tests run against `src/mockChain.ts`, a small simulated cluster:

- **Accounts and transactions in memory**, served over the same JSON-RPC methods (and over HTTP with `serve()`),
  plus `logsSubscribe` pushes to a fake socket.
- **Real state changes:** launches, trades and graduation follow the repository's curve math, and every account and
  event is encoded from the IDL.

| File | Covers |
| --- | --- |
| `codec.test.ts` | Anchor-encoded vectors, the encoder as the decoder's inverse, the log invoke stack, Token-2022 metadata |
| `indexer.test.ts` | the items below |
| `api.test.ts` | Endpoints, filters and paging, on-demand coins, validation, per-IP limits, RPC-down 502s, CORS, the `/stream` socket |

`indexer.test.ts` covers:

- tickets: pending → created, refunded, or closed without an event;
- trades and 24h stats; failed transactions skipped;
- graduation and migration, with the Raydium CPI event ignored;
- the websocket and poller deduped;
- backfill paging with `before`/`until`, and the cursor on RPC failure;
- on-demand coins and the missing-coin cache;
- holders and labels, portfolio, metadata JSON safety.

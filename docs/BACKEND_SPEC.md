# Parabull backend spec (off-chain)

This covers the services that sit next to the on-chain program and match
Peak-style launch protections that can't be enforced on-chain. Anything that
can be enforced on-chain is enforced there; this document only specifies
what's left.

| Protection | Enforced by |
| --- | --- |
| No trading in the creation slot | **On-chain:** `trading_open_slot` |
| Creator can't bundle their own block-zero buy | **On-chain:** `create` requires the launch authority's signature |
| Ticker / name / announcement-tweet locked for 3 days | **On-chain:** `TickerRegistry`, `NameRegistry`, `TweetRegistry` |
| Unpredictable creation time | Off-chain: launch worker random delay (§1) |
| Tweet actually belongs to the creator | Off-chain: tweet verification (§1.2) |
| Bundle risk badge | Off-chain: bundle indexer (§2) |
| Lookalike / duplicate image and name flags | Off-chain: similarity service (§3) |

Conventions:
- Lamports and raw token amounts are integers (u64).
- Times are Unix seconds unless marked `_ms`.
- Every worker is idempotent and keyed by an on-chain address, so it can be
  restarted at any time.

---

## 1. Launch worker: `LaunchTicket` → `create` after a random 3–15 s

Minimal implementation: `scripts/launch_worker.ts` (`npm run worker`), with
the testable logic (`decide`, request-transaction decoding, metadata and
tweet checks, the delay) in `scripts/src/launchWorker.ts`. It keeps jobs in
memory rather than the durable table in §1.3, and checks the tweet's
`$TICKER` and age but not its author unless given the linked account ID.

The ticket stores only `metadata_hash`, not the plaintext name, symbol and
URI. The worker recovers them by decoding the user's `request_launch`
instruction (from the `LaunchRequested` log's signature, or
`getSignaturesForAddress(ticket)`) and refunds the ticket if they don't
reproduce `metadata_hash`.

### 1.1 Trigger

- Subscribe to the program's logs with `logsSubscribe({ mentions: [programId] })`
  at `confirmed` commitment, and decode `LaunchRequested` events with Anchor's
  `EventParser`. As a fallback, every 30 s poll
  `program.account.launchTicket.all()` for tickets you haven't seen yet.
- Deduplicate by ticket address. A ticket is finished once its account is
  closed, whether by `create` or `refund_ticket`.

### 1.2 Validate before scheduling

Validation happens **before** the delay, so a rejected ticket is refunded at
once with `refund_ticket` signed by the launch authority (allowed at any
time; funds always go to the payer).

1. **Program not paused:** check `Global.paused`. While paused, `create`
   fails anyway.
2. **Lock pre-check:** fetch `["registry", ticker]`, `["name", name_hash]`
   and, if the ticket has a tweet, `["tweet", tweet_id_hash]`. If any of them
   has `mint != default` and
   `now < launch_timestamp + Global.registry_lock_seconds`, refund (the
   ticker, name or tweet is locked).
3. **Metadata:** fetch the URI and check it's valid JSON with a reachable
   image (fetch rules in §3.1). `create` checks name/symbol/URI against the
   ticket's commitment hash, so the backend can't change them; it can only
   accept or refuse.
4. **Tweet verification**, if the ticket has `tweet_id_hash`:
   - The user submits the tweet URL in the UI. Extract the numeric status ID
     (`scripts/src/launch.ts` `parseTweetId`) and check that
     `tweetIdHash(id)` equals the ticket's `tweet_id_hash`.
   - Fetch the tweet with X API v2:
     `GET /2/tweets/:id?expansions=author_id&tweet.fields=created_at,text`.
   - Require all of: the author equals the X account the creator linked by
     OAuth; the text contains `$TICKER` (case-insensitive); the tweet was
     posted within 24 h; and it isn't a reply or retweet of someone else's
     tweet.
   - On-chain, the program only guarantees that one tweet can't back two
     launches within 3 days. Whether the creator actually wrote it is this
     check.
5. **Similarity checks** (§3): an exact duplicate image of a launch from the
   last 3 days is refused. Everything else only produces flags.

### 1.3 Random delay

```ts
import { randomInt } from "crypto";
// Uniform over [3000, 15000] ms inclusive. Use crypto RNG, never Math.random.
const delayMs = randomInt(3_000, 15_001);
const runAt = Date.now() + delayMs;
```

- Store the job durably (for example `jobs(ticket PRIMARY KEY, run_at,
  attempts, state)`) so a restart neither loses nor repeats it.
- Before sending, re-read the ticket. If it's closed, the job is done. If
  `now >= expires_at - 30`, give up and leave the ticket for the payer to
  refund. The default TTL is 600 s, far longer than 15 s plus retries.
- **What the delay does:** it makes the creation slot unpredictable. Note that
  the `LaunchRequested` event and the ticket account are public and include
  the ticker, so a sniper knows a launch is coming. They still don't know the
  mint address, which is a server-generated keypair, until `create` lands, and
  they can't trade until `trading_open_slot` regardless. The on-chain slot
  delay is the actual block-zero protection; the random delay adds timing
  uncertainty on top.

### 1.4 Send `create`

- Generate the mint keypair in the worker's memory at send time. Never write
  it to disk, logs or the job table. After `create` the mint has no mint,
  freeze or update authority, so the key is worthless once the transaction
  lands; until then, leaking it would let someone front-run the address.
- Set the compute limit to 400,000 and a priority fee from recent
  `getRecentPrioritizationFees`.
- Pass `tweetRegistry` only if the ticket has a tweet (otherwise `null`).
  Passing it when it shouldn't be there, or omitting it when it should, fails
  with `TweetRegistryMismatch`.
- **Retries:** if the blockhash expires, rebuild and re-sign with **the same
  mint keypair** until `expires_at - 30`. If the mint account already exists,
  or the ticket is closed, an earlier send landed: treat that as success.
- Reference implementation: `scripts/launch_worker.ts`. On a terminal
  Anchor error (`TickerLocked`, `NameLocked`, `TweetLocked`,
  `MetadataMismatch`, ...) it refunds the ticket instead of retrying.
- **Settlement:** the payer's flat 0.23 SOL includes the ticket rent. `create`
  repays the launch authority exactly the rent it fronted, out of the 0.03 SOL
  allocation, and closes the ticket to the treasury (fee plus unspent
  allocation). The launch authority's balance is therefore unchanged by a
  launch apart from transaction fees.

---

## 2. Bundle-risk indexer (first 20 slots)

### 2.1 Window and inputs

- **Window:** slots `[trading_open_slot, trading_open_slot + 20)`. Trading
  can't happen before `trading_open_slot`, so this is the first 20 slots in
  which buying is possible. Read `trading_open_slot` from the
  `TokenCreated` event or the `BondingCurve` account.
- **Trade stream:** a Yellowstone/Geyser gRPC subscription filtered to the
  program ID, or a webhook provider. As a fallback, poll
  `getSignaturesForAddress(bondingCurve)` and `getTransaction` (with
  `maxSupportedTransactionVersion: 0`).
- **Decode** `TradeEvent` from each transaction's `Program data:` logs (this
  needs the SBF build; logs aren't available in program-test).
- **Record for each buy in the window:** buyer (`TradeEvent.user`), fee
  payer, slot, transaction index in the block, signature, `token_amount`,
  `sol_amount`, whether the transaction pays a Jito tip (a transfer to one of
  the published Jito tip accounts), and whether it shares a bundle with other
  buys (consecutive transactions in one block that end in a tip).
- **Holdings at the end of the window:** each buyer's token balance from
  `postTokenBalances` of their last transaction in the window.

### 2.2 Funding graph

For each buyer, collect inbound SOL transfers (system transfers and
`closeAccount` refunds) from the 72 h before their first buy, using
`getSignaturesForAddress(buyer, { limit: 200 })` plus parsed transactions.
Then group wallets with union-find. Two wallets are in the same cluster if
any of these holds:

1. **Same direct funder.** Ignore funders on a maintained CEX hot-wallet
   list, which are shared by unrelated users.
2. **One buyer funded another** buyer.
3. **Same fee payer** across buy transactions.
4. **Same Jito bundle**, or the same slot and an identical `sol_amount` to
   within 1%.
5. **Creator-linked:** the wallet is the ticket payer (`creator`), or is
   linked to it by rules 1–4. Mark the whole cluster as creator-linked.

### 2.3 Score and badge

All supply percentages are of `token_total_supply`, using holdings at the end
of the window.

| Metric | Definition |
| --- | --- |
| `bundled_pct` | Supply held by clusters of 2 or more wallets |
| `creator_linked_pct` | Supply held by creator-linked clusters |
| `fresh_wallet_pct` | Supply held by wallets whose first-ever transaction is under 24 h old |
| `same_slot_pct` | Supply bought in the window's busiest single slot |

| Badge | Condition (thresholds are configurable) |
| --- | --- |
| **Clean** (green) | `bundled_pct < 5` and `creator_linked_pct < 1` |
| **Caution** (yellow) | `5 ≤ bundled_pct ≤ 15`, or `1 ≤ creator_linked_pct ≤ 5` |
| **Bundled** (red) | `bundled_pct > 15`, or `creator_linked_pct > 5` |

### 2.4 Output

`GET /tokens/:mint/bundle-risk`:

```json
{
  "mint": "…",
  "window": { "fromSlot": 123, "toSlotExclusive": 143 },
  "status": "pending | final",
  "badge": "clean | caution | bundled",
  "bundledPct": 3.2,
  "creatorLinkedPct": 0.0,
  "freshWalletPct": 11.5,
  "sameSlotPct": 4.1,
  "clusters": [
    { "wallets": ["…", "…"], "funder": "…", "supplyPct": 2.1, "creatorLinked": false, "reasons": ["same_funder", "same_slot"] }
  ],
  "computedAt": 1762099200
}
```

- `status` stays `pending` until the window's last slot is finalized (about
  32 slots later); after that the report is frozen. Show a pending state in
  the UI before then.
- These are heuristics: a shared CEX withdrawal can produce a false positive.
  Present the badge as a risk signal, with the clusters behind it visible, not
  as an accusation.

---

## 3. Lookalike and duplicate flags

### 3.1 Image fetch (SSRF-safe)

- Only `https:` URLs, plus `ipfs://` and `ar://` rewritten to an allowlisted
  gateway.
- Resolve DNS yourself, refuse private, loopback, link-local and metadata IP
  ranges, then connect to that IP. Re-check on every redirect, with at most 3
  redirects.
- 5 s timeout, 5 MB limit, `content-type` of `image/png`, `image/jpeg`,
  `image/webp` or `image/gif`, and at most 4096×4096 after decoding. For a GIF,
  use the first frame.

### 3.2 Hashes

- `sha256` of the raw bytes, for exact duplicates.
- **pHash (64-bit):** grayscale, resize to 32×32, 2-D DCT, take the
  top-left 8×8 block excluding DC, threshold at the median.
- **dHash (64-bit),** as a second, cheap opinion.

Index pHash/dHash for launches from the last 7 days, plus a protected list of
established tokens, in a BK-tree (or multi-index hashing for scale).

| Flag | Condition |
| --- | --- |
| `duplicate_image` | Same sha256, **or** pHash Hamming distance ≤ 6 |
| `similar_image` | pHash Hamming distance 7–12 (and dHash ≤ 14) |
| `lookalike_name` | Same Unicode-confusable skeleton (UTS #39) as another name or ticker, or ticker Levenshtein distance ≤ 1 (tickers of 4+ characters), or normalized-name Levenshtein distance ≤ 2 |

On-chain registries already catch exact normalized ticker and name matches
(names keep only ASCII letters and digits, lowercased, so case, spaces and
punctuation don't matter), so this layer only needs to catch
what they can't: confusable Unicode, near-misses and images.

### 3.3 Policy and output

- **At ticket time (before `create`):** refuse a `duplicate_image` of a launch
  from the last 3 days. Refund the ticket; this matches the on-chain lock
  window. Every other flag is shown, not blocking.
- **At `create` and afterwards:** store the flags and serve them at
  `GET /tokens/:mint/flags`:

```json
[{ "type": "similar_image", "matchMint": "…", "distance": 9, "detectedAt": 1762099200 }]
```

---

## 4. Suggested tables

```
tickets(ticket PK, payer, ticker, name_hash, tweet_id_hash, expires_at, state, run_at, attempts)
launches(mint PK, ticket, creator, created_slot, trading_open_slot, tweet_id, image_sha256, phash, dhash)
trades(signature PK, mint, user, fee_payer, slot, tx_index, is_buy, token_amount, sol_amount, jito_tip)
wallet_funding(wallet, funder, lamports, slot, signature)
bundle_reports(mint PK, status, badge, report_json, computed_at)
flags(mint, type, match_mint, distance, detected_at)
```

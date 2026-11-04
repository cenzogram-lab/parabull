# X sentinel

A small Node service that posts a Parabull coin's bonding-curve milestones to X and answers cashtag mentions of the
project's account, in the persona the creator picks. It runs on its own: `app/` only talks to its HTTP API from the
creator's X automation modal (`app/src/components/coin/XAutomationModal.tsx`), and no code from here is bundled into
the app.

```bash
cd services/twitter-sentinel
npm ci
npm test          # unit and end-to-end tests (dry run, fake chain)
npm run typecheck
npm start         # dry run by default: posts are logged, not sent
```

## What it does

- **Milestone posts.** It watches each configured coin's `BondingCurve` (a websocket subscription, plus a poll
  every `SENTINEL_CURVE_POLL_SECONDS`) and posts when the curve passes 25%, 50% and 75%, and when it graduates to
  Raydium (`migrated`). Progress is SOL raised over the curve's graduation raise, the figure the app shows. A big
  buy that passes several milestones at once posts only the highest. Milestones the curve had already passed when
  watching began are not backfilled, and one that passes while switched off is never posted later.
- **Cashtag replies.** Every `SENTINEL_MENTION_POLL_SECONDS` it reads the account's mentions and replies to posts
  that mention the account and include `$TICKER`, once per author a day and at most 10 replies an hour. It never
  replies to posts that only use the cashtag: X's automation rules forbid automated replies found by keyword search.
- **Personas.** Wall St. Bull, Satirical Wojak or Institutional Macro. The text comes from templates filled with
  elizaOS's `composeContext` (`src/persona.ts`); the first line of the creator's project context is quoted as the
  latest news. No language model is called, so running it costs nothing.
- **Settings, any time after launch.** The coin's creator saves them from the app's X automation modal.
  - Every write is signed by the creator's wallet (`app/src/lib/sentinelMessage.ts`, shared by both sides): the
    action, the mint, a timestamp and a SHA-256 of the payload.
  - The service checks the signer against the curve's on-chain `creator` and refuses stale timestamps and replays.
    The last request time is kept even after a disconnect, so an old request can't bring a coin back.
  - New settings apply from the next curve update or mention poll, with no restart.
- **Disconnect.** A signed `DELETE` stops watching the coin (its curve listener is removed and polling skips it)
  and deletes its settings and X session.

## Signing in to X without API keys

`CookieX` (`src/x.ts`) uses the web session cookies of a signed-in browser (`auth_token` and `ct0`, optionally
`guest_id`) through `agent-twitter-client`, the same way elizaOS's `client-twitter` signs in. There are no X API
keys or fees. A coin's account comes from one of two places, the creator's first:

1. **Linked by the creator** in the app's modal: the handle and the two cookies, sent once with a signed save.
   - In live mode the sentinel signs in with them first and keeps X's own spelling of the handle. A session X
     rejects is refused, and the working one stays.
   - The session is sealed with AES-256-GCM under a key from `SENTINEL_SECRET`, bound to its mint, and stored in
     `data/sentinel.json` (written with mode 600).
   - It is never returned by the API. Replacing it swaps the coin's X client in place; disconnecting deletes it.
   - Without `SENTINEL_SECRET`, the service refuses creator sessions.
2. **Set up by the operator** in `accounts.json` (git-ignored), keyed by mint:

```json
{
  "<mint>": { "username": "ProjectAccount", "authToken": "…", "ct0": "…", "guestId": "…" }
}
```

Copy the cookies from the browser's developer tools while signed in to that account.

Things to know before running it live:
- Cookie sessions aren't X's official API. X can rate-limit, challenge or lock an account it sees automating
  through the web client, so use a dedicated project account.
- The cookies give full access to the account. Keep `SENTINEL_SECRET` and `accounts.json` private and serve the API
  over HTTPS only, since creators send their cookies to it. Signing out of X in that browser revokes the cookies.
- `agent-twitter-client` 0.0.18 (the version `@elizaos/client-twitter` 0.25 uses) is marked unsupported on npm, and
  X changes its web endpoints without notice. If sign-in or posting starts failing, the error names the step.
- `@elizaos/client-twitter` itself isn't a dependency: its only export starts elizaOS's own model-driven posting and
  reply loops, which would need a paid model key and reply to every mention. The sentinel uses the same sign-in
  and scraper underneath, with its own milestone and cashtag rules.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SENTINEL_DRY_RUN` | on | Set to `0` to post for real; otherwise posts are logged |
| `SENTINEL_PORT` | `8787` | HTTP port |
| `SENTINEL_RPC_URL` | devnet | Solana RPC for the Parabull program (the IDL's address) |
| `SENTINEL_ACCOUNTS` | `./accounts.json` | X accounts by mint (see above) |
| `SENTINEL_SECRET` | unset | At least 32 characters. Seals the X sessions creators link; unset, creators can't link one |
| `SENTINEL_DATA_DIR` | `./data` | Where settings and progress are kept |
| `SENTINEL_SITE_URL` | unset | Base URL for coin links in posts, e.g. `https://parabull.app` |
| `SENTINEL_ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated origins allowed to call the API (CORS) |
| `SENTINEL_CURVE_POLL_SECONDS` | `60` | Curve poll interval, on top of the websocket |
| `SENTINEL_MENTION_POLL_SECONDS` | `180` | Mention poll interval |

In the app, set `VITE_SENTINEL_URL` to the service's address. Without it, the modal says the sentinel isn't
connected and its controls stay off.

## API

| Route | |
| --- | --- |
| `GET /health` | `{ ok: true }` |
| `GET /api/sentinel/:mint/settings` | Mode (`live` / `dry-run`), whether the coin is watched, its X handle and where it came from, and the saved settings. Never session cookies |
| `PUT /api/sentinel/:mint/settings` | `{ settings, session?, issuedAt, signer, signature }`, signed by the coin's creator. `session` (`{ username, authToken, ct0 }`) links or replaces the X account; omit it to keep the current one |
| `DELETE /api/sentinel/:mint/settings` | `{ issuedAt, signer, signature }`, signed by the creator: stop watching and forget the session |

The `GET` is public: what it returns is already public (the persona's posts and the handle). Every change needs the
creator's signature: an unsigned request gets 400, a stale or tampered one 401, another wallet 403, a replay 409.
The signature, timestamp and replay checks run before any RPC call, so junk requests never reach the chain; only a
validly signed request reads the curve, to compare its signer with the on-chain creator.

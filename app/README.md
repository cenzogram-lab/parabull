# Parabull web app

The web app for Parabull, built with React 19, Vite 7, TypeScript,
Tailwind 3, `@solana/wallet-adapter` and `lightweight-charts`. It's styled
with the bronze/copper system in [`docs/DESIGN.md`](../docs/DESIGN.md).
It's desktop-first, with its own phone layout below 768px (see
[Mobile](#mobile)).

```bash
cd app
npm ci
npm run dev          # http://localhost:5173
```

## Pages

| Route | View |
| --- | --- |
| `/`, `/board` | Board: King of the Bull hero, then either **Terminal Pro** (Pro Screener with New / Soon / Graduated / Movers, Trending, Hot callouts, Leaderboard) or **Classic** (For you / Following feed plus Movers / Trending cards) |
| `/explore` | Explore table (sparkline, MCAP, ATH, AGE, TRADES, 24H VOL, TRADERS, 1H / 6H / 24H, sortable) or grid. Range filters and a "Verified locks only" toggle |
| `/create` | Launch flow: a modal over the current page, or a full page when opened directly. Live name-lock key, ticker and tweet parsing, lock pre-check, itemized 0.230 SOL ticket, live preview, and the 3–15 s anti-bundle delay |
| `/coin/:mint` | Trading terminal: lock countdowns, metrics, candles (`1s`–`D`, Price/MCap), bonding-curve and DexScreener gauges, Holders / Trades / Callouts tabs, Buy/Sell panel, stats and audit |
| `/leaderboard` | Traders / Squads / Rewards / Best Callouts, top-4 podium, 1D/1W/1M, Profit/Volume, Best callouts rail |
| `/portfolio` | Your profile, net equity with a 1D / 1W / 1M / ALL curve, then Open / Closed / Replies / Rewards and Deposit / Receive. On desktop it's a centered column |
| `/search` | Recent searches and recently viewed coins at rest, coin and creator results as you type. On desktop it's a centered column; ⌘K still opens the overlay there |
| `/live` | Spotlight stream with chat, then Most viewers / Highest market cap / Trending clips |
| `/holder-rewards` | Holder-reward totals, top paying coins, how the fee split works |
| `/parabull-token` (`/rewards`) | Buyback & burn tracker, daily ledger, earnings-to-valuation calculator, Merkle claims |
| `/admin` | Operator console for the admin, crank and nominated-admin wallets (chain mode). See [Admin console](#admin-console) |

## Mobile

Below Tailwind's `md` breakpoint (768px) the app switches to a phone layout;
from 768px up it is the desktop layout above, unchanged. Pages switch whole
trees with `useIsMobile()` (`src/hooks/useMediaQuery.ts`, read on the first
render, so there's no flash), and shared components change only through
`max-md:` classes. The mobile components live in `src/components/mobile/`
(Portfolio's in `src/components/portfolio/`).

- **Frame.** The desktop dock, header, info strip and footer are hidden.
  Instead there's a sticky header (your avatar, equity and 24h PnL, which
  open the portfolio; Deposit; notifications) and a floating nav with five
  destinations: **Board** `/`, **Explore** `/explore`, **Leaderboard**
  `/leaderboard`, **Portfolio** `/portfolio` and **Search** `/search`.
  Every page but search ends with a one-line demo-data note.
- **Launching.** A gold **+** button above the nav on the board and the
  screener opens the launch modal (`/create`), full screen on a phone.
  Opening `/create` directly gives the full page.
- **Board and Explore.** A sticky Movers / New / Soon / Graduated tab row
  (Movers / New / Graduated plus a sort sheet on Explore), quick filters in a
  sheet, a detailed/compact row toggle (saved as `parabull:mobileRows`), and
  one card per coin with volume (V), market cap (MC), SOL raised toward the
  85 SOL graduation (F) with a mini bar, trades (TX) and the launch-lock
  badges. While you touch or scroll, rows keep their order (a coin that
  stops qualifying keeps its place too); the live demo's re-ranking lands
  once the list is still.
- **Leaderboard.** Traders / Squads / Rewards, an info card that opens the
  best callouts, the top-4 podium, 1D / 1W / 1M with a Profit / Volume sort,
  your pinned rank (it links to the portfolio) and the ranking with Follow
  buttons. A row opens that trader's or squad's card; when your figure makes
  the listed ranking, your own row sits in it at that place.
- **Coin page.** A compact header, the chart, gauges and stats, then Trades /
  Holders / Callouts as lists, and a Buy / Sell bar that opens the trade
  panel in a sheet.
- **Search.** The field is pinned above the nav, or above the on-screen
  keyboard, with Paste and close buttons. ⌘K (and anything else that opens
  search) goes to `/search` on a phone. Coins you pick are saved as
  `parabull:searchHistory` (12 at most), next to the recently viewed list
  (`parabull:recent`).
- **Sheets.** Pickers, filters, the trade panel and detail cards open in
  `BottomSheet` (`src/components/mobile/MobileUi.tsx`, with the tab rows,
  44px icon buttons, Follow toggle and section headers). Toasts show under
  the header, above any sheet.
- **Navigation.** On a phone a page you open starts at the top, and links
  to `/parabull-token#claim` land on the claim panel; desktop keeps the
  router's scroll behavior, as before. Back and Forward keep their scroll
  position, and the launch modal leaves the page under it alone. The tabs,
  filters and sort you pick on Board and Explore, the leaderboard's board,
  period and sort, and the portfolio's tab are kept for the visit, so Back
  from a coin, your portfolio or the $PARABULL page finds the list you left.
- **Landscape.** On a phone in landscape under 480px tall the tab rows and
  the Deposit / Receive strip stay in the page instead of pinning; the Buy /
  Sell bar stays docked, since it's the coin page's only way to trade, and
  the chart shrinks to fit between it and the header. A notched phone in
  landscape gets the desktop layout, padded clear of the notch.

**Demo data on the phone screens:** the portfolio's cash starts at 1.84 SOL
and follows your demo trades (they aren't capped at it, so a bigger buy
takes it below zero); the six holdings, their cost, the trade notes, closed
positions (what you sell this visit is added on top), replies, equity curve
and leaderboard ranks are seeded. The desktop info strip's Open positions
keep their original flat cost (+61.3% each), so their PnL differs from the
portfolio's. The 24h change compares today with what you held a day ago: a
holding in a coin launched within the last day counts from what you paid,
and a demo buy only counts for how its price has moved since. On the
leaderboard your Rewards figure is what your reward epochs paid in the
period, and a figure that would make the listed ranking puts your row in
it at that place. Follows (the eight top traders to start) and each
wallet's claimed reward epochs are shared by every view that shows them,
for the visit only.

Check a change with `npm run build`, then `npm run audit:mobile` (no
sideways scrolling, every touch target at least 44x44px, no console errors,
on 11 routes at 390x844) and `npm run screenshots -- <dir> --mobile` (15
captures at 390x844). The desktop captures (`npm run screenshots -- <dir>`)
are the check that a mobile change left the desktop layout alone: compare
them with a capture from before the change.

## Modes

Set these in `app/.env.local` (see `src/config.ts`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_PARABULL_MODE` | `demo` | `demo`: seeded data, and trades, launches and claims are simulated locally. `chain`: those three are sent to the program |
| `VITE_CLUSTER` | `devnet` | `devnet`, `mainnet-beta` or `localnet` (explorer links, default RPC) |
| `VITE_RPC_URL` | the cluster's public RPC | Your RPC endpoint |
| `VITE_METADATA_UPLOAD_URL` | unset | Backend that pins the image and metadata JSON and returns `{ uri }`. Without it, chain mode asks for a metadata URI |
| `VITE_REWARDS_BASE_URL` | unset | Where `epoch-<n>.json` snapshot artifacts (from `scripts/src/snapshot.ts`) are served |
| `VITE_SENTINEL_URL` | unset | The X sentinel ([`services/twitter-sentinel`](../services/twitter-sentinel/README.md)). When the connected wallet launched the coin, its page shows an **X automation** button with a status dot. It opens a modal (a bottom sheet on a phone) to link, replace or disconnect the project's X account and set milestone posts, cashtag replies, persona and project context, any time after launch. Every change is signed by the wallet. Unset, the modal says the sentinel isn't connected; demo coins can't be saved, since they aren't on-chain |
| `VITE_II_SIGNER_CANISTER_ID` | unset | The Chain Fusion signer canister for Internet Identity users ([`src/lib/auth/solana_signer.did`](src/lib/auth/solana_signer.did)). Unset, "Continue with Google / Passkey / Email" uses a development key in demo builds and on the dev server, a local test identity on localnet, and is disabled in a production chain build (see [Connecting](#connecting)) |

**Wired to the program** (`src/hooks/useParabullProgram.ts`):
- `request_launch`, then waiting for the launch worker (the ticket closes,
  then the ticker registry tells which mint was created);
- `buy` / `sell`, with `max_sol_cost` / `min_sol_output` from the chosen
  slippage;
- `claim_holder_reward`, after verifying the proof in the browser against
  the published root;
- reads of the ticker, name and tweet registries (lock pre-check);
- the admin console at `/admin`: `set_paused`, `update_global_params` and
  `propose_admin` / `accept_admin` (see [Admin console](#admin-console)).

**Protocol parameters and SOL/USD** (`src/state/Protocol.tsx`): in chain
mode the app reads `Global` once on load, and again after an admin change.
The platform fee, fee split, listing target, ticket price, lock window,
trading delay and claim window shown on the trade panel, launch flow,
Holder rewards and $PARABULL pages come from it. Trade quotes use its fee.
SOL/USD comes from Jupiter's price API, with CoinGecko as a fallback,
polled every minute; until one answers, the demo price ($162.40) is used
and the console labels it as a fallback. Demo mode keeps the program
defaults and the fixed demo price that the seeded data is built on.

**Still demo data in both modes:** coin lists, candles, trades, holders,
leaderboards, streams, protocol totals and the portfolio (balance,
positions, PnL, closed positions and reward epochs, even for a connected
wallet). These need the indexer API in
[`docs/BACKEND_SPEC.md`](../docs/BACKEND_SPEC.md); the UI labels them
(header pill and footer; on a phone, the footnote, a Demo tag by the
header's balance and the portfolio's Demo chip; in both layouts, a Demo tag
by the Rewards tab's unclaimed figure).

## Admin console

`/admin` (`src/pages/AdminConsole.tsx`, loaded only when visited) is the
operator view.

**Who sees it.** It opens for the wallets that `Global` names: the admin,
the crank authority, and a nominated admin, who needs it to accept. Anyone
else, or a visitor with no wallet connected, gets the locked "Access
Restricted: Connect Admin Wallet" screen. Demo builds are always locked,
because there's no `Global` to read. Switching wallets updates the page
without a reload. Role holders also get an **Admin console** link in the
dock. This gate only decides what the page shows: the program checks every
signer, and everything on the page is public on-chain data.

**What it shows (plain RPC reads, no backend):**
- **Launchpad:** total launches (`Global.launch_count`), tickets waiting,
  and coins on the curve, graduating or graduated, from every
  `BondingCurve`.
- **Liquidity and vaults:**
  - SOL held for curves and the treasury balance.
  - The buyback vault: spendable SOL, plus its lifetime spend, $PARABULL
    burned and buyback count.
  - The holder-reward vault: spendable SOL, what open epochs still owe,
    and lifetime claims and epochs.
- **Unswept fees:** totals for the listing escrow, buyback, holder and
  treasury shares across all curves.
- **Configuration:** the program's authorities and the parameters fixed at
  `initialize`.

It refreshes every minute and after every change.

**Controls, signed by the admin wallet** (the crank sees them read-only):
- **Emergency pause:** `set_paused`. Pausing asks you to type PAUSE first.
- **Fees and parameters:** `update_global_params`.
  - The buyback and holder shares (the treasury gets the rest), the
    DexScreener target (with a "Set to $299" button that uses the live
    price), the trading-open delay, the migration reserve and the reward
    claim window.
  - Changes are checked against the program's rules before signing, shown
    as old → new, and only the changed fields are sent.
  - The console won't set the trading delay to 0 slots, which would allow
    buying in the creation slot.
  - The 1% platform fee is shown read-only: `GlobalUpdate` has no field
    for it, so it can only be set at `initialize`.
- **Admin transfer:** `propose_admin` (or withdraw the nomination), then
  `accept_admin` from the nominated wallet.

**Logic:**
- Validation and KPI maths: `src/lib/admin.ts`.
- Roles and the parameters shared by every page: `src/lib/protocolParams.ts`.
- Tests: `test/admin.test.ts`.
- Some RPC providers turn off `getProgramAccounts`. The console says so when
  its reads fail.

## Where the logic comes from

- **Curve math:** `src/lib/curve.ts` re-exports `scripts/src/curve.ts`, the
  bigint port of `math.rs` pinned against the Rust tests.
  `src/lib/quote.ts` turns a SOL budget into the exact-token buy the
  program takes.
- **Launch rules:** `src/lib/launchRules.ts` mirrors the name-lock key, the
  ticker rules and the tweet-ID hash. The tests pin the same vectors as
  `state.rs`, `launch.rs` and `scripts/`.
- **Merkle proofs:** `src/lib/merkle.ts` uses the `merkle.rs` leaf and node
  format, and the test pins its root.
- **Demo data:** curve coins sit on the real default curve, so price,
  market cap and progress come from the program's math. Each demo reward
  epoch is a real Merkle tree, so its proofs verify.
- **IDL:**
  - `src/idl/` is a committed copy of `target/idl` and `target/types`.
  - After changing the program, run `anchor idl build -p parabull -o
    target/idl/parabull.json -t target/types/parabull.ts` from the repo
    root, then `npm run sync-idl` here.
  - CI fails if the copy drifts (`npm run check-idl`).

## Hosting on the Internet Computer

The built app can be served from a **certified-assets canister** on the Internet Computer, configured in the
repository's [`icp.yaml`](../icp.yaml) with the `@dfinity/static-site` recipe (ICP skills: `static-site`, `icp-cli`).
The IC only hosts the frontend: the program, launches and trades stay on Solana, and the browser talks to Solana RPC
directly, as it does from any other host.

```bash
npm install -g @icp-sdk/icp-cli @icp-sdk/ic-wasm   # icp-cli >= 1.0.0, Node.js >= 22
```

```bash
icp network start -d && icp deploy                  # local: http://frontend.local.localhost:8000
```

```bash
icp deploy -e ic frontend                           # mainnet (needs cycles): https://<canister-id>.icp.net
```

**Build settings.** Put the build's settings in `app/.env.production.local` (git-ignored); `npm run build` reads them.
A chain deployment usually sets `VITE_PARABULL_MODE=chain`, `VITE_CLUSTER` and an origin-restricted `VITE_RPC_URL`.

**Routing and headers.** The canister reads two files from the root of `dist/`. It ignores `.ic-assets.json5` and adds
no security headers of its own.
- `public/_redirects`
  - Every client route (`/coin/:mint`, `/admin`, `/create`, ...) is served `index.html` with a `200` rewrite, so deep
    links and reloads work.
  - A missing file under `/assets/` returns a real `404` (`public/404.html`) instead of the app shell.
- `dist/_headers`
  - Written at build time by `vite.config.ts` from `src/lib/icHeaders.ts`.
  - `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, long-lived caching for `/assets/*`, and
    revalidation for HTML.
  - A **Content-Security-Policy** (`script-src 'self'`, no `eval`, `frame-ancestors 'none'`). Its `connect-src`
    allows:
    - the build's own RPC (plus the websocket web3.js derives from it: `wss://`, or port + 1);
    - `api.devnet` / `api.mainnet-beta.solana.com`, Helius and QuickNode (HTTPS and WSS);
    - the sentinel, metadata-upload and rewards URLs when they are set;
    - the Jupiter and CoinGecko price APIs;
    - Solflare and the Mobile Wallet Adapter's local socket.
  - The policy only lists origins, so an RPC URL's path or query string (an API key) never ends up in the header.
- `vite.config.ts` also drops the wallet modal's Google Fonts `@import`. Every wallet element is restyled in the
  bundled Inter, so DM Sans was never shown, and the CSP can keep `style-src 'self'`.
- To use another RPC provider, add its origin in `src/lib/icHeaders.ts` and rebuild.

Link to `https://<canister-id>.icp.net` (or a custom domain), never `raw.icp.net`: the raw gateway skips the
certificate check.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck (app + tests) and production build into `dist/` |
| `npm test` | Unit tests: SHA-256, launch rules, quotes, Merkle proofs, formatting, demo-data invariants |
| `npm run screenshots -- <dir> [--mobile]` | Serves `dist/` and captures every page with Playwright (`?live=0` freezes the demo simulation); `--mobile` captures the phone layout at 390x844 |
| `npm run audit:mobile` | After a build: checks 11 routes at 390x844 for sideways scrolling, touch targets under 44x44px and console errors |
| `npm run sync-idl` / `check-idl` | Copy or verify the IDL from `../target` |

## Connecting

The connect dialog (`src/components/ConnectModal.tsx`) replaces the wallet adapter's modal and offers two paths. Every
`useWalletModal().setVisible(true)` call and the header's wallet button open it, and it is a bottom sheet on a phone.

**Path A: "Continue with Google / Passkey / Email" (Internet Identity).**
- **Sign-in.** Uses `@icp-sdk/auth` 11 with `@icp-sdk/core` 6, per the ICP `internet-identity` skill.
  - `signIn()` opens `https://id.ai` straight from the click; the SDK loads when the dialog opens, so the popup isn't
    blocked.
  - A session is restored after a reload with no popup.
- **Solana account.** The address is a threshold Ed25519 key that the **signer canister** derives from the user's
  principal (`sign_with_schnorr`). Each signature is an update call to that canister.
- **Client (`src/lib/auth/chainFusionSigner.ts`).** For each transaction it:
  - sends the canister the transaction message together with the address it expects to sign as;
  - checks the 64-byte signature against that address;
  - attaches the signature to the transaction.
- **The canister's contract is in `src/lib/auth/solana_signer.did`.** The frontend cannot enforce it:
  - derive the key from `msg.caller` only, never from an argument;
  - refuse the anonymous principal;
  - trap if the expected address doesn't match the caller's key;
  - bound the message size and rate-limit or charge callers, since every signature costs cycles.
- **Without a signer canister** (`VITE_II_SIGNER_CANISTER_ID` unset):
  - demo builds and the dev server sign with a development key derived from the principal, and the dialog says so;
  - localnet builds skip II and use a random per-tab test principal;
  - a production chain build shows the option disabled.
  - Anyone who knows a principal can rebuild its development key, so never fund one.

**Path B: native Solana.**
- **Browser wallets.** Detected Wallet Standard wallets (Phantom, Solflare, Backpack) are listed, plus Solflare's web
  wallet.
- **"Import Private Key (Disposable / Fast Execution)".**
  - Accepts a base58 private key or a `solana-keygen` JSON array, checked with `Keypair.fromSecretKey`.
  - The key is held only in this tab's memory: it is never written to localStorage or sessionStorage, and reloading or
    closing the tab forgets it.
  - It signs every transaction with no popup. Anything running in the page could use it too, so it is for small,
    disposable balances only, and the dialog says so.

**One signing interface.** All three are wallet adapters under `WalletProvider` (`src/wallet/adapters.ts`).
`useUnifiedWallet()` (`src/wallet/UnifiedWallet.tsx`) gives:
- `publicKey`;
- `signTransaction` and `signAllTransactions`;
- `signMessage`;
- `walletType` (`native`, `imported` or `internet_identity`);
- `disconnect`.

`useParabullProgram` signs through it, so trading, launching, claims, the admin console and the X automation modal work
the same whichever way the user connected.

**CSP.** The `_headers` CSP (`src/lib/icHeaders.ts`) allows `id.ai`, `identity.ic0.app` and the IC API hosts
(`icp-api.io`, `icp0.io`, `ic0.app`). It sets no `Cross-Origin-Opener-Policy`, which would cut the II popup off from
the page.

## Wallets

Phantom, Solflare, Backpack and other Wallet Standard wallets register
themselves. `@solana/wallet-adapter-solflare` adds Solflare's web and
mobile fallback.

`@solana/wallet-adapter-wallets` is deliberately not used:
- it pulls in 1,172 packages (1.3 GB), including Torus and WalletConnect;
- it leaves Node-builtin warnings in the Vite build;
- it adds nothing for wallets that support Wallet Standard.

Add a specific legacy adapter package if you need one (for example Ledger
without a wallet app).

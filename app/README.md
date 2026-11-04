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
on 10 routes at 390x844) and `npm run screenshots -- <dir> --mobile` (15
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

**Wired to the program** (`src/hooks/useParabullProgram.ts`):
- `request_launch`, then waiting for the launch worker (the ticket closes,
  then the ticker registry tells which mint was created);
- `buy` / `sell`, with `max_sol_cost` / `min_sol_output` from the chosen
  slippage;
- `claim_holder_reward`, after verifying the proof in the browser against
  the published root;
- reads of `Global` (ticket price) and of the ticker, name and tweet
  registries (lock pre-check).

**Still demo data in both modes:** coin lists, candles, trades, holders,
leaderboards, streams, protocol totals and the portfolio (balance,
positions, PnL, closed positions and reward epochs, even for a connected
wallet). These need the indexer API in
[`docs/BACKEND_SPEC.md`](../docs/BACKEND_SPEC.md); the UI labels them
(header pill and footer; on a phone, the footnote, a Demo tag by the
header's balance and the portfolio's Demo chip; in both layouts, a Demo tag
by the Rewards tab's unclaimed figure).

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

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck (app + tests) and production build into `dist/` |
| `npm test` | Unit tests: SHA-256, launch rules, quotes, Merkle proofs, formatting, demo-data invariants |
| `npm run screenshots -- <dir> [--mobile]` | Serves `dist/` and captures every page with Playwright (`?live=0` freezes the demo simulation); `--mobile` captures the phone layout at 390x844 |
| `npm run audit:mobile` | After a build: checks 10 routes at 390x844 for sideways scrolling, touch targets under 44x44px and console errors |
| `npm run sync-idl` / `check-idl` | Copy or verify the IDL from `../target` |

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

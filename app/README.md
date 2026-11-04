# Parabull web app

The desktop web app for Parabull, built with React 19, Vite 7, TypeScript,
Tailwind 3, `@solana/wallet-adapter` and `lightweight-charts`. It's styled
with the bronze/copper system in [`docs/DESIGN.md`](../docs/DESIGN.md).

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
| `/live` | Spotlight stream with chat, then Most viewers / Highest market cap / Trending clips |
| `/holder-rewards` | Holder-reward totals, top paying coins, how the fee split works |
| `/parabull-token` (`/rewards`) | Buyback & burn tracker, daily ledger, earnings-to-valuation calculator, Merkle claims |

## Modes

Set these in `app/.env.local` (see `src/config.ts`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_PARABULL_MODE` | `demo` | `demo`: seeded data, and trades, launches and claims are simulated locally. `chain`: those three are sent to the program |
| `VITE_CLUSTER` | `devnet` | `devnet`, `mainnet-beta` or `localnet` (explorer links, default RPC) |
| `VITE_RPC_URL` | the cluster's public RPC | Your RPC endpoint |
| `VITE_METADATA_UPLOAD_URL` | unset | Backend that pins the image and metadata JSON and returns `{ uri }`. Without it, chain mode asks for a metadata URI |
| `VITE_REWARDS_BASE_URL` | unset | Where `epoch-<n>.json` snapshot artifacts (from `scripts/src/snapshot.ts`) are served |

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
leaderboards, streams and protocol totals. These need the indexer API in
[`docs/BACKEND_SPEC.md`](../docs/BACKEND_SPEC.md); the UI labels them
(header pill and footer).

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
| `npm run screenshots -- <dir>` | Serves `dist/` and captures every page with Playwright (`?live=0` freezes the demo simulation) |
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

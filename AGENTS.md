# Parabull: agent guidance

Parabull is a Solana meme-token launchpad built with Anchor. **This project is
under active development.** The pump.fun sources in `reference/` are for
reading only.

## Product rules (locked decisions)

- **Blind launches.** A user pays a flat 0.23 SOL all-in into a `LaunchTicket`
  PDA (0.2 SOL protocol fee plus a 0.03 SOL operational allocation; the
  ticket's own rent comes out of the 0.23, so the ticket holds exactly
  `deposit_lamports`). The backend creates the coin, co-signing
  as `Global.launch_authority`, and generates the mint keypair server-side.
  Nobody can trade before `trading_open_slot` (creation slot plus a delay).
  The creator's first buy is an ordinary buy after the market opens. A ticket
  that isn't used before it expires can be refunded to the payer.
- **Launch flow rules.** `request_launch` records the launch fee in effect at
  request time and a hash of the exact name, symbol and URI. `symbol` must
  already be the canonical ticker. `create` must run before the ticket
  expires and must match that hash. From the ticket's lamports, `create`
  repays the launch authority exactly the rent it fronted (mint, curve, curve
  ATA, and only the registries it newly created), capped at the 0.03 SOL
  allocation. A registry's repayment is capped at its rent-exempt minimum,
  because registry PDAs can be pre-funded by anyone; the ticket then closes to the **treasury**, which receives the
  fee plus whatever of the allocation is unspent (`TokenCreated.rent_reimbursed`
  / `treasury_received`). The payer gets nothing back from a successful launch. After `create` the mint has a
  fixed supply, no mint or freeze authority, and metadata nobody can change.
  `refund_ticket` always sends funds to the payer. The payer can call it
  after expiry; the launch authority can call it at any time (to reject a
  launch). Refunds still work while the program is paused.
- **Trading.** `buy(amount, max_sol_cost)` buys an exact number of tokens;
  if fewer remain, it fills only what's left, and that final buy completes the
  curve. `max_sol_cost` includes the fee. `sell(amount, min_sol_output)`:
  `min_sol_output` is after the fee. Trades are rejected while paused, before
  `trading_open_slot` (`TradingNotOpenYet`) and once the curve is complete
  (`CurveComplete`). The whole buy payment (cost plus fee) goes into the curve
  account; a sell pays out only the net amount, so the fee never leaves the
  curve. Every trade checks that
  `curve lamports >= rent + real_sol_reserves + all fee buckets`.
- **Anti-vamp registry.** `["registry", TICKER]` and `["name", sha256(name)]`
  PDAs lock a ticker or name for 3 days (`Global.registry_lock_seconds`).
  Tickers are 1-10 ASCII letters or digits, stored uppercase. Names are
  normalised by keeping only ASCII letters and digits, lowercased, so
  `Pepe Coin`, `PepeCoin` and `P.E.P.E-coin` share one lock; a name with no
  ASCII alphanumerics (e.g. emoji only) hashes its trimmed raw bytes instead.
  `state.rs` and `scripts/src/launch.ts` pin the same test vectors. Lookalike
  detection happens in the off-chain indexer, not on-chain.
- **Announcement-tweet lock.**
  - `request_launch(..., tweet_id: Option<u64>)` takes the tweet's numeric
    status ID. The program stores
    `tweet_id_hash = sha256("parabull:tweet" || id u64 LE)` on the ticket.
    Hashing the numeric ID on-chain means every URL form of one tweet maps
    to the same lock.
  - `create` claims `["tweet", tweet_id_hash]` (`TweetRegistry`) for the same
    3 days. The optional `tweet_registry` account must be passed exactly
    when the ticket has a tweet (`TweetRegistryMismatch` otherwise).
  - Checking that the creator actually authored the tweet is off-chain
    (`docs/BACKEND_SPEC.md` §1.2).
- **Off-chain parity** (random 3–15 s create delay, 20-slot bundle check,
  image and lookalike flags): specified in `docs/BACKEND_SPEC.md`. The launch
  worker (§1) is implemented in `scripts/launch_worker.ts`. Its ticket
  handling is in `scripts/src/launchWorkerRunner.ts`, and its pure logic in
  `scripts/src/launchWorker.ts`.
- **Devnet test curve.** `deploy_and_init.ts` accepts `CURVE_PRESET=small`
  (graduates at `CURVE_TARGET_SOL`, default 2 SOL) or all four explicit
  `INITIAL_*` / `TOKEN_TOTAL_SUPPLY` overrides; `scripts/src/curveParams.ts`
  solves the supply so the pool opens at the curve's final price. The small
  preset is refused on mainnet-beta.
- **Fees.** The platform fee is 1% (hard-capped by `MAX_PLATFORM_FEE_BPS`).
  Creators get 0%. Each trade's fee is split into counters on the token's own
  `BondingCurve`, never written to a shared vault in the trade path:
  1. DexScreener escrow, until `Global.dex_target_lamports` is reached. The
     admin updates this target from the SOL/USD price; no oracle is called
     during trades.
  2. Buyback and burn of $PARABULL (`buyback_bps`).
  3. $PARABULL holder rewards (`holder_bps`), paid out per epoch from a
     Merkle root (`RewardEpoch`).
  Whatever is left over goes to the treasury.
  **The escrow stays open after graduation.** Graduation never touches or
  redirects `escrow_accrued`. Anyone can add to it with
  `top_up_dex_escrow` (for example from collected Raydium LP fees), capped at
  the target. Once it's funded, `release_dex_escrow` (permissionless) pays
  `dex_target_lamports` to `Global.treasury` exactly once. If the target was
  lowered after fees came in, the excess goes to the buyback bucket.
  `sweep_fees` (permissionless) moves the buyback, holder and treasury
  buckets to `BuybackVault`, `HolderRewardVault` and the treasury. It never
  sweeps the escrow.
- **Who can call what (locked decision).**
  - **Anyone:** `sweep_fees`, `release_dex_escrow` and `top_up_dex_escrow`.
    Their destinations are PDAs or `Global.treasury`, so no caller can
    redirect funds.
  - **Crank only:** graduation and `collect_lp_fees`.
  - **Admin only:** `update_global_params` and `propose_admin`. The new admin
    must call `accept_admin` themselves (two-step transfer; proposing
    `Pubkey::default()` cancels).
- **Emergency pause (locked decision).** `set_paused(bool)` (admin only).
  - **Blocked while paused:** `request_launch`, `create`, `buy`/`sell`,
    `prepare_buyback`/`buyback_and_burn` and `publish_reward_epoch`.
  - **Still allowed:** ticket refunds, `sweep_fees`, escrow top-up and
    release, graduation, `collect_lp_fees` and `claim_holder_reward`. Users'
    funds are never trapped.
  - There is no "emergency withdraw" instruction. Funds only ever move to
    fixed destinations.
- **$PARABULL buyback & burn.** Two crank-only instructions, sent in one
  transaction:
  1. `prepare_buyback(amount)` moves SOL out of `BuybackVault` (a direct
     lamport move with no CPI; the vault must stay rent-exempt) into the
     system-owned `["buyback-authority"]` PDA.
  2. `buyback_and_burn(min_amount_out)` is CPIs only: wrap the SOL, swap on
     the CPMM pool in `Global.parabull_pool` (`swap_base_input`, with
     `min_amount_out > 0` required and re-checked against the measured
     amount received), burn everything received, then close the temporary
     accounts (rent back to the crank).

  `Global.parabull_mint` and `Global.parabull_pool` are set through
  `update_global_params`. The $PARABULL mint may use either token program.
- **Holder rewards.** These are Merkle epochs with a claimed-bitmap, not
  per-claim receipt accounts, so rent stays at about 0.09 SOL per 80k
  holders instead of about 0.001 SOL per claim.
  - `publish_reward_epoch(root, total, num_leaves, snapshot_slot)` (crank
    only) commits part of `HolderRewardVault`. It's only allowed if the
    vault covers rent, every outstanding (published but unclaimed) reward,
    and the new total.
  - `claim_holder_reward(epoch, index, amount, proof)` can be called by
    anyone. It pays one leaf, once, to the system-owned wallet named in the
    leaf, and the vault stays rent-exempt.
  - The crank pushes payouts by putting many claims in one transaction;
    holders can also pull their own.
  - At most `MAX_REWARD_LEAVES` (80,000) leaves per epoch. Use more epochs
    for larger snapshots.
  - **Expiry:** each epoch's `expires_at` is set at publish from
    `Global.reward_claim_window_seconds` (default 30 days, minimum 7, admin
    can change it). `expire_reward_epoch(epoch_index)` (crank or admin) is
    allowed strictly after `expires_at` and only once. After that, no claims
    are accepted for the epoch, and its unclaimed amount is added to
    `HolderRewardVault.total_expired_lamports` (outstanding = committed −
    claimed − expired), so it can fund later epochs. No lamports move. Claims
    made after the deadline still pay out until someone actually expires the
    epoch.
  - **Leaf/tree format (the backend must match it exactly):** leaf =
    `sha256(0x00 || index u32 LE || claimant 32B || amount u64 LE)`; node =
    `sha256(0x01 || min(a,b) || max(a,b))`; on a level with an odd number of
    nodes, the last node is carried up unchanged. `src/merkle.rs`
    `MerkleTree` is the reference builder.
  - The snapshot must list only system-owned wallets. Exclude pool vaults,
    program-owned accounts and burn addresses.
- **Admin parameters.** `update_global_params` takes a `GlobalUpdate` where
  every field is optional (`None` = unchanged): `dex_target_lamports`,
  `buyback_bps`, `holder_bps`, `migration_reserve_lamports`,
  `trading_open_delay_slots`, `cpmm_program`, `cpmm_amm_config`,
  `lp_lock_program`, `lp_lock_authority`, `parabull_mint`, `parabull_pool`.
  The merged result is validated
  with the same rules as `initialize` and either applies in full or not at
  all. `dex_target_updated_at` changes only when the target does.
- **Post-graduation LP fees.** `collect_lp_fees(fee_lp_amount)` (crank only)
  has the `["fee-key-vault"]` PDA sign Burn & Earn `collect_cp_fees`. The
  `fee_lp_amount` is supplied by the caller, from Raydium's API, but is never
  trusted for accounting. Only the measured balance increases are routed:
  - **SOL side:** unwrapped; fills the token's escrow first (if it's still
    open), then goes straight to `BuybackVault` / `HolderRewardVault` by the
    global split, with the remainder to the treasury.
  - **Launched-token side:** burned immediately (Token-2022 burn signed by
    the fee-key vault), and the temporary token account is closed. The
    protocol never holds launched tokens (locked decision).

  Both temporary accounts' rent goes back to the crank.
  Post-graduation instructions derive pool accounts from the curve's
  recorded `raydium_pool`, not from the current `cpmm_amm_config`, so an
  AmmConfig change never strands pools that already graduated.
- **Graduation.** When the curve's real token reserves reach zero, it migrates
  to a **Raydium CPMM** pool (not LaunchLab, not pump-amm). The LP tokens are
  locked with Raydium Burn & Earn rather than burned, so the protocol keeps
  earning the pool's trading fees. Graduation is three crank-only
  instructions:
  1. `prepare_migration` moves the curve's remaining tokens and all real SOL
     to the `["migration-authority", mint]` PDA. That PDA is system-owned and
     holds no data, because CPMM's `creator` must be a system account that
     pays rent and fees; the `BondingCurve` account can't be.
     `Global.migration_reserve_lamports` is held back to pay the pool fee and
     rent. The pool must open within 5% of the curve's final price.
  2. `migrate_raydium` calls CPMM `initialize` with the PDA signing as
     creator. Every Raydium address is re-derived and checked.

  **Donations never change pool amounts.** Pricing and pool seeding use only
  the curve's *tracked* amounts:
  - tokens = `token_total_supply - (initial_real_token_reserves -
    real_token_reserves)`;
  - SOL = `real_sol_reserves` minus the reserve.

  Anyone can send tokens or WSOL to the curve's or the migration authority's
  public token accounts. Any such surplus is handled separately, so it can
  neither fail the price check (blocking graduation) nor misprice the pool:
  - Surplus tokens are burned: in `prepare_migration` for the curve account,
    in `migrate_raydium` for the migration authority's account.
  - Surplus WSOL is unwrapped into the migration authority and reaches the
    treasury with the unspent reserve in step 3. The crank is refunded
    exactly the WSOL account's rent.

  3. `lock_migrated_lp` (needs a new keypair for the fee-key NFT mint) calls
     Burn & Earn `lock_cp_liquidity` for the full LP balance. The fee-key NFT
     is owned by the `["fee-key-vault"]` PDA. Any unspent reserve goes to the
     treasury.

  Steps 1 and 2 fit in one transaction. Step 3 doesn't fit with step 2,
  because Solana transactions are limited to 1,232 bytes. The CPMM and lock
  program IDs, AmmConfig and lock authority are fields in `Global`. The
  instruction layouts are written out by hand in `src/raydium.rs`, with the
  sources it was checked against cited there.

## Layout

| Path | Purpose |
| --- | --- |
| `programs/parabull/src/state.rs` | Account layouts, normalisation helpers |
| `programs/parabull/src/math.rs` | Curve and fee arithmetic (no I/O) |
| `programs/parabull/src/instructions/` | One file per instruction |
| `programs/parabull/src/launch.rs` | Pure launch-flow rules (metadata, expiry, refunds, settlement, registry claims) |
| `programs/parabull/src/trade.rs` | Pure buy/sell state transitions (open-slot check, slippage, fee split, graduation) |
| `programs/parabull/src/flywheel.rs` | Pure escrow top-up/release and fee-sweep rules |
| `programs/parabull/src/raydium.rs` | Raydium CPMM / Burn & Earn IDs, seeds, PDA derivation, instruction builders (initialize, swap_base_input, lock, collect) |
| `programs/parabull/src/merkle.rs` | Holder-reward Merkle leaf/node hashing, verification, and the reference tree builder |
| `programs/parabull/tests/reference_parity.rs` | Differential tests against `reference/programs/pump` |
| `programs/parabull/tests/common/mod.rs` | Shared solana-program-test harness (`Env`, instruction builders) |
| `programs/parabull/tests/launch_flow.rs` | Runtime tests: request_launch / refund_ticket / create |
| `programs/parabull/tests/trade_flow.rs` | Runtime tests: buy / sell (Token-2022 transfers, lamports, slot delay, graduation) |
| `programs/parabull/tests/migration_flow.rs` | Runtime tests: migration, escrow, sweeps |
| `programs/parabull/tests/fee_collection.rs` | Runtime tests: collect_lp_fees routing |
| `programs/parabull/tests/admin_flow.rs` | Runtime tests: update_global_params and the two-step admin transfer |
| `programs/parabull/tests/pause_flow.rs` | Runtime tests: set_paused (what's blocked and what stays open) |
| `programs/parabull/tests/buyback_flow.rs` | Runtime tests: buyback swap + burn, slippage, vault rent, access |
| `programs/parabull/tests/rewards_flow.rs` | Runtime tests: Merkle epochs, pull/push claims, double-claim, solvency |
| `programs/parabull/tests/common/raydium_mock.rs` | Native Raydium CPMM / lock mocks at the mainnet IDs; they re-derive and check every account |
| `docs/BACKEND_SPEC.md` | Off-chain services: launch worker (random delay, tweet verification), bundle-risk indexer, similarity flags |
| `docs/DESIGN.md` | Bronze/copper design system: tokens, contrast, materials, typography, brand mark, data-viz rules |
| `app/` | Web app (React + Vite + Tailwind). See `app/README.md` for routes, modes, and what's wired to the program vs demo data |
| `services/parabull-indexer/` | Market indexer: curves, tickets, trades and holders from RPC (IDL-driven decoding, logsSubscribe + polling), served over REST and a WebSocket stream for chain mode (`VITE_INDEXER_URL`). See `docs/BACKEND_SPEC.md` §5 |
| `services/twitter-sentinel/` | X sentinel: posts a coin's curve milestones and answers cashtag mentions of its account; settings come from the creator's signed request. Separate package, never bundled into `app/`. See its README |
| `reference/` | Byte-matching pump.fun reconstructions. Read-only |

## Cluster addresses (Raydium)

These come from Raydium's own sources: raydium-cp-swap `lib.rs` (the IDs
behind its `devnet` feature flag) and raydium-sdk-v2 `programId.ts`.
**Devnet and mainnet use different CPMM and Burn & Earn program IDs.**

| | Mainnet | Devnet |
| --- | --- | --- |
| CPMM program | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb` |
| CPMM pool-fee receiver | `DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8` | `3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy` |
| Burn & Earn program | `LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE` | `DRay25Usp3YJAi7beckgpGUC7mGJ2cR1AVPxhYfwVCUX` |
| Burn & Earn authority | `3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH` | `7qWVV8UY2bRJfDLP4s37YzBPKUkVB46DStYJBpYbQzu3` |
| AmmConfig index 0 (default) | `D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2` (0.25%) | `5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy` |

AmmConfigs are PDAs `["amm_config", index as big-endian u16]` under the
cluster's CPMM program (raydium-cp-swap `create_config.rs`).
`scripts/src/config.ts` `ammConfigPda` derives them, and `config.test.ts`
pins both index-0 addresses.

## Rules for changes

- Never deploy, build for release, or change the program logic under
  `reference/`. Each program there is its own standalone Cargo workspace with
  its own pins and patches. The root workspace excludes it.
- Don't add `[patch.crates-io]` entries to the root `Cargo.toml`.
- Pinned versions: Anchor `=0.31.1`, Rust 2021 edition.
- `math.rs` curve formulas must stay identical to the reference. If you change
  one, `reference_parity.rs` must still pass.
- Account layout changes: add new fields before `_reserved` and shrink
  `_reserved` by the same number of bytes. Update the pinned sizes in
  `state::tests::account_sizes_fit_and_are_stable`. (Accounts may still
  grow before the first deploy. After that, only take space from
  `_reserved`.)
- Raydium CPIs: never trust addresses passed in for Raydium accounts.
  Re-derive them with `raydium::cpmm_accounts` / `raydium::lock_accounts` and
  compare. If Raydium changes its interface, update `src/raydium.rs` and the
  mocks together.
- Every arithmetic operation in on-chain code must be checked (`checked_*` or
  `ParabullError`).
- Move lamports directly (`sub_lamports`/`add_lamports`) only after the
  instruction's last CPI. Doing it earlier fails in solana-program-test's
  native mode ("sum of account balances before and after instruction do not
  match").
- New instructions get pure-rule unit tests and runtime tests in
  `tests/launch_flow.rs` (or a sibling file).
- In runtime tests, advance slots with `Env::warp_to`, which sets the
  `Clock` sysvar. `ProgramTestContext::warp_to_slot` hits the cloud
  container's 20,000 open-file limit.
- In program-test the program runs natively, so its own `msg!`/`emit!` logs
  don't appear in transaction metadata. Assert on state instead; checking
  events needs an SBF build.

## Scripts (`scripts/`)

- TypeScript, typed against the IDL from `anchor build`. `npm run typecheck`
  fails on any wrong instruction, account or argument name.
- `test_devnet_e2e.ts` (`npm run e2e:devnet`) is the pre-deployment check.
  It runs one coin through its lifecycle on devnet: a ticket, then `create` by
  the launch worker's own code, a 0.230 SOL buy and a partial sell. Every
  balance, reserve, fee bucket, token balance and event is compared with the
  local quote, exactly. Its pure helpers (`src/e2e.ts`) and the worker runner
  are unit-tested, but the sandbox can't reach devnet, so the script itself
  only runs on a machine that can.
- `src/lpFees.ts` gets the claimable Burn & Earn fee per locked position
  (fee-key NFT) from Raydium's lock-position API, the same one raydium-sdk-v2
  uses. It never throws, and the crank caps the result at the on-chain locked
  LP. **Not yet confirmed:** that the API's `unclaimedFee.lp` is in UI units.
- `src/snapshot.ts` takes the $PARABULL holder snapshot and turns it into
  reward epochs. It only includes system-owned wallets (the ones
  `claim_holder_reward` can pay), splits rewards by balance rounding down,
  respects the 80,000-leaf limit, checks every proof, and confirms the
  on-chain root after publishing. Artifacts go to `scripts/snapshots/`
  (git-ignored).
- `src/curve.ts`, `src/merkle.ts` and `src/launch.ts` are TypeScript ports
  of `math.rs`, `merkle.rs` and the ticker/name normalisation in `state.rs`.
  `npm test` checks them against values pinned in the Rust tests (the
  Merkle root is also pinned in `merkle.rs`). If you change one side,
  change both.
- `anchor idl build -p parabull -o target/idl/parabull.json -t
  target/types/parabull.ts` produces the IDL and TS types the scripts need,
  with no Solana toolchain required. That's what CI does (verified with
  anchor-cli 0.31.1 built from crates.io).
- Without the Anchor CLI, the IDL can also be generated with
  `anchor_lang_idl::build::build_idl` (crate `anchor-lang-idl` 0.1.4,
  feature `build`). Run it with `RUSTUP_TOOLCHAIN` unset: that version
  passes a literal `+{toolchain}` to cargo whenever the variable is set.

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`:
- **`cargo`:** `cargo test -p parabull --locked`, then `cargo check -p
  parabull --features idl-build --locked`.
- **`scripts`:** builds and caches anchor-cli 0.31.1 from crates.io, runs
  `anchor idl build`, then `npm ci`, `npm run typecheck` and `npm test` in
  `scripts/`. It also checks that `app/src/idl/` matches the generated IDL.
- **`app`:** `npm ci`, `npm test` and `npm run build` (typecheck + Vite) in
  `app/`.
- **`sentinel`:** `npm ci`, `npm run typecheck` and `npm test` in
  `services/twitter-sentinel/`.
- **`indexer`:** `npm ci`, `npm run typecheck` and `npm test` in
  `services/parabull-indexer/` (codec vectors, a simulated cluster for
  tickets, trades, graduation, backfill paging and the API).
- **`canister`:** in `canisters/solana_signer/`, `mops install --locked`,
  `mops check -- -Werror`, `mops test`, `mops build`, `icp build
  solana_signer`, then the PocketIC integration tests in `e2e/` (they drive
  the app's own Chain Fusion client).

The Rust jobs use `line-tables-only` debug info, because each runtime-test
binary is about 440 MB with full debug info.

## Verified commands

- **test**: `cargo test -p parabull` (from the repository root). The
  first build compiles solana-program-test, which takes several minutes.
- **check with IDL build**: `cargo check -p parabull --features idl-build`
- **scripts**: `cd scripts && npm ci && npm run typecheck && npm test`
  (needs `target/types/parabull.ts` from `anchor build`)
- **app**: `cd app && npm ci && npm test && npm run build`. After a program
  change, regenerate the IDL and run `npm run sync-idl` in `app/`; CI fails
  if `app/src/idl/` drifts. `npm run screenshots -- <dir>` captures every
  page with Playwright.
- **build / deploy**: `anchor build` and `anchor deploy` (needs the Anchor
  0.31.1 and Solana CLIs). Before the first deploy, run `anchor keys sync`
  with your own program keypair. The root `Makefile` wraps every step. The
  cloud sandbox can't run the Solana toolchain, so the SBF build has never
  run here: run it locally (see `scripts/README.md`).

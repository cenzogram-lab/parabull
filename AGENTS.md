# Parabull: agent guidance

Parabull is a Solana meme-token launchpad built with Anchor. **This project is
under active development.** The pump.fun sources in `reference/` are for
reading only.

## Product rules (locked decisions)

- **Blind launches.** A user deposits about 0.23 SOL into a `LaunchTicket` PDA
  (0.2 SOL protocol fee plus rent). The backend creates the coin, co-signing
  as `Global.launch_authority`, and generates the mint keypair server-side.
  Nobody can trade before `trading_open_slot` (creation slot plus a delay).
  The creator's first buy is an ordinary buy after the market opens. A ticket
  that isn't used before it expires can be refunded to the payer.
- **Launch flow rules.** `request_launch` records the launch fee in effect at
  request time and a hash of the exact name, symbol and URI. `symbol` must
  already be the canonical ticker. `create` must run before the ticket
  expires and must match that hash. 0.2 SOL goes to the treasury and the rest
  of the deposit repays the launch authority for the rent it fronted; the
  ticket's own rent goes back to the payer. After `create` the mint has a
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
  Tickers are 1-10 ASCII letters or digits, stored uppercase. Lookalike
  detection happens in the off-chain indexer, not on-chain.
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
- **Admin parameters.** `update_global_params` takes a `GlobalUpdate` where
  every field is optional (`None` = unchanged): `dex_target_lamports`,
  `buyback_bps`, `holder_bps`, `migration_reserve_lamports`,
  `trading_open_delay_slots`, `cpmm_program`, `cpmm_amm_config`,
  `lp_lock_program`, `lp_lock_authority`. The merged result is validated
  with the same rules as `initialize` and either applies in full or not at
  all. `dex_target_updated_at` changes only when the target does.
- **Post-graduation LP fees.** `collect_lp_fees(fee_lp_amount)` (crank only)
  has the `["fee-key-vault"]` PDA sign Burn & Earn `collect_cp_fees`. The
  `fee_lp_amount` is supplied by the caller, from Raydium's API, but is never
  trusted for accounting. Only the measured balance increases are routed:
  - **SOL side:** unwrapped; fills the token's escrow first (if it's still
    open), then goes straight to `BuybackVault` / `HolderRewardVault` by the
    global split, with the remainder to the treasury.
  - **Launched-token side:** held in the fee-key vault's token account.

  The temporary WSOL account's rent goes back to the crank.
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
     creator. Every Raydium address is re-derived and checked. The pool is
     seeded with the PDA's actual token balances (at least the prepared
     amounts), so tokens donated to those accounts can't block migration.
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
| `programs/parabull/src/raydium.rs` | Raydium CPMM / Burn & Earn IDs, seeds, PDA derivation, instruction builders |
| `programs/parabull/tests/reference_parity.rs` | Differential tests against `reference/programs/pump` |
| `programs/parabull/tests/common/mod.rs` | Shared solana-program-test harness (`Env`, instruction builders) |
| `programs/parabull/tests/launch_flow.rs` | Runtime tests: request_launch / refund_ticket / create |
| `programs/parabull/tests/trade_flow.rs` | Runtime tests: buy / sell (Token-2022 transfers, lamports, slot delay, graduation) |
| `programs/parabull/tests/migration_flow.rs` | Runtime tests: migration, escrow, sweeps |
| `programs/parabull/tests/fee_collection.rs` | Runtime tests: collect_lp_fees routing |
| `programs/parabull/tests/admin_flow.rs` | Runtime tests: update_global_params and the two-step admin transfer |
| `programs/parabull/tests/common/raydium_mock.rs` | Native Raydium CPMM / lock mocks at the mainnet IDs; they re-derive and check every account |
| `reference/` | Byte-matching pump.fun reconstructions. Read-only |

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

## Verified commands

- **test**: `cargo test -p parabull` (from the repository root). The
  first build compiles solana-program-test, which takes several minutes.
- **check with IDL build**: `cargo check -p parabull --features idl-build`
- **build / deploy**: `anchor build` and `anchor deploy` (needs the Anchor
  0.31.1 and Solana CLIs). Before the first deploy, run `anchor keys sync`
  with your own program keypair.

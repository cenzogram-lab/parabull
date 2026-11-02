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
  If a token graduates or goes inactive before its escrow reaches the
  target, the unreleased `escrow_accrued` goes to `BuybackVault`, never to
  the treasury.
- **Graduation.** When the curve's real token reserves reach zero, it migrates
  to a **Raydium CPMM** pool (not LaunchLab, not pump-amm). The LP tokens are
  locked with Raydium Burn & Earn rather than burned, so the protocol keeps
  earning the pool's trading fees.

## Layout

| Path | Purpose |
| --- | --- |
| `programs/parabull/src/state.rs` | Account layouts, normalisation helpers |
| `programs/parabull/src/math.rs` | Curve and fee arithmetic (no I/O) |
| `programs/parabull/src/instructions/` | One file per instruction |
| `programs/parabull/src/launch.rs` | Pure launch-flow rules (metadata, expiry, refunds, settlement, registry claims) |
| `programs/parabull/src/trade.rs` | Pure buy/sell state transitions (open-slot check, slippage, fee split, graduation) |
| `programs/parabull/tests/reference_parity.rs` | Differential tests against `reference/programs/pump` |
| `programs/parabull/tests/common/mod.rs` | Shared solana-program-test harness (`Env`, instruction builders) |
| `programs/parabull/tests/launch_flow.rs` | Runtime tests: request_launch / refund_ticket / create |
| `programs/parabull/tests/trade_flow.rs` | Runtime tests: buy / sell (Token-2022 transfers, lamports, slot delay, graduation) |
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
  `state::tests::account_sizes_fit_and_are_stable`.
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

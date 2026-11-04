# Parabull

A Solana meme launchpad built on Anchor 0.31.1:

- **Blind launches:** the backend creates each coin and trading opens a few
  slots later, so nobody can buy in the creation block.
- **3-day ticker and name lock** against copycat launches.
- **1% platform fee, 0% to creators.** The fee first funds the token's
  DexScreener listing, then $PARABULL buyback and burn, then $PARABULL holder
  rewards.
- **Graduation to Raydium CPMM**, with the LP locked via Burn & Earn.

## Status

| Component | State |
| --- | --- |
| Accounts (`state.rs`) | Done |
| Curve and fee maths (`math.rs`), with parity tests against the reference | Done |
| `initialize` | Done |
| `request_launch`, `refund_ticket`, `create` (blind launch, registry locks) | Done |
| `buy`, `sell` (open-slot delay, slippage, 1% fee buckets, graduation lock) | Done |
| Graduation: `prepare_migration`, `migrate_raydium` (CPMM), `lock_migrated_lp` (Burn & Earn) | Done (tested against Raydium mocks) |
| DexScreener escrow `top_up_dex_escrow` / `release_dex_escrow`, `sweep_fees` | Done |
| `update_global_params`, two-step admin transfer | Done |
| `collect_lp_fees` (Burn & Earn fee key: escrow first, then buyback / holder vaults) | Done (tested against Raydium mocks) |
| `set_paused` emergency control | Done |
| Collected meme tokens burned inside `collect_lp_fees` | Done |
| $PARABULL `prepare_buyback` + `buyback_and_burn` (CPMM swap, slippage floor, burn) | Done (tested against Raydium mocks) |
| Holder rewards: `publish_reward_epoch` / `claim_holder_reward` (Merkle + bitmap, push or pull) | Done |
| `expire_reward_epoch` (claim window fixed per epoch) | Done |
| `scripts/`: deploy + init, launch/trade smoke test, reference crank (typechecked against the IDL) | Done, not yet run against a live cluster |
| `app/`: desktop web app (board, explore, launch, trading terminal, leaderboard, live, holder rewards, $PARABULL hub) | Done on demo data; launches, trades and claims are wired to the program but not yet run against a live cluster |
| SBF build + devnet run against real Raydium; LP-fee amount source; holder snapshot job | Not started |

## Development

```bash
cargo test -p parabull
```

See [AGENTS.md](AGENTS.md) for the product rules and contribution
constraints.

The web app lives in [`app/`](app/README.md) (`cd app && npm ci && npm run
dev`). Its bronze/copper design system is in [docs/DESIGN.md](docs/DESIGN.md).

## Reference sources

`reference/` contains the community reconstruction of pump.fun's on-chain
programs (forked from `lalalune/pumpfun-source`). It's used as a reference
for the curve maths and for differential tests. It is not part of the
Parabull build. See [reference/README.md](reference/README.md).

Repository code is [MIT licensed](LICENSE). Third-party sources keep their
original licenses and notices.

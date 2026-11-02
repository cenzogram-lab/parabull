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
| Launch tickets, create, buy/sell, migration, flywheel cranks | Not started |

## Development

```bash
cargo test -p parabull
```

See [AGENTS.md](AGENTS.md) for the product rules and contribution
constraints.

## Reference sources

`reference/` contains the community reconstruction of pump.fun's on-chain
programs (forked from `lalalune/pumpfun-source`). It's used as a reference
for the curve maths and for differential tests. It is not part of the
Parabull build. See [reference/README.md](reference/README.md).

Repository code is [MIT licensed](LICENSE). Third-party sources keep their
original licenses and notices.

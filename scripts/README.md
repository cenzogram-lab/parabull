# Parabull scripts

These are TypeScript scripts for deploying and testing on devnet, plus a
reference crank. They're typed against the program IDL produced by
`anchor build` (`target/idl/parabull.json`, `target/types/parabull.ts`).

## Building and deploying (run these on your own machine)

The cloud sandbox used for development can't download or run the Solana
toolchain, so the SBF build and deploy happen on your machine.

Prerequisites:
- Rust (stable)
- Agave (Solana) CLI 2.3.x, for `cargo build-sbf` and `solana`
- Anchor CLI 0.31.1 (`avm install 0.31.1 && avm use 0.31.1`)
- Node 20 or newer
- A devnet-funded wallet at `~/.config/solana/id.json`

```bash
# 0. First time only: put your program ID into the code, then build.
anchor keys sync
```

```bash
# 1. Build the SBF bytecode plus the IDL and TS types (target/idl, target/types).
anchor build
```

```bash
# (Bytecode only, no IDL or types; the scripts need `anchor build`.)
cargo build-sbf --manifest-path programs/parabull/Cargo.toml
```

```bash
# 2. Deploy.
anchor deploy --provider.cluster devnet
```

```bash
# 3. Initialise Global, then run the smoke test.
cd scripts && npm ci && npm run typecheck && npm test
```

```bash
CLUSTER=devnet npm run deploy:init
```

```bash
CLUSTER=devnet npm run smoke
```

```bash
# 4. One crank pass. Add --sol-usd <price> to refresh the $299 target.
CLUSTER=devnet npm run crank -- --once
```

```bash
# 5. Launch worker: turns LaunchTickets into coins after a random 3-15 s.
CLUSTER=devnet SKIP_METADATA_FETCH=1 npm run worker
```

Path A (Internet Identity accounts) has its own devnet smoke test, which drives the deployed Chain Fusion signer
canister: see "Devnet smoke test" in [`canisters/solana_signer/README.md`](../canisters/solana_signer/README.md).

### Devnet test curve

The mainnet curve graduates at about 85 SOL. To test graduation, Raydium
migration and the LP lock on devnet with faucet SOL, initialise `Global` with
a small curve (this only applies when `Global` doesn't exist yet):

```bash
CLUSTER=devnet CURVE_PRESET=small CURVE_TARGET_SOL=2 npm run deploy:init
```

`deploy:init` prints the graduation preview (raise, migration SOL, pool
tokens, opening-price check) and refuses parameters that would fail the 5%
pool-price check or a migration reserve below the CPMM `create_pool_fee` plus
rent. Variables: `CURVE_PRESET` (`mainnet` default, or `small`; `small` is
refused on mainnet-beta), `CURVE_TARGET_SOL`, `MIGRATION_RESERVE_LAMPORTS`
(default 0.25 SOL), or all four of `INITIAL_VIRTUAL_TOKEN_RESERVES`,
`INITIAL_VIRTUAL_SOL_RESERVES`, `INITIAL_REAL_TOKEN_RESERVES`,
`TOKEN_TOTAL_SUPPLY` for a fully custom curve.

Then run the whole lifecycle on that curve. Each line is a separate run:

```bash
# Launch, trade, buy out the curve, migrate to Raydium and lock the LP.
CLUSTER=devnet GRADUATE=1 npm run smoke
```

```bash
# Same, but the launch worker does `create` (start it first in another terminal).
CLUSTER=devnet SKIP_METADATA_FETCH=1 npm run worker
```

```bash
CLUSTER=devnet GRADUATE=1 npm run smoke -- --no-create
```

- `GRADUATE=1` makes one buy for every remaining token. It checks that the
  next buy fails with `CurveComplete`, then runs the crank's three graduation
  transactions (`src/graduation.ts`, the same code as `crank_worker.ts`). It
  finishes by checking that the pool is owned by the CPMM program, the
  Burn & Earn lock vault holds LP, and no LP is left with the migration
  authority. It refuses mainnet-beta, and refuses a buy-out costing more than
  `GRADUATE_MAX_SOL` (default 5), which catches a `Global` initialised with
  the mainnet curve. The admin wallet tops the test user up for the buy-out,
  so one run spends about 2.5 SOL of the admin's on a 2 SOL curve (deploying
  the program itself costs more).
- `--no-create` stops after `request_launch` and waits for the ticket to
  close. It then finds the worker's mint through the ticker registry and
  prints the worker's delay on the on-chain clock (expect about 3–15 s plus
  confirmation time). If the worker refunded the ticket instead, it fails.
  The default metadata URI isn't real, so either run the worker with
  `SKIP_METADATA_FETCH=1` or set `SMOKE_URI` to metadata JSON with a reachable
  image. Without `--no-create`, the smoke test sends `create` itself and a
  running worker just finds the ticket closed.

The same steps are available from the repository root with `make`: `make keys`,
`make build`, `make build-sbf`, `make test`, `make scripts-check`,
`make deploy`, `make init`, `make smoke`, `make crank`, `make worker` (`CLUSTER=devnet` by
default). `npm run build:program` (from `scripts/`) runs `anchor build`.

The first SBF build is where stack-frame and compute-unit problems will show
up, because native `cargo test` runs can't catch them. If `anchor build`
reports "Stack offset exceeded", the usual fix is to `Box` more accounts in
the instruction it names.

| Script | What it does |
| --- | --- |
| `deploy_and_init.ts` | Checks that the program is deployed with `ADMIN_KEYPAIR` as upgrade authority, that the Raydium programs are executable, and that the AmmConfig is owned by the configured CPMM program. Then initialises `Global`. It does nothing if `Global` already exists. On devnet it creates a test Token-2022 `$PARABULL` mint unless `PARABULL_MINT` is set. |
| `test_launch_and_trade.ts` | Funds a throwaway user, then runs `request_launch` and `create` (signed by the launch authority and a new mint keypair). It shows a buy inside the slot delay being rejected, then buys and sells with slippage limits from `src/curve.ts`. `--no-create` leaves `create` to the launch worker; `GRADUATE=1` then buys out the curve and graduates it (see "Devnet test curve"). |
| `launch_worker.ts` | Launch worker (`docs/BACKEND_SPEC.md` §1). Listens for `LaunchRequested` events (plus a `POLL_MS` poll of open tickets), recovers name/symbol/URI from the user's `request_launch` transaction and checks them against the ticket's commitment, pre-checks pause and the ticker/name/tweet locks, optionally fetches the metadata URI and checks the tweet with the X API, then waits a CSPRNG-uniform 3–15 s and sends `create` with a fresh in-memory mint keypair. Rejected tickets are refunded at once with `refund_ticket`. `--once` runs one poll and exits. |
| `crank_worker.ts` | Reference crank: graduation (3 transactions), escrow release, fee sweeps, LP-fee collection, buyback and burn with a quoted `min_amount_out`, reward-epoch expiry, optional DexScreener-target refresh (`--sol-usd`), and optional holder-reward publishing (`--publish-rewards`). |
| `src/snapshot.ts` (`npm run snapshot [-- --publish]`) | Takes a $PARABULL holder snapshot and turns it into reward epochs. It writes `snapshots/epoch-<n>.draft.json` on a dry run, or publishes and writes `snapshots/epoch-<n>.json` (root, total, and every leaf with its amount, balance and proof) for the claim UI. |
| `src/lpFees.ts` | Fetches the claimable Burn & Earn LP fee for one locked position from Raydium's lock-position API. |

Backend services that aren't built as scripts here (the 20-slot bundle-risk
indexer and image/lookalike flags, plus the durable job table and X account
linking the launch worker would need in production) are specified in
[`docs/BACKEND_SPEC.md`](../docs/BACKEND_SPEC.md).

## LP-fee collection

Raydium tracks fees per locked position (the fee-key NFT), not per pool.
`src/lpFees.ts` calls the endpoint raydium-sdk-v2 uses (`fetchCpmmLockInfo`):
`https://dynamic-ipfs[-devnet].raydium.io/lock/cpmm/position?id=<NFT mint>`.
It reads `positionInfo.unclaimedFee.lp` and converts it to raw LP units using
`poolInfo.lpMint.decimals` (default 9), rounding down. It then keeps 0.1%
back as a safety margin, and the crank also caps the amount at the
on-chain locked-LP balance.

- A 404, a 429, a timeout, bad JSON or a zero fee all return `null`, and
  that pool is skipped for this pass.
- `OVERRIDE_LP_FEE_AMOUNT=<raw LP units>` skips the API (for devnet/local
  testing). `RAYDIUM_CPMM_LOCK_API` overrides the endpoint, and `LP_FEE_MIN`
  sets the smallest amount worth collecting.
- **Not yet confirmed:** that `unclaimedFee.lp` is in UI units. The API
  isn't reachable from the development sandbox. Burn & Earn rejects an
  over-claim, so if the unit is wrong, collection fails; it never over-pays.
  Check one real response before relying on it.
- The pool-info endpoint (`/pools/info/ids`) returns pool-level stats, not
  what a particular lock can claim, so it isn't used.

## Holder snapshots

Who counts as a holder:
- `claim_holder_reward` only pays system-owned wallets, so the snapshot keeps
  only token-account owners that are system-owned (or have no account yet),
  not executable, and either on the ed25519 curve or holding lamports.
- That excludes pool vaults, bonding curves and other programs' PDAs, the
  burn and incinerator addresses, the Burn & Earn authority, Parabull's own
  PDAs, the $PARABULL pool's vault authority, and anything listed in
  `SNAPSHOT_EXCLUDE` (comma-separated).

How rewards are split:
- Distributable = vault balance − rent − outstanding rewards, times
  `SNAPSHOT_DISTRIBUTE_BPS` (default 10000).
- It's split by balance, rounding down. Payouts below
  `SNAPSHOT_MIN_PAYOUT_LAMPORTS` (default 10,000) are dropped, and nothing is
  published below `SNAPSHOT_MIN_DISTRIBUTABLE_LAMPORTS` (default 0.1 SOL).
- Up to 80,000 holders go in one epoch; above that the snapshot spans
  several.

Every proof is checked locally before publishing, and after publishing the
on-chain root and total are compared with what was built. The claim UI should
read `leaves[i]` (`index`, `claimant`, `amount`, `proof`) and send
`claim_holder_reward(epoch, index, amount, proof)`.

Environment variables: `CLUSTER` (`devnet` / `mainnet-beta` / `localnet`),
`RPC_URL`, `ADMIN_KEYPAIR` (default `~/.config/solana/id.json`),
`LAUNCH_AUTHORITY_KEYPAIR`, `CRANK_KEYPAIR` (both default to the admin on
devnet), `TREASURY`, `PARABULL_MINT`, `SOL_USD`, and `RAYDIUM_CPMM_PROGRAM` /
`RAYDIUM_AMM_CONFIG` / `RAYDIUM_POOL_FEE_RECEIVER` / `RAYDIUM_LOCK_PROGRAM` /
`RAYDIUM_LOCK_AUTHORITY` to override the addresses in `src/config.ts`. The
launch worker also reads `POLL_MS`, `SKIP_METADATA_FETCH=1`,
`X_BEARER_TOKEN` (tweet check, skipped when unset) and `DISABLE_DELAY=1`
(localnet only; refused on mainnet-beta). The curve variables are listed under
"Devnet test curve" above.

## Raydium addresses

**Devnet Raydium addresses differ from mainnet** (see `src/config.ts` for
the sources).

`RAYDIUM_AMM_CONFIG` defaults to fee tier index 0 on each cluster. Raydium
creates each AmmConfig at the PDA `["amm_config", index as big-endian u16]`
under the cluster's CPMM program:

| Cluster | CPMM program | AmmConfig index 0 (default) |
| --- | --- | --- |
| mainnet-beta | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | `D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2` (standard 0.25% tier) |
| devnet | `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb` | `5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy` |

To use a different tier, set `RAYDIUM_AMM_CONFIG_INDEX=<n>` (derived under
the active CPMM program) or `RAYDIUM_AMM_CONFIG=<address>`.
`deploy_and_init.ts` reads the config account and checks that it's owned by
CPMM, that it re-derives from its own stored index, and that pool creation is
enabled. It prints the trade fee and pool-creation fee before initialising.
(`9zSzfkYy6awexsHvmggeH36pfVUdDGyCcwmjT3AQPBj6` is not an AmmConfig PDA for
any index under either CPMM program, so it is not used.) Before going live, the crank's `getLpFeeAmount` must be
connected to a source of Burn & Earn fee amounts, and a $PARABULL
holder-snapshot job must build epochs with `src/merkle.ts` `buildEpoch`.

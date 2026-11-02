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

The same steps are available from the repository root with `make`: `make keys`,
`make build`, `make build-sbf`, `make test`, `make scripts-check`,
`make deploy`, `make init`, `make smoke`, `make crank` (`CLUSTER=devnet` by
default). `npm run build:program` (from `scripts/`) runs `anchor build`.

The first SBF build is where stack-frame and compute-unit problems will show
up, because native `cargo test` runs can't catch them. If `anchor build`
reports "Stack offset exceeded", the usual fix is to `Box` more accounts in
the instruction it names.

| Script | What it does |
| --- | --- |
| `deploy_and_init.ts` | Checks that the program is deployed with `ADMIN_KEYPAIR` as upgrade authority, that the Raydium programs are executable, and that the AmmConfig is owned by the configured CPMM program. Then initialises `Global`. It does nothing if `Global` already exists. On devnet it creates a test Token-2022 `$PARABULL` mint unless `PARABULL_MINT` is set. |
| `test_launch_and_trade.ts` | Funds a throwaway user, then runs `request_launch` and `create` (signed by the launch authority and a new mint keypair). It shows a buy inside the slot delay being rejected, then buys and sells with slippage limits from `src/curve.ts`. |
| `crank_worker.ts` | Reference crank: graduation (3 transactions), escrow release, fee sweeps, LP-fee collection, buyback and burn with a quoted `min_amount_out`, reward-epoch expiry, and optional DexScreener-target refresh. |

Environment variables: `CLUSTER` (`devnet` / `mainnet-beta` / `localnet`),
`RPC_URL`, `ADMIN_KEYPAIR` (default `~/.config/solana/id.json`),
`LAUNCH_AUTHORITY_KEYPAIR`, `CRANK_KEYPAIR` (both default to the admin on
devnet), `TREASURY`, `PARABULL_MINT`, `SOL_USD`, and `RAYDIUM_CPMM_PROGRAM` /
`RAYDIUM_AMM_CONFIG` / `RAYDIUM_POOL_FEE_RECEIVER` / `RAYDIUM_LOCK_PROGRAM` /
`RAYDIUM_LOCK_AUTHORITY` to override the addresses in `src/config.ts`.

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

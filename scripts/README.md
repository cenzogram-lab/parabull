# Parabull scripts

These are TypeScript scripts for deploying and testing on devnet, plus a
reference crank. They're typed against the program IDL produced by
`anchor build` (`target/idl/parabull.json`, `target/types/parabull.ts`).

```bash
anchor build                                   # IDL + types + .so
anchor keys sync && anchor build               # first time only: your program ID
anchor deploy --provider.cluster devnet
cd scripts && npm ci
npm run typecheck && npm test                  # tsc against the IDL; TS ports vs Rust vectors
CLUSTER=devnet npm run deploy:init             # preflight + initialize Global and vaults
CLUSTER=devnet npm run smoke                   # ticket -> create -> slot delay -> buy/sell
CLUSTER=devnet npm run crank -- --once         # one crank pass (add --sol-usd 150 to refresh the $299 target)
```

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

**Devnet Raydium addresses differ from mainnet** (see `src/config.ts` for
the sources). Before going live, the crank's `getLpFeeAmount` must be
connected to a source of Burn & Earn fee amounts, and a $PARABULL
holder-snapshot job must build epochs with `src/merkle.ts` `buildEpoch`.

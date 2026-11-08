# solana_signer

The Chain Fusion signer behind the connect dialog's **Continue with Google / Passkey / Email** (Path A). Each Internet
Identity principal gets a Solana address: a threshold Ed25519 public key that the IC derives from that principal. Its
transactions are signed with `sign_with_schnorr`, so the canister holds no private keys and no seed phrase exists.

The app's client is `app/src/lib/auth/chainFusionSigner.ts`. Set `VITE_II_SIGNER_CANISTER_ID` to this canister's ID to
use it; without it, Path A falls back as `app/src/lib/auth/iiConfig.ts` describes.

## Interface (`solana_signer.did`)

| Method | Kind | What it does |
|---|---|---|
| `get_solana_address : (principal) -> (text)` | update | The principal's address, base58. Deriving a key calls the management canister (`schnorr_public_key`), which a query can't do. Once a caller's own key is cached, it is returned without that call |
| `lookup_solana_address : (principal) -> (opt text)` | query | The cached address of a principal that has used the signer, or nothing; a fast read for a returning user |
| `sign_solana_transaction : (blob, vec nat8) -> (blob)` | update | Signs a serialized transaction message with the caller's key and returns the 64-byte signature |
| `configure : (ConfigUpdate) -> ()` | update | Controllers only: pause or resume signing, set the limits, choose the key |
| `status : () -> (Status)` | query | Key name, pause state, limits, number of cached addresses and signatures issued |

## Security rules

- **Only the caller's key signs.** The derivation path is `[caller.toBlob()]`, never an argument.
- **Anonymous callers are refused** by every update method. The anonymous principal has no address.
- **The second argument of `sign_solana_transaction` is the 32-byte address the client expects to sign as.**
  - The canister derives the caller's key and compares the two before requesting any signature.
  - A mismatch is refused (`expected signer mismatch`). So a client can never sign as someone else, and a stale address is caught.
- **Messages are 1 to 1232 bytes.** A Solana transaction, signatures included, fits in one 1232-byte packet.
- **Rate limits.** By default, 10 requests a minute per caller and 20 a minute for everyone together.
  - Only requests that reach the management canister count: uncached address derivations and signatures.
  - Each signature costs about 26B cycles with `key_1` (attached with the call; the unused part is refunded).
  - New principals cost nothing to make, so the global limit is what bounds the spend. 20 a minute is about 0.52T cycles a minute at most.
  - Tune both limits with `configure`. Watch the cycles balance and keep a backup controller.
- **Refusals are rejects with a reason.** The interface is fixed by the app, so they aren't `Result` values. The app shows the reason.

## Keys

The `key_1` threshold key is the default. It is on the mainnet fiduciary and II subnets, and on PocketIC.

| Key name | Where it is |
|---|---|
| `key_1` | Production: mainnet fiduciary and II subnets, and PocketIC (the default) |
| `test_key_1` | Mainnet test key, for staging |
| `dfx_test_key` | Local networks |

A controller can switch the key with `configure` only while no address exists yet. The address is a function of the canister ID, the key and the principal. So:
- changing the key would change every user's address;
- redeploying under a new canister ID gives every user a new address.

## Build and test

Toolchain: Node.js 22+ and the tools in the first command below. `mops` downloads the `moc` version pinned in `mops.toml`.

```bash
npm install -g ic-mops @icp-sdk/icp-cli @icp-sdk/ic-wasm
```

```bash
cd canisters/solana_signer && mops install && mops check && mops test && mops build solana_signer
```

The integration tests need the build above, the app's dependencies, and PocketIC, which `npm ci` downloads. They run the canister on a PocketIC instance with a fiduciary subnet holding `key_1`, and drive it with the app's own client. They:
- check that each principal gets its own address;
- sign a real Solana transfer and verify it;
- check the refusal of a mismatched expected signer, anonymous callers, malformed messages and non-controllers;
- check pausing and both rate limits.

```bash
npm ci --prefix app && cd canisters/solana_signer/e2e && npm ci && npm test
```

### Devnet smoke test (against the deployed canister)

`e2e/devnet-smoke.ts` runs Path A for real, against the deployed canister on Solana devnet. Addresses don't depend on
the Solana cluster, so the mainnet canister serves devnet too. It:
- makes a fresh principal (or reuses one with `SIGNER_IDENTITY_SEED`) and gets its address, checking it is stable and
  that `lookup_solana_address` returns it;
- checks a request to sign as another address is refused before any signature;
- funds the address from your devnet wallet, then has the canister sign a legacy and a v0 transfer back, which devnet
  confirms. The address ends empty.

It refuses a mainnet-beta RPC. Each run costs the canister two signatures (about 52B cycles) and counts against its
rate limits.

```bash
cd canisters/solana_signer/e2e && npm ci && SIGNER_CANISTER_ID=<canister id> npm run devnet-smoke
```

Optional settings:

| Variable | Default | Meaning |
|---|---|---|
| `FUNDER_KEYPAIR` | `~/.config/solana/id.json` | Devnet wallet that funds the test address |
| `FUND_LAMPORTS` | `20000000` (0.02 SOL) | Amount sent to the test address; all of it except fees comes back |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Devnet RPC |
| `IC_HOST` | `https://icp-api.io` | IC API host |
| `SIGNER_IDENTITY_SEED` | random | 64 hex characters, to keep one principal and address across runs |

## Deploy

To deploy, run this from the repository root. `icp.yaml` lists this directory, and the `@dfinity/motoko` recipe builds it from `canister.yaml` and `mops.toml`:

```bash
icp deploy -e ic solana_signer
```

With no ID recorded, `icp deploy` creates the canister. To install into one created elsewhere (for example in the
NNS app):
1. In the NNS app, add the icp-cli identity's principal (`icp identity principal`) as a controller. The NNS principal
   created the canister and is its only controller until then, and `icp deploy` is refused without that.
2. Record the ID in `.icp/data/mappings/ic.ids.json` as `{ "solana_signer": "<canister id>" }`, so `icp deploy`
   installs into it instead of creating a new one. Commit that file.

After the first deploy:
- run `mops deployed init solana_signer` once;
- run `mops deployed solana_signer` after every deploy, so `mops check` can verify upgrade compatibility against what's live.

State changes go through the migration chain in `migrations/`; see the `migrating-motoko-actors` skill.

## Layout

- `main.mo`: composition root. State is declared here; it has no public methods.
- `mixins/SignerApi.mo`: the public API.
- `lib/`:
  - `Request.mo`: request checks;
  - `RateLimit.mo`: rate limits;
  - `Base58.mo`: Base58 encoding;
  - `Management.mo`: the management canister's threshold Schnorr interface.
- `migrations/20261108_000000.mo`: initial state (`key_1`, signing on, the default limits).
- `test/*.test.mo`: Motoko unit tests, run with `mops test`.
- `e2e/`: the PocketIC integration tests.

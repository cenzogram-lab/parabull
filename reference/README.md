# Reference: reconstructed pump.fun programs

These are byte-matching reconstructions of pump.fun's deployed programs. The
`// layout-pad` comments, hand-written serialisers and vendored Anchor patches
exist only so the builds match the original binaries.

| Program | Path | Anchor |
| --- | --- | --- |
| Pump (bonding curve) | `programs/pump` | 0.31.1 |
| PumpSwap AMM | `programs/pump-amm` | 0.31.1 |
| Fees | `programs/pump-fees` | 0.31.1 (patched `anchor-attribute-program`, scoped to its own workspace) |
| Mayhem | `programs/mayhem` | 1.0.0 (vendored `anchor-lang`) |
| Donation relay | `programs/donation-relay` | 0.32.1 |

Each program is a standalone Cargo workspace. Treat them as read-only:

- Don't deploy them. They declare pump.fun's mainnet program IDs.
- Don't refactor them.
- Don't add them to the root workspace.

Parabull uses `programs/pump` only as a dev-dependency, to compare curve maths
in `programs/parabull/tests/reference_parity.rs`.

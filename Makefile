# Parabull build / deploy entry points. Run from the repository root.
# Prerequisites (local machine): Rust stable, Agave (Solana) CLI 2.3.x,
# Anchor CLI 0.31.1 (`avm install 0.31.1 && avm use 0.31.1`), Node 20+.

CLUSTER ?= devnet
PROGRAM := programs/parabull/Cargo.toml

.PHONY: help build build-sbf test scripts-install scripts-check deploy init smoke crank worker keys

help:
	@echo "make keys            # first time: sync program ID with target/deploy/parabull-keypair.json"
	@echo "make build           # anchor build: SBF .so + target/idl + target/types"
	@echo "make build-sbf       # cargo build-sbf only (no IDL/types)"
	@echo "make test            # Rust unit, parity and runtime tests"
	@echo "make scripts-check   # npm ci + typecheck scripts against the IDL + TS unit tests"
	@echo "make deploy          # anchor deploy to CLUSTER (default devnet)"
	@echo "make init | smoke | crank | worker   # scripts against CLUSTER"

keys:
	anchor keys sync

build:
	anchor build

build-sbf:
	cargo build-sbf --manifest-path $(PROGRAM)

test:
	cargo test -p parabull

scripts-install:
	cd scripts && npm ci

scripts-check: scripts-install
	cd scripts && npm run typecheck && npm test

deploy:
	anchor deploy --provider.cluster $(CLUSTER)

init:
	cd scripts && CLUSTER=$(CLUSTER) npm run deploy:init

smoke:
	cd scripts && CLUSTER=$(CLUSTER) npm run smoke

crank:
	cd scripts && CLUSTER=$(CLUSTER) npm run crank -- --once

worker:
	cd scripts && CLUSTER=$(CLUSTER) npm run worker

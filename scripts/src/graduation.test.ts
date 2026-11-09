import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { chooseMigrationPool, markSigner } from "./graduation";
import { cpmmAccounts, cpmmPoolAccounts } from "./pdas";

const CPMM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

test("migration pool: the canonical PDA while it's unused, a fresh signing keypair once someone created it", () => {
  const canonical = Keypair.generate().publicKey;
  // Never created, or only sent lamports (still system-owned): the canonical pool.
  assert.deepEqual(chooseMigrationPool(canonical, null), { pool: canonical, fresh: null });
  assert.deepEqual(chooseMigrationPool(canonical, { owner: SystemProgram.programId }), { pool: canonical, fresh: null });
  // Created by someone else (CPMM owns it): a fresh keypair, which is the pool.
  const kp = Keypair.generate();
  const r = chooseMigrationPool(canonical, { owner: CPMM }, () => kp);
  assert.ok(r.pool.equals(kp.publicKey) && r.fresh === kp);
});

test("a fresh-address pool's accounts derive from its own address, and it signs migrate_raydium", () => {
  const mint = Keypair.generate().publicKey;
  const auth = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const fresh = Keypair.generate().publicKey;
  const canonical = cpmmAccounts(CPMM, config, mint, auth);
  const k = cpmmPoolAccounts(CPMM, fresh, mint, auth);
  assert.ok(k.poolState.equals(fresh));
  assert.ok(!k.lpMint.equals(canonical.lpMint) && !k.token0Vault.equals(canonical.token0Vault), "not the canonical pool's accounts");
  const ix = new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: fresh, isSigner: false, isWritable: true },
      { pubkey: canonical.poolState, isSigner: false, isWritable: false },
    ],
  });
  markSigner(ix, fresh);
  assert.deepEqual(ix.keys.map((x) => x.isSigner), [true, false]);
});

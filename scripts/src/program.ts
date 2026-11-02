import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { Parabull } from "../../target/types/parabull";
import { rpcUrl } from "./config";
import { Pdas } from "./pdas";

/** IDL produced by `anchor build` (target/idl/parabull.json). */
export function loadIdl(): Parabull {
  const path = process.env.PARABULL_IDL ?? resolve(__dirname, "../../target/idl/parabull.json");
  return JSON.parse(readFileSync(path, "utf8")) as Parabull;
}

export function connect(payer: Keypair) {
  const connection = new Connection(rpcUrl(), "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const program = new Program<Parabull>(loadIdl(), provider);
  return { connection, provider, program, pdas: new Pdas(program.programId) };
}

export type ParabullProgram = Program<Parabull>;

/** Send instructions with an explicit compute-unit limit. */
export async function send(connection: Connection, ixs: TransactionInstruction[], signers: Keypair[], computeUnits = 400_000) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }), ...ixs);
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

export const bn = (v: bigint | number) => new BN(v.toString());
export const big = (v: BN) => BigInt(v.toString());
export const isDefault = (k: PublicKey) => k.equals(PublicKey.default);

/** Pull the Anchor error name out of a failed transaction, if any. */
export function anchorErrorName(e: unknown): string | undefined {
  const err = e as { error?: { errorCode?: { code?: string } }; logs?: string[]; message?: string };
  if (err?.error?.errorCode?.code) return err.error.errorCode.code;
  const m = (err?.logs ?? []).join("\n").match(/Error Code: (\w+)/) ?? String(err?.message ?? "").match(/Error Code: (\w+)/);
  return m?.[1];
}

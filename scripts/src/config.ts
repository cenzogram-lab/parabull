/**
 * Cluster configuration. Raydium addresses are taken from Raydium's own
 * sources (raydium-cp-swap `lib.rs` `#[cfg(feature = "devnet")]` IDs and
 * raydium-sdk-v2 `src/common/programId.ts` DEVNET_PROGRAM_ID), read 2026-11-02.
 * Note: devnet CPMM and Burn & Earn use *different* program IDs from mainnet.
 * Every value can be overridden by environment variable.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

export type ClusterName = "devnet" | "mainnet-beta" | "localnet";

export interface RaydiumAddresses {
  cpmmProgram: PublicKey;
  /** CPMM AmmConfig (fee tier) new pools are created under. */
  ammConfig: PublicKey | null;
  /** CPMM `create_pool_fee` receiver; CPMM enforces it on-chain. */
  poolFeeReceiver: PublicKey;
  lockProgram: PublicKey;
  lockAuthority: PublicKey;
}

const pk = (s: string) => new PublicKey(s);

export const RAYDIUM: Record<Exclude<ClusterName, "localnet">, RaydiumAddresses> = {
  devnet: {
    cpmmProgram: pk("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb"),
    // Supplied by the team as the devnet 0.25% tier. Not verifiable from this
    // repo's sources; deploy_and_init.ts checks on-chain that it is owned by
    // `cpmmProgram` before using it.
    ammConfig: pk("9zSzfkYy6awexsHvmggeH36pfVUdDGyCcwmjT3AQPBj6"),
    poolFeeReceiver: pk("3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy"),
    lockProgram: pk("DRay25Usp3YJAi7beckgpGUC7mGJ2cR1AVPxhYfwVCUX"),
    lockAuthority: pk("7qWVV8UY2bRJfDLP4s37YzBPKUkVB46DStYJBpYbQzu3"),
  },
  "mainnet-beta": {
    cpmmProgram: pk("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"),
    ammConfig: null, // must be supplied via RAYDIUM_AMM_CONFIG
    poolFeeReceiver: pk("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8"),
    lockProgram: pk("LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE"),
    lockAuthority: pk("3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH"),
  },
};

export const RPC_URL: Record<ClusterName, string> = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export const METADATA_PROGRAM_ID = pk("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const MEMO_PROGRAM_ID = pk("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export function cluster(): ClusterName {
  const c = (process.env.CLUSTER ?? "devnet") as ClusterName;
  if (!["devnet", "mainnet-beta", "localnet"].includes(c)) throw new Error(`unknown CLUSTER ${c}`);
  return c;
}

export function rpcUrl(): string {
  return process.env.RPC_URL ?? RPC_URL[cluster()];
}

function envKey(name: string): PublicKey | undefined {
  const v = process.env[name];
  return v ? new PublicKey(v) : undefined;
}

/** Raydium addresses for the active cluster, with env overrides applied. */
export function raydium(): RaydiumAddresses {
  const c = cluster();
  const base = c === "localnet" ? RAYDIUM.devnet : RAYDIUM[c];
  return {
    cpmmProgram: envKey("RAYDIUM_CPMM_PROGRAM") ?? base.cpmmProgram,
    ammConfig: envKey("RAYDIUM_AMM_CONFIG") ?? base.ammConfig,
    poolFeeReceiver: envKey("RAYDIUM_POOL_FEE_RECEIVER") ?? base.poolFeeReceiver,
    lockProgram: envKey("RAYDIUM_LOCK_PROGRAM") ?? base.lockProgram,
    lockAuthority: envKey("RAYDIUM_LOCK_AUTHORITY") ?? base.lockAuthority,
  };
}

export function loadKeypair(path: string): Keypair {
  const p = path.startsWith("~") ? resolve(homedir(), path.slice(2)) : resolve(path);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}

/** Role keypairs. On devnet, launch authority and crank default to the admin wallet. */
export function roles() {
  const admin = loadKeypair(process.env.ADMIN_KEYPAIR ?? "~/.config/solana/id.json");
  const launchAuthority = process.env.LAUNCH_AUTHORITY_KEYPAIR ? loadKeypair(process.env.LAUNCH_AUTHORITY_KEYPAIR) : admin;
  const crank = process.env.CRANK_KEYPAIR ? loadKeypair(process.env.CRANK_KEYPAIR) : admin;
  const treasury = envKey("TREASURY") ?? admin.publicKey;
  return { admin, launchAuthority, crank, treasury };
}

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const DEXSCREENER_LISTING_USD = 299;

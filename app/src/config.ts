/**
 * Runtime configuration from Vite env vars (see app/README.md).
 *   VITE_PARABULL_MODE   "demo" (default): seeded demo data, simulated trades and launches
 *                        "chain": read and write the deployed program
 *   VITE_CLUSTER         devnet (default) | mainnet-beta | localnet
 *   VITE_RPC_URL         overrides the cluster's public RPC
 *   VITE_METADATA_UPLOAD_URL  backend that pins image + metadata JSON and returns { uri }
 *   VITE_REWARDS_BASE_URL     where epoch-<n>.json snapshot artifacts are served
 *   VITE_SENTINEL_URL         the X sentinel service (services/twitter-sentinel); unset, the X automation modal says it is off
 */
import { clusterApiUrl } from "@solana/web3.js";

export type Cluster = "devnet" | "mainnet-beta" | "localnet";

const env = import.meta.env;
const cluster = (env.VITE_CLUSTER ?? "devnet") as Cluster;

export const CONFIG = {
  mode: (env.VITE_PARABULL_MODE === "chain" ? "chain" : "demo") as "demo" | "chain",
  cluster,
  rpcUrl: env.VITE_RPC_URL ?? (cluster === "localnet" ? "http://127.0.0.1:8899" : clusterApiUrl(cluster)),
  metadataUploadUrl: env.VITE_METADATA_UPLOAD_URL as string | undefined,
  rewardsBaseUrl: env.VITE_REWARDS_BASE_URL as string | undefined,
  sentinelUrl: (env.VITE_SENTINEL_URL as string | undefined)?.replace(/\/$/, ""),
};

export const isDemo = CONFIG.mode === "demo";

export function explorer(kind: "token" | "account" | "tx", id: string): string {
  const q = cluster === "mainnet-beta" ? "" : cluster === "localnet" ? "?cluster=custom" : `?cluster=${cluster}`;
  return `https://solscan.io/${kind}/${id}${q}`;
}

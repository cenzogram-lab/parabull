/**
 * The `_headers` file for hosting the built app on the Internet Computer with the `@dfinity/static-site` recipe (the
 * certified-assets canister). That canister adds no security headers of its own, so the CSP and friends live here.
 * vite.config.ts writes the result into `dist/_headers` at build time, so `connect-src` always includes the endpoints
 * this build was configured with (RPC and its websocket, sentinel, metadata upload, rewards artifacts).
 *
 * Patterns match the stored file (asset key), not the visitor's URL: `/*` covers every file, and because client routes
 * are rewritten to `/index.html` (see public/_redirects), the `/index.html` block is what every route's HTML gets.
 */

/** web3.js's default RPC per cluster (clusterApiUrl), and the local validator for localnet. */
const CLUSTER_RPC: Record<string, string> = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

/** Hosted RPC providers a deployment may switch to without rebuilding the CSP (subscriptions included). */
const RPC_PROVIDERS = [
  "https://api.devnet.solana.com",
  "wss://api.devnet.solana.com",
  "https://api.mainnet-beta.solana.com",
  "wss://api.mainnet-beta.solana.com",
  "https://*.helius-rpc.com",
  "wss://*.helius-rpc.com",
  "https://*.quiknode.pro",
  "wss://*.quiknode.pro",
  // Triton One
  "https://*.rpcpool.com",
  "wss://*.rpcpool.com",
];

/** SOL/USD price APIs (src/lib/price.ts). */
const PRICE_APIS = ["https://lite-api.jup.ag", "https://api.coingecko.com"];

/** Wallets: Solflare's web wallet (iframe + API) and the Mobile Wallet Adapter's local socket to the wallet app. */
const WALLET_CONNECT = ["https://*.solflare.com", "ws://localhost:*", "ws://127.0.0.1:*"];
const WALLET_FRAMES = ["https://connect.solflare.com"];

/**
 * Internet Identity (Path A sign-in) and the IC API agent-js calls: the II sign-in page (id.ai, and the legacy
 * identity.ic0.app), and the boundary-node API hosts that carry delegation minting and the Chain Fusion signer
 * canister's calls (icp-api.io by default; icp0.io / ic0.app / icp.net gateway domains). II opens in a popup window, so
 * frame-src only matters if it is ever embedded; the popup's postMessage is not governed by the CSP, and no
 * Cross-Origin-Opener-Policy is set, which would cut the popup off from this page.
 */
const IDENTITY_CONNECT = ["https://id.ai", "https://identity.ic0.app", "https://icp-api.io", "https://icp0.io", "https://*.icp0.io", "https://ic0.app", "https://*.ic0.app", "https://*.icp.net"];
const IDENTITY_FRAMES = ["https://id.ai", "https://identity.ic0.app"];

/** Origin of a URL ("https://host:port"), or null when it isn't an absolute http(s) URL. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * The websocket endpoint web3.js derives from an RPC URL for subscriptions (makeWebsocketUrl): http→ws, https→wss,
 * and an explicit port moves up by one (8899 → 8900).
 */
export function rpcWebsocketOrigin(rpcUrl: string): string | null {
  try {
    const u = new URL(rpcUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const ws = new URL(rpcUrl);
    ws.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    if (u.port) ws.port = String(Number(u.port) + 1);
    return `${ws.protocol}//${ws.host}`;
  } catch {
    return null;
  }
}

export interface HeaderEnv {
  VITE_CLUSTER?: string;
  VITE_RPC_URL?: string;
  VITE_SENTINEL_URL?: string;
  VITE_METADATA_UPLOAD_URL?: string;
  VITE_REWARDS_BASE_URL?: string;
}

/** Every origin the app may fetch or open a socket to, for this build's configuration. */
export function connectSources(env: HeaderEnv): string[] {
  const rpc = env.VITE_RPC_URL || CLUSTER_RPC[env.VITE_CLUSTER ?? "devnet"] || CLUSTER_RPC.devnet;
  const configured = [originOf(rpc), rpcWebsocketOrigin(rpc), originOf(env.VITE_SENTINEL_URL), originOf(env.VITE_METADATA_UPLOAD_URL), originOf(env.VITE_REWARDS_BASE_URL)];
  return [...new Set(["'self'", ...configured.filter((s): s is string => !!s), ...RPC_PROVIDERS, ...PRICE_APIS, ...WALLET_CONNECT, ...IDENTITY_CONNECT])];
}

export function contentSecurityPolicy(env: HeaderEnv): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Tailwind's built CSS plus the inline style attributes React and the chart library set.
    "style-src 'self' 'unsafe-inline'",
    // Coin images come from each coin's metadata (IPFS/Arweave gateways, any https host); demo art is data: URIs.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSources(env).join(" ")}`,
    `frame-src ${[...WALLET_FRAMES, ...IDENTITY_FRAMES].join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The whole `_headers` file (Netlify syntax, read by the certified-assets sync plugin). */
export function headersFile(env: HeaderEnv): string {
  return [
    "# Generated by vite.config.ts from src/lib/icHeaders.ts at build time; edit that module, not this file.",
    "/*",
    "  X-Frame-Options: DENY",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()",
    `  Content-Security-Policy: ${contentSecurityPolicy(env)}`,
    "",
    "# Fingerprinted build output never changes: cache it hard.",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
    "# HTML revalidates so a deploy is picked up at once (every client route is served /index.html).",
    "/*.html",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "",
  ].join("\n");
}

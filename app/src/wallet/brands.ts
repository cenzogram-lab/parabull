/**
 * The two Solana wallets the connect dialog puts on its first screen, with their official icons and install pages.
 * Phantom registers through Wallet Standard (no adapter needed); its icon is the one @solana/wallet-adapter-phantom
 * 0.9.28 ships (Apache-2.0). Solflare's comes from the Solflare adapter the app already registers (App.tsx), so
 * `icon` is null here and the dialog reads it from that adapter.
 */

export type BrandName = "Phantom" | "Solflare";

export interface WalletBrand {
  name: BrandName;
  /** Official icon, or null to use the registered adapter's own. */
  icon: string | null;
  install: string;
  /** Whether the browser extension has injected itself (window.phantom / window.solana, window.solflare). */
  injected: () => boolean;
}

const PHANTOM_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiB2aWV3Qm94PSIwIDAgMTA4IDEwOCIgZmlsbD0ibm9uZSI+CjxyZWN0IHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiByeD0iMjYiIGZpbGw9IiNBQjlGRjIiLz4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik00Ni41MjY3IDY5LjkyMjlDNDIuMDA1NCA3Ni44NTA5IDM0LjQyOTIgODUuNjE4MiAyNC4zNDggODUuNjE4MkMxOS41ODI0IDg1LjYxODIgMTUgODMuNjU2MyAxNSA3NS4xMzQyQzE1IDUzLjQzMDUgNDQuNjMyNiAxOS44MzI3IDcyLjEyNjggMTkuODMyN0M4Ny43NjggMTkuODMyNyA5NCAzMC42ODQ2IDk0IDQzLjAwNzlDOTQgNTguODI1OCA4My43MzU1IDc2LjkxMjIgNzMuNTMyMSA3Ni45MTIyQzcwLjI5MzkgNzYuOTEyMiA2OC43MDUzIDc1LjEzNDIgNjguNzA1MyA3Mi4zMTRDNjguNzA1MyA3MS41NzgzIDY4LjgyNzUgNzAuNzgxMiA2OS4wNzE5IDY5LjkyMjlDNjUuNTg5MyA3NS44Njk5IDU4Ljg2ODUgODEuMzg3OCA1Mi41NzU0IDgxLjM4NzhDNDcuOTkzIDgxLjM4NzggNDUuNjcxMyA3OC41MDYzIDQ1LjY3MTMgNzQuNDU5OEM0NS42NzEzIDcyLjk4ODQgNDUuOTc2OCA3MS40NTU2IDQ2LjUyNjcgNjkuOTIyOVpNODMuNjc2MSA0Mi41Nzk0QzgzLjY3NjEgNDYuMTcwNCA4MS41NTc1IDQ3Ljk2NTggNzkuMTg3NSA0Ny45NjU4Qzc2Ljc4MTYgNDcuOTY1OCA3NC42OTg5IDQ2LjE3MDQgNzQuNjk4OSA0Mi41Nzk0Qzc0LjY5ODkgMzguOTg4NSA3Ni43ODE2IDM3LjE5MzEgNzkuMTg3NSAzNy4xOTMxQzgxLjU1NzUgMzcuMTkzMSA4My42NzYxIDM4Ljk4ODUgODMuNjc2MSA0Mi41Nzk0Wk03MC4yMTAzIDQyLjU3OTVDNzAuMjEwMyA0Ni4xNzA0IDY4LjA5MTYgNDcuOTY1OCA2NS43MjE2IDQ3Ljk2NThDNjMuMzE1NyA0Ny45NjU4IDYxLjIzMyA0Ni4xNzA0IDYxLjIzMyA0Mi41Nzk1QzYxLjIzMyAzOC45ODg1IDYzLjMxNTcgMzcuMTkzMSA2NS43MjE2IDM3LjE5MzFDNjguMDkxNiAzNy4xOTMxIDcwLjIxMDMgMzguOTg4NSA3MC4yMTAzIDQyLjU3OTVaIiBmaWxsPSIjRkZGREY4Ii8+Cjwvc3ZnPg==";

type Injected = { phantom?: { solana?: { isPhantom?: boolean } }; solana?: { isPhantom?: boolean }; solflare?: { isSolflare?: boolean } };
const win = () => (typeof window === "undefined" ? {} : (window as unknown as Injected));

/**
 * Whether the dialog may offer a brand as a one-click connect: only when the wallet adapter context has a wallet of
 * that name to select (`readyState`: its Wallet Standard registration or adapter), and that wallet is installed or
 * its extension has injected itself (`injected`, which covers an adapter that hasn't noticed the extension yet).
 * An injected provider with no registered wallet (an old Phantom, or another wallet copying `isPhantom` for
 * compatibility) has nothing `select()` could connect, so it gets the install link instead.
 */
export function brandConnectable(readyState: string | undefined, injected: boolean): boolean {
  if (readyState === undefined || readyState === "Unsupported") return false;
  return readyState === "Installed" || injected;
}

export const WALLET_BRANDS: readonly WalletBrand[] = [
  { name: "Phantom", icon: PHANTOM_ICON, install: "https://phantom.com/download", injected: () => !!(win().phantom?.solana?.isPhantom || win().solana?.isPhantom) },
  { name: "Solflare", icon: null, install: "https://solflare.com/download", injected: () => !!win().solflare?.isSolflare },
];

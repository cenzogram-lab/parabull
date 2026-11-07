/** Where a graduated coin trades and is charted after it leaves the bonding curve (Raydium CPMM, then DexScreener). */
export const raydiumSwapUrl = (mint: string) => `https://raydium.io/swap/?inputMint=sol&outputMint=${encodeURIComponent(mint)}`;
export const dexScreenerUrl = (mint: string) => `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;

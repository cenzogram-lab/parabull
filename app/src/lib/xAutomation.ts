/** Rules for the X automation modal that don't need React, so they can be tested directly. */

export interface SaveGate {
  /** Demo build: the coin was simulated in this browser and has no curve on-chain. */
  demo: boolean;
  /** The sentinel answered with this coin's status. */
  ready: boolean;
  ticker: string;
  /** The connected wallet, if any. */
  signer: string | null;
  /**
   * The connected wallet is the coin's creator. In chain mode that is the `creator` recorded on the coin's on-chain
   * bonding curve (the same check that shows the button), never the coin list, which is still demo data.
   */
  isCreator: boolean;
  canSignMessages: boolean;
}

/** Why the modal can't save, or null when it can. The sentinel re-checks the on-chain creator on every signed change. */
export function saveBlocker(g: SaveGate): string | null {
  if (g.demo) return `$${g.ticker} is a demo coin, simulated in this browser, so the sentinel has no on-chain curve to watch. X automation saves for coins launched on-chain (chain mode).`;
  if (!g.ready) return null;
  if (!g.signer) return `Connect the wallet that launched $${g.ticker} to save.`;
  if (!g.isCreator) return `Only the wallet that launched $${g.ticker} can change this.`;
  if (!g.canSignMessages) return "This wallet can't sign messages.";
  return null;
}

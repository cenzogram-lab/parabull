/**
 * One signing interface whichever way the user connected: a browser wallet (Phantom, Solflare, Backpack), an imported
 * key, or Internet Identity through the Chain Fusion signer. All three are wallet adapters under WalletProvider, so this
 * is a thin view over `useWallet()` that adds which kind is active and throws clear errors when nothing is connected.
 */
import { useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { AnyTransaction } from "../lib/wallet/signing";
import { walletTypeOf, type WalletType } from "./adapters";

export interface UnifiedWallet {
  publicKey: PublicKey | null;
  connected: boolean;
  walletType: WalletType | null;
  /** The adapter's name ("Phantom", "Imported key", "Internet Identity", ...). */
  walletName: string | null;
  signTransaction<T extends AnyTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends AnyTransaction>(txs: T[]): Promise<T[]>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  disconnect(): Promise<void>;
}

export const UnifiedWalletContext = createContext<UnifiedWallet | null>(null);

const notConnected = () => Promise.reject(new Error("Connect a wallet first"));

export function UnifiedWalletProvider({ children }: { children: ReactNode }) {
  const { publicKey, connected, wallet, signTransaction, signAllTransactions, signMessage, disconnect } = useWallet();
  const name = wallet?.adapter.name ?? null;
  const value = useMemo<UnifiedWallet>(
    () => ({
      publicKey: connected ? publicKey : null,
      connected,
      walletType: connected ? walletTypeOf(name) : null,
      walletName: connected ? name : null,
      signTransaction: <T extends AnyTransaction>(tx: T) => (connected && signTransaction ? (signTransaction(tx) as Promise<T>) : notConnected()),
      signAllTransactions: <T extends AnyTransaction>(txs: T[]) => (connected && signAllTransactions ? (signAllTransactions(txs) as Promise<T[]>) : notConnected()),
      signMessage: (m: Uint8Array) => (connected && signMessage ? signMessage(m) : notConnected()),
      disconnect,
    }),
    [publicKey, connected, name, signTransaction, signAllTransactions, signMessage, disconnect],
  );
  return <UnifiedWalletContext.Provider value={value}>{children}</UnifiedWalletContext.Provider>;
}

export function useUnifiedWallet(): UnifiedWallet {
  const v = useContext(UnifiedWalletContext);
  if (!v) throw new Error("useUnifiedWallet outside UnifiedWalletProvider");
  return v;
}

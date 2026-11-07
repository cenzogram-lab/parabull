/**
 * The app's own two wallets, as standard wallet adapters so every existing caller (useWallet, useAnchorWallet,
 * signMessage for the X sentinel, the header button) works with them unchanged:
 * - ImportedKeyAdapter (Path B): a pasted private key held in this tab's memory; signs with no popup.
 * - InternetIdentityAdapter (Path A): Internet Identity sign-in, Solana signatures from the Chain Fusion signer
 *   canister (or the development key; see lib/auth/iiConfig.ts).
 * Browser wallets (Phantom, Solflare, Backpack) still come from Wallet Standard and the Solflare adapter.
 */
import {
  BaseMessageSignerWalletAdapter,
  WalletConnectionError,
  WalletNotConnectedError,
  WalletNotReadyError,
  WalletReadyState,
  type TransactionOrVersionedTransaction,
  type WalletName,
} from "@solana/wallet-adapter-base";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { CONFIG, isDemo } from "../config";
import type { SolanaSigner } from "../lib/auth/chainFusionSigner";
import { resolveIiMode, type IiMode } from "../lib/auth/iiConfig";
import { ImportedSigner } from "../lib/wallet/importedKey";

export const IMPORTED_WALLET_NAME = "Imported key" as WalletName<"Imported key">;
export const II_WALLET_NAME = "Internet Identity" as WalletName<"Internet Identity">;

const svg = (body: string) => `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#E5A967" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`)}`;
const KEY_ICON = svg('<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2m-3 3 3 3m-6 0 3 3"/>');
const II_ICON = svg('<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>');

/** wallet-adapter-react stores the selected wallet's name under this key (its default). */
const WALLET_NAME_KEY = "walletName";

type Tx = TransactionOrVersionedTransaction<ReadonlySet<"legacy" | 0>>;

export class ImportedKeyAdapter extends BaseMessageSignerWalletAdapter {
  name = IMPORTED_WALLET_NAME;
  url = "https://docs.solana.com/wallet-guide";
  icon = KEY_ICON;
  supportedTransactionVersions: ReadonlySet<"legacy" | 0> = new Set(["legacy", 0] as const);
  #signer: ImportedSigner | null = null;

  constructor() {
    super();
    // The key never survives a reload, so don't let the provider try to reconnect a wallet that is gone.
    try {
      if (localStorage.getItem(WALLET_NAME_KEY) === JSON.stringify(IMPORTED_WALLET_NAME)) localStorage.removeItem(WALLET_NAME_KEY);
    } catch {
      // storage unavailable: nothing to clear
    }
  }

  get publicKey(): PublicKey | null {
    return this.#signer?.publicKey ?? null;
  }
  get connecting() {
    return false;
  }
  get readyState() {
    return this.#signer ? WalletReadyState.Installed : WalletReadyState.NotDetected;
  }

  /** Hold this key (replacing any other); `connect` then succeeds at once. */
  load(keypair: Keypair) {
    this.#signer?.clear();
    this.#signer = new ImportedSigner(keypair);
    this.emit("readyStateChange", WalletReadyState.Installed);
  }

  async connect(): Promise<void> {
    if (!this.#signer) throw new WalletNotReadyError("Import a private key first");
    this.emit("connect", this.#signer.publicKey);
  }

  /** Forget the key: after disconnecting, the only way back is to paste it again. */
  async disconnect(): Promise<void> {
    const had = !!this.#signer;
    this.#signer?.clear();
    this.#signer = null;
    this.emit("readyStateChange", WalletReadyState.NotDetected);
    if (had) this.emit("disconnect");
  }

  #require(): ImportedSigner {
    if (!this.#signer) throw new WalletNotConnectedError();
    return this.#signer;
  }
  async signTransaction<T extends Tx>(tx: T): Promise<T> {
    return this.#require().signTransaction(tx);
  }
  async signAllTransactions<T extends Tx>(txs: T[]): Promise<T[]> {
    const s = this.#require();
    return txs.map((tx) => s.signTransaction(tx));
  }
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return this.#require().signBytes(message);
  }
}

type IiModule = typeof import("../lib/auth/internetIdentity");

export class InternetIdentityAdapter extends BaseMessageSignerWalletAdapter {
  name = II_WALLET_NAME;
  url = "https://id.ai";
  icon = II_ICON;
  supportedTransactionVersions: ReadonlySet<"legacy" | 0> = new Set(["legacy", 0] as const);
  readonly mode: IiMode;
  #signer: SolanaSigner | null = null;
  #connecting = false;
  #module: IiModule | null = null;
  #loading: Promise<IiModule> | null = null;

  constructor(mode: IiMode) {
    super();
    this.mode = mode;
  }

  get publicKey(): PublicKey | null {
    return this.#signer?.publicKey ?? null;
  }
  get connecting() {
    return this.#connecting;
  }
  get readyState() {
    return this.mode.kind === "off" ? WalletReadyState.Unsupported : WalletReadyState.Loadable;
  }
  /** "canister" or "mock" once signed in: whether a real signer canister or the development key signs. */
  get signerKind(): SolanaSigner["kind"] | null {
    return this.#signer?.kind ?? null;
  }
  /** True once the SDK has loaded, so `signInInteractive` can open the popup synchronously. */
  get ready() {
    return this.#module !== null;
  }

  /** Load the ICP SDK (and create the AuthClient) ahead of the click. */
  preload(): Promise<IiModule> {
    this.#loading ??= import("../lib/auth/internetIdentity").then((m) => {
      if (this.mode.kind !== "offline") m.prepare();
      this.#module = m;
      return m;
    });
    return this.#loading;
  }

  /**
   * The user's click: opens Internet Identity synchronously (Safari blocks a popup opened after an await), then
   * derives the Solana address. Offline builds skip II and use a local test principal.
   */
  signInInteractive(): Promise<void> {
    const m = this.#module;
    if (this.mode.kind === "off") return Promise.reject(new WalletNotReadyError(this.mode.reason));
    if (!m) return Promise.reject(new WalletNotReadyError("Internet Identity is still loading; try again in a moment"));
    this.#connecting = true;
    const signedIn = this.mode.kind === "offline" ? Promise.resolve() : m.beginSignIn();
    return signedIn
      .then(() => this.#finish(m, this.mode.kind === "offline" ? m.offlinePrincipal() : m.currentPrincipal()))
      .finally(() => (this.#connecting = false));
  }

  async #finish(m: IiModule, principal: ReturnType<IiModule["currentPrincipal"]>) {
    if (!principal) throw new WalletConnectionError("Internet Identity sign-in didn't complete");
    try {
      this.#signer = await m.signerFor(this.mode, principal);
    } catch (e) {
      throw new WalletConnectionError(e instanceof Error ? e.message : String(e));
    }
    this.emit("connect", this.#signer.publicKey);
  }

  /** Non-interactive (the provider after a reload, or after select): restores a held session, never opens a popup. */
  async connect(): Promise<void> {
    // Already signed in (the dialog signs in first, then selects this wallet): announce it, since the provider only
    // learns about a connection from the `connect` event.
    if (this.#signer) return void this.emit("connect", this.#signer.publicKey);
    if (this.mode.kind === "off") throw new WalletNotReadyError(this.mode.reason);
    this.#connecting = true;
    try {
      const m = await this.preload();
      const principal = this.mode.kind === "offline" ? (hasOfflineSession() ? m.offlinePrincipal() : null) : m.currentPrincipal();
      if (!principal) throw new WalletNotReadyError("Sign in with Internet Identity first");
      await this.#finish(m, principal);
    } finally {
      this.#connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    const had = !!this.#signer;
    this.#signer = null;
    const m = this.#module;
    if (m) {
      if (this.mode.kind === "offline") m.clearOffline();
      else await m.signOut().catch(() => undefined);
    }
    if (had) this.emit("disconnect");
  }

  #require(): SolanaSigner {
    if (!this.#signer) throw new WalletNotConnectedError();
    return this.#signer;
  }
  async signTransaction<T extends Tx>(tx: T): Promise<T> {
    return this.#require().signTransaction(tx);
  }
  async signAllTransactions<T extends Tx>(txs: T[]): Promise<T[]> {
    return this.#require().signAllTransactions(txs);
  }
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return this.#require().signBytes(message);
  }
}

function hasOfflineSession() {
  try {
    return !!sessionStorage.getItem("parabull:ii-offline-principal");
  } catch {
    return false;
  }
}

/** One of each for the page; App passes them to WalletProvider and ConnectModal drives them. */
export const importedKeyAdapter = new ImportedKeyAdapter();
export const internetIdentityAdapter = new InternetIdentityAdapter(
  resolveIiMode({ canisterId: CONFIG.iiSignerCanisterId, isDemo, cluster: CONFIG.cluster, dev: import.meta.env.DEV }),
);

export type WalletType = "native" | "imported" | "internet_identity";

export const walletTypeOf = (name: string | null | undefined): WalletType | null =>
  !name ? null : name === IMPORTED_WALLET_NAME ? "imported" : name === II_WALLET_NAME ? "internet_identity" : "native";

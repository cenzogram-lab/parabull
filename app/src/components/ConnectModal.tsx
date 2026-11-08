/**
 * The app's connect dialog, in place of the wallet adapter's own modal (it provides the same WalletModalContext, so
 * every `useWalletModal().setVisible(true)` and the header's wallet button open it). Two paths:
 * - Path A: "Continue with Google / Passkey / Email" signs in with Internet Identity; a Chain Fusion signer canister
 *   holds the Solana key (wallet/adapters.ts, lib/auth/*).
 * - Path B, on the same first screen: Phantom and Solflare as dedicated buttons (one click when the extension is
 *   detected, otherwise a link to install it), "Import Private Key (Ephemeral)" (a key held in this tab's memory), and
 *   any other detected wallet below.
 * A dialog on desktop, a bottom sheet on a phone. `data-wallet-picker` marks it for the dialogs it can open over.
 */
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletModalContext } from "@solana/wallet-adapter-react-ui";
import { ArrowUpRight, ChevronDown, Fingerprint, KeyRound, Loader2, ShieldCheck, TriangleAlert, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useIsMobile } from "../hooks/useMediaQuery";
import { parseSecretKey } from "../lib/wallet/importedKey";
import { useApp } from "../state/AppState";
import { II_WALLET_NAME, IMPORTED_WALLET_NAME, importedKeyAdapter, internetIdentityAdapter } from "../wallet/adapters";
import { brandConnectable, WALLET_BRANDS, type WalletBrand } from "../wallet/brands";
import { BottomSheet } from "./mobile/MobileUi";
import { Modal } from "./ui/overlay";
import { cx } from "./ui/primitives";

/** Terminal palette for this dialog (canvas, surface, hairline, text). */
const T = { canvas: "bg-[#0D0C0B]", surface: "bg-[#161514]", border: "border-[#2A2724]", text: "text-[#F5F2EB]" };

export function ConnectModalProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const value = useMemo(() => ({ visible, setVisible }), [visible]);
  return (
    <WalletModalContext.Provider value={value}>
      {children}
      <ConnectModal open={visible} onClose={() => setVisible(false)} />
    </WalletModalContext.Provider>
  );
}

function ConnectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const isMobile = useIsMobile();
  const body = open ? <ConnectBody onDone={onClose} /> : null;
  if (isMobile)
    return (
      <BottomSheet open={open} onClose={onClose} title="Connect to Parabull">
        <div data-wallet-picker className="px-4 pb-4">
          {body}
        </div>
      </BottomSheet>
    );
  return (
    <Modal open={open} onClose={onClose} label="Connect to Parabull" className="max-w-[420px] !rounded-2xl !border-[#2A2724] !bg-[#161514]">
      <div data-wallet-picker className={cx("p-6", T.text)}>
        <h2 className="pr-8 text-[19px] font-semibold tracking-tight">Connect to Parabull</h2>
        <p className="mt-1 text-[13px] text-muted">Trade, launch and claim with any of these.</p>
        <div className="mt-5">{body}</div>
      </div>
    </Modal>
  );
}

function ConnectBody({ onDone }: { onDone: () => void }) {
  const { wallets, select } = useWallet();
  const { toast } = useApp();
  const ii = internetIdentityAdapter;
  const [iiReady, setIiReady] = useState(ii.ready);
  const [busy, setBusy] = useState<"ii" | "key" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the ICP SDK as soon as the dialog opens, so the click can open Internet Identity synchronously.
  useEffect(() => {
    if (ii.mode.kind === "off" || ii.ready) return;
    let live = true;
    ii.preload().then(
      () => live && setIiReady(true),
      (e) => live && setError(`Internet Identity didn't load: ${e instanceof Error ? e.message : String(e)}`),
    );
    return () => {
      live = false;
    };
  }, [ii]);

  const continueWithII = useCallback(() => {
    setError(null);
    setBusy("ii");
    // No await before this call: it opens the II popup, which browsers only allow straight from the click.
    ii.signInInteractive().then(
      () => {
        select(II_WALLET_NAME);
        toast({ tone: "good", title: "Signed in with Internet Identity", body: ii.publicKey ? `Solana address ${ii.publicKey.toBase58().slice(0, 4)}…${ii.publicKey.toBase58().slice(-4)}` : undefined });
        setBusy(null);
        onDone();
      },
      (e: unknown) => {
        setBusy(null);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  }, [ii, select, toast, onDone]);

  const pick = (name: WalletName) => {
    select(name);
    onDone();
  };
  const brandNames: readonly string[] = WALLET_BRANDS.map((b) => b.name);
  const installed = (name: string) => wallets.some((w) => w.adapter.name === name && w.readyState === WalletReadyState.Installed);
  // Other usable wallets: anything detected besides Phantom and Solflare (Backpack, Mobile Wallet Adapter, ...), plus
  // Solflare's web wallet when its extension isn't there (it needs no install). An injected extension the adapter hasn't
  // noticed yet already makes the Solflare button one click, so it isn't listed a second time as the web wallet.
  const otherWallets = wallets.filter((w) => {
    const name = w.adapter.name;
    if (name === IMPORTED_WALLET_NAME || name === II_WALLET_NAME) return false;
    if (w.readyState !== WalletReadyState.Installed && w.readyState !== WalletReadyState.Loadable) return false;
    if (!brandNames.includes(name)) return true;
    const brand = WALLET_BRANDS.find((b) => b.name === name)!;
    return name === "Solflare" && w.readyState === WalletReadyState.Loadable && !installed(name) && !brandConnectable(w.readyState, brand.injected());
  });

  const iiOff = ii.mode.kind === "off";
  const iiNote =
    ii.mode.kind === "off"
      ? ii.mode.reason
      : ii.mode.kind === "offline"
        ? "Offline build: a local test identity stands in for Internet Identity."
        : ii.mode.kind === "mock-signer"
          ? "No signer canister configured: a development key derived from your principal signs. Don't fund it."
          : null;

  return (
    <div>
      {/* Path A */}
      <button
        type="button"
        onClick={continueWithII}
        disabled={iiOff || !iiReady || busy !== null}
        className="btn h-12 w-full gap-2 rounded-xl border border-[#E5A967]/60 bg-[#E5A967] text-[15px] text-[#0D0C0B] hover:bg-[#F0BA7E] disabled:border-[#2A2724] disabled:bg-[#1F1D1B] disabled:text-muted"
      >
        {busy === "ii" || (!iiReady && !iiOff) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
        Continue with Google / Passkey / Email
      </button>
      <p className="mt-2 flex items-center justify-center gap-1.5 text-[12px] text-muted">
        <ShieldCheck className="h-3.5 w-3.5 text-[#E5A967]" aria-hidden /> Secured by Internet Identity · Zero seed phrases
      </p>
      {iiNote && <p className="mt-1.5 text-center text-[11.5px] leading-4 text-muted">{iiNote}</p>}

      <div className="my-5 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted" aria-hidden>
        <span className={cx("h-px flex-1 border-t", T.border)} /> or <span className={cx("h-px flex-1 border-t", T.border)} />
      </div>

      {/* Path B: Phantom and Solflare, one click each */}
      <ul className="grid grid-cols-2 gap-2" aria-label="Solana wallets">
        {WALLET_BRANDS.map((b) => {
          const entry = wallets.find((w) => w.adapter.name === b.name);
          return (
            <li key={b.name}>
              <BrandButton brand={b} icon={b.icon ?? entry?.adapter.icon ?? ""} detected={brandConnectable(entry?.readyState, b.injected())} onConnect={() => pick(b.name as WalletName)} />
            </li>
          );
        })}
      </ul>

      <ImportKey busy={busy === "key"} onImported={onDone} onError={setError} setBusy={(b) => setBusy(b ? "key" : null)} />

      {otherWallets.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Other wallets</p>
          <ul className="grid gap-2" aria-label="Other wallets">
            {otherWallets.map((w) => (
              <li key={w.adapter.name}>
                <button
                  type="button"
                  onClick={() => pick(w.adapter.name)}
                  className={cx("flex h-12 w-full items-center gap-3 rounded-xl border px-3 text-left transition-colors hover:border-[#E5A967]/50", T.canvas, T.border, T.text)}
                >
                  <img src={w.adapter.icon} alt="" className="h-7 w-7 rounded-md" />
                  <span className="flex-1 text-[14px] font-medium">{w.readyState === WalletReadyState.Installed ? w.adapter.name : `${w.adapter.name} web wallet`}</span>
                  <span className="text-[11.5px] text-muted">{w.readyState === WalletReadyState.Installed ? "Detected" : "No install needed"}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 flex gap-2 rounded-lg border border-ember/40 bg-ember/10 px-3 py-2 text-[12.5px] leading-5 text-ember">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error}
        </p>
      )}
    </div>
  );
}

/**
 * A dedicated button in the wallet's own colours: connects in one click when its extension is detected, otherwise
 * opens its install page in a new tab.
 */
function BrandButton({ brand, icon, detected, onConnect }: { brand: WalletBrand; icon: string; detected: boolean; onConnect: () => void }) {
  const tone = brand.name === "Phantom" ? "bg-[#AB9FF2] hover:bg-[#BDB3F5] text-[#1C1C1C]" : "bg-[#FFEF46] hover:bg-[#FFF37A] text-[#1C1C1C]";
  const inner = (
    <>
      {icon && <img src={icon} alt="" className="h-8 w-8 shrink-0 rounded-lg ring-1 ring-black/10" />}
      <span className="min-w-0 flex-1 text-left leading-tight">
        <span className="block text-[15px] font-bold">{brand.name}</span>
        <span className="mt-0.5 flex items-center gap-1 text-[11.5px] font-semibold opacity-75">
          {detected ? (
            <>
              <Zap className="h-3 w-3" aria-hidden /> Detected · 1-click
            </>
          ) : (
            <>
              Install <ArrowUpRight className="h-3 w-3" aria-hidden />
            </>
          )}
        </span>
      </span>
    </>
  );
  const cls = cx("flex h-14 w-full items-center gap-2.5 rounded-xl px-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E5A967]", tone);
  return detected ? (
    <button type="button" onClick={onConnect} aria-label={`Connect ${brand.name}`} className={cls}>
      {inner}
    </button>
  ) : (
    <a href={brand.install} target="_blank" rel="noreferrer" aria-label={`Install ${brand.name} (opens a new tab)`} className={cls}>
      {inner}
    </a>
  );
}

function ImportKey({ busy, onImported, onError, setBusy }: { busy: boolean; onImported: () => void; onError: (e: string | null) => void; setBusy: (b: boolean) => void }) {
  const { select } = useWallet();
  const { toast } = useApp();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);

  const submit = () => {
    onError(null);
    const parsed = parseSecretKey(value);
    setValue("");
    if (!parsed.ok) return setFieldError(parsed.error);
    setFieldError(null);
    setBusy(true);
    importedKeyAdapter.load(parsed.keypair);
    select(IMPORTED_WALLET_NAME);
    const address = parsed.keypair.publicKey.toBase58();
    toast({ tone: "good", title: "Key imported for this tab", body: `${address.slice(0, 4)}…${address.slice(-4)} signs without popups until you disconnect or close the tab` });
    setBusy(false);
    onImported();
  };

  return (
    <div className={cx("mt-3 rounded-xl border", T.canvas, T.border)}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={cx("flex min-h-12 w-full items-center gap-3 px-3 text-left", T.text)}>
        <KeyRound className="h-5 w-5 shrink-0 text-[#E5A967]" aria-hidden />
        <span className="flex-1">
          <span className="block text-[14px] font-medium">Import Private Key (Ephemeral)</span>
          <span className="block text-[11.5px] text-muted">Paste a Base58 key · signs without popups</span>
        </span>
        <ChevronDown className={cx("h-4 w-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <form
          className="px-3 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="flex gap-2 rounded-lg border border-[#E5A967]/30 bg-[#E5A967]/[0.06] px-2.5 py-2 text-[12px] leading-5 text-muted">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#E5A967]" aria-hidden />
            <span>
              <span className="font-semibold text-cream">Disposable, memory-only wallet.</span> The key is never saved: reloading or closing this tab forgets it. It signs every
              transaction without asking, so use a burner with a small balance, never your main wallet.
            </span>
          </p>
          <label className="mt-2 block">
            <span className="sr-only">Private key</span>
            <input
              type="password"
              value={value}
              onChange={(e) => (setValue(e.target.value), setFieldError(null))}
              placeholder="Paste Base58 private key"
              autoComplete="off"
              autoFocus
              spellCheck={false}
              aria-invalid={!!fieldError}
              className={cx("input font-mono text-[13px]", T.surface, T.border)}
            />
          </label>
          {fieldError && <p className="mt-1 text-[12px] text-ember">{fieldError}</p>}
          <button type="submit" disabled={!value.trim() || busy} className="btn-gold mt-3 h-11 w-full">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Import & Start Trading
          </button>
        </form>
      )}
    </div>
  );
}

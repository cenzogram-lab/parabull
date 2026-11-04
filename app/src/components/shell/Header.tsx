import { BaseWalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { ChevronLeft, FlaskConical, Plus, Search } from "lucide-react";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CONFIG, isDemo } from "../../config";
import { useApp } from "../../state/AppState";

const WALLET_LABELS = {
  "change-wallet": "Change wallet",
  connecting: "Connecting…",
  "copy-address": "Copy address",
  copied: "Copied",
  disconnect: "Disconnect",
  "has-wallet": "Connect wallet",
  "no-wallet": "Connect wallet",
} as const;

export function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setSearchOpen } = useApp();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSearchOpen]);

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-canvas/95 px-4 backdrop-blur">
      <button onClick={() => navigate(-1)} className="btn-icon" aria-label="Back">
        <ChevronLeft className="h-5 w-5" />
      </button>
      <div className="flex flex-1 justify-center">
        <button onClick={() => setSearchOpen(true)} className="group flex h-10 w-full max-w-[560px] items-center gap-3 rounded-full border border-line bg-surface px-4 text-left text-[13.5px] text-muted transition-colors hover:border-line-accent">
          <Search className="h-4 w-4 text-muted group-hover:text-copper" />
          <span className="flex-1 truncate">Search for coins, tickers, or creators...</span>
          <span className="kbd">⌘K</span>
        </button>
      </div>
      <div className="flex items-center gap-2">
        {isDemo ? (
          <span title="Seeded demo data and simulated trades. Set VITE_PARABULL_MODE=chain to use the deployed program." className="hidden items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11.5px] font-medium text-muted xl:inline-flex">
            <FlaskConical className="h-3.5 w-3.5 text-rosebronze" />
            Demo data
          </span>
        ) : (
          <span className="hidden rounded-full border border-line px-2.5 py-1 text-[11.5px] font-medium text-muted xl:inline-flex">{CONFIG.cluster}</span>
        )}
        <button onClick={() => navigate("/create", { state: { background: location } })} className="btn-copper h-9 px-3.5 text-[13.5px]">
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          Start a Coin
        </button>
        <BaseWalletMultiButton labels={WALLET_LABELS} />
      </div>
    </header>
  );
}

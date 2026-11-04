import { Send } from "lucide-react";
import { isDemo } from "../../config";
import { useMarket } from "../../state/Market";
import { XLogo } from "../brand/Wordmark";

export function Footer() {
  const { solUsd } = useMarket();
  return (
    // Grows by the bottom safe area, so a phone in landscape keeps the links clear of the home indicator (env() is 0 in desktop browsers).
    <footer className="hidden md:flex h-[calc(2.5rem+env(safe-area-inset-bottom))] shrink-0 items-center gap-6 border-t border-line bg-canvas px-5 pb-[env(safe-area-inset-bottom)] text-[12.5px] text-muted">
      <span>© 2026 Parabull</span>
      <span className="num">SOL ${solUsd.toFixed(2)}</span>
      <span className="text-muted/80">
        {isDemo ? "Demo data: prices, trades and traders are simulated" : "Lists and charts use demo data until the indexer API is connected; launches, trades and claims go on-chain"}
      </span>
      <nav className="ml-auto flex items-center gap-5">
        <a href="https://github.com/cenzogram-lab/parabull/blob/main/AGENTS.md" className="hover:text-cream">
          How it works
        </a>
        <a href="https://github.com/cenzogram-lab/parabull/blob/main/docs/BACKEND_SPEC.md" className="hover:text-cream">
          Launch protections
        </a>
        <span className="flex items-center gap-3">
          <XLogo className="h-3.5 w-3.5 hover:text-cream" />
          <Send className="h-3.5 w-3.5 hover:text-cream" aria-label="Telegram" />
        </span>
      </nav>
    </footer>
  );
}

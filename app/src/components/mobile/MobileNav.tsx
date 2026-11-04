import { Search, Target, Trophy, Wallet, type LucideIcon } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { BullGlyph } from "../brand/BullGlyph";
import { cx } from "../ui/primitives";

type Item = { to: string; label: string; icon: LucideIcon | "bull"; match: (path: string) => boolean; fill?: number };

const under = (base: string) => (path: string) => path === base || path.startsWith(`${base}/`);

/**
 * Lucide outlines get a solid fill when active; where a solid fill would
 * swallow the inner lines (the target's rings, the wallet's fold, the
 * lens), a translucent one keeps the glyph readable.
 */
const ITEMS: Item[] = [
  { to: "/", label: "Board", icon: "bull", match: (p) => p === "/" || under("/board")(p) || p.startsWith("/coin/") },
  { to: "/explore", label: "Explore", icon: Target, match: under("/explore"), fill: 0.3 },
  { to: "/leaderboard", label: "Leaderboard", icon: Trophy, match: under("/leaderboard"), fill: 1 },
  { to: "/portfolio", label: "Portfolio", icon: Wallet, match: under("/portfolio"), fill: 0.3 },
  { to: "/search", label: "Search", icon: Search, match: under("/search"), fill: 0.3 },
];

/** Floating bottom dock (below md): five 48px targets, the active one in gold with a soft glow. */
export function MobileNav() {
  const { pathname } = useLocation();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-4 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-50 flex h-14 items-center justify-between rounded-full border border-line bg-canvas/95 px-5 shadow-[0_8px_32px_rgba(0,0,0,0.8)] backdrop-blur-md md:hidden"
    >
      {ITEMS.map(({ to, label, icon: Icon, match, fill }) => {
        const active = match(pathname);
        return (
          <Link
            key={to}
            to={to}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={cx(
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition-colors duration-100 ease-out",
              active ? "text-gold drop-shadow-[0_0_8px_rgba(229,169,103,0.4)]" : "text-muted active:text-cream",
            )}
          >
            {Icon === "bull" ? (
              <BullGlyph size={27} filled={active} />
            ) : (
              <Icon className="h-6 w-6" strokeWidth={1.9} fill={active ? "currentColor" : "none"} fillOpacity={active ? fill : undefined} aria-hidden />
            )}
          </Link>
        );
      })}
    </nav>
  );
}

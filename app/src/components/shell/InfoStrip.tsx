import { History, Trophy, UserCheck, Wallet, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { compact, pct, usdCompact, usdSigned } from "../../lib/format";
import { useApp, type QuickInfo } from "../../state/AppState";
import { useMarket } from "../../state/Market";
import { cx } from "../ui/primitives";

const TOGGLES: { id: QuickInfo; label: string; icon: LucideIcon }[] = [
  { id: "traders", label: "Top traders", icon: Trophy },
  { id: "positions", label: "Open positions", icon: Wallet },
  { id: "following", label: "Following", icon: UserCheck },
  { id: "recent", label: "Recently viewed", icon: History },
];

export function InfoStrip() {
  const { quickInfo, setQuickInfo, recent } = useApp();
  const { traders, coins, byMint, positions, liveTrades } = useMarket();

  let items: ReactNode[] = [];
  if (quickInfo === "traders") {
    items = [...traders]
      .sort((a, b) => b.pnl["1D"] - a.pnl["1D"])
      .slice(0, 14)
      .map((t) => (
        <Link key={t.handle} to="/leaderboard" className="flex items-center gap-2 whitespace-nowrap">
          <img src={t.avatar} alt="" className="h-[18px] w-[18px] rounded-full" />
          <span className="font-medium text-cream">@{t.handle}</span>
          <span className="num font-semibold text-gold">{usdSigned(t.pnl["1D"])}</span>
        </Link>
      ));
  } else if (quickInfo === "positions") {
    items = Object.entries(positions)
      .filter(([, p]) => p.tokens > 0n)
      .map(([mint, p]) => {
        const c = byMint.get(mint);
        if (!c) return null;
        const value = (Number(p.tokens) / 1e6) * c.priceUsd;
        const change = value / Math.max(p.costUsd, 1e-9) - 1;
        return (
          <Link key={mint} to={`/coin/${mint}`} className="flex items-center gap-2 whitespace-nowrap">
            <img src={c.image} alt="" className="h-[18px] w-[18px] rounded" />
            <span className="font-medium text-cream">${c.ticker}</span>
            <span className="num text-muted">{usdCompact(value)}</span>
            <span className={cx("num font-semibold", change >= 0 ? "text-gold" : "text-ember")}>{pct(change)}</span>
          </Link>
        );
      });
  } else if (quickInfo === "following") {
    const followed = new Set(traders.slice(0, 8).map((t) => t.handle));
    items = liveTrades
      .filter((t) => followed.has(t.handle))
      .slice(0, 14)
      .map((t) => {
        const c = byMint.get(t.mint);
        return (
          <Link key={t.id} to={`/coin/${t.mint}`} className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="font-medium text-cream">@{t.handle}</span>
            <span className={t.side === "buy" ? "text-gold" : "text-ember"}>{t.side === "buy" ? "bought" : "sold"}</span>
            <span className="num text-cream">{t.sol.toFixed(2)} SOL</span>
            <span className="text-muted">of ${c?.ticker}</span>
          </Link>
        );
      });
    if (items.length === 0) items = traders.slice(0, 8).map((t) => <span key={t.handle} className="whitespace-nowrap text-muted">@{t.handle} is quiet</span>);
  } else {
    const list = (recent.length ? recent.map((m) => byMint.get(m)).filter(Boolean) : coins.slice(0, 8)) as typeof coins;
    items = list.map((c) => (
      <Link key={c.mint} to={`/coin/${c.mint}`} className="flex items-center gap-2 whitespace-nowrap">
        <img src={c.image} alt="" className="h-[18px] w-[18px] rounded" />
        <span className="font-medium text-cream">${c.ticker}</span>
        <span className="num text-muted">{usdCompact(c.mcapUsd)}</span>
        <span className={cx("num font-semibold", c.change24h >= 0 ? "text-gold" : "text-ember")}>{pct(c.change24h)}</span>
      </Link>
    ));
  }
  items = items.filter(Boolean);
  const live = items.length > 6;

  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-canvas px-4 text-[13px]">
      <div className="flex items-center gap-0.5" role="tablist" aria-label="Quick info">
        {TOGGLES.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={quickInfo === id} title={label} aria-label={label} onClick={() => setQuickInfo(id)} className={cx("flex h-7 w-7 items-center justify-center rounded-md", quickInfo === id ? "tab-active" : "tab")}>
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
      <div className="h-4 w-px bg-line" />
      <div className="mask-fade-x relative min-w-0 flex-1 overflow-hidden">
        <div className={cx("flex w-max items-center gap-7", live && "animate-marquee hover:[animation-play-state:paused]")}>
          {items}
          {live && items}
        </div>
      </div>
      <span className="hidden whitespace-nowrap text-xs text-muted 2xl:inline">
        {compact(coins.length)} coins live
      </span>
    </div>
  );
}

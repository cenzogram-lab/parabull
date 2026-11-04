import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { shortAddr, usdCompact } from "../../lib/format";
import { backdropClass, dialogClass, usePresence } from "../../hooks/usePresence";
import { useApp } from "../../state/AppState";
import { useMarket } from "../../state/Market";
import { cx } from "../ui/primitives";

export function SearchPalette() {
  const { searchOpen, setSearchOpen, addSearchHistory } = useApp();
  const { coins, traders } = useMarket();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const { mounted, shown } = usePresence(searchOpen);

  const results = useMemo(() => {
    const s = q.trim().replace(/^\$/, "").toLowerCase();
    const cs = (s ? coins.filter((c) => c.name.toLowerCase().includes(s) || c.ticker.toLowerCase().includes(s) || c.mint.toLowerCase().startsWith(s)) : [...coins].sort((a, b) => b.vol24hUsd - a.vol24hUsd)).slice(0, 7);
    const ts = (s ? traders.filter((t) => t.handle.includes(s) || t.name.toLowerCase().includes(s)) : traders.slice(0, 3)).slice(0, 4);
    return [...cs.map((c) => ({ kind: "coin" as const, c })), ...ts.map((t) => ({ kind: "trader" as const, t }))];
  }, [q, coins, traders]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    if (!searchOpen) setQ("");
  }, [searchOpen]);
  // Desktop only: App doesn't mount it below md, where ⌘K goes to the /search page instead.
  if (!mounted) return null;

  const go = (i: number) => {
    const r = results[i];
    if (!r) return;
    setSearchOpen(false);
    if (r.kind === "coin") addSearchHistory(r.c.mint);
    navigate(r.kind === "coin" ? `/coin/${r.c.mint}` : "/leaderboard");
  };

  return (
    <div className="fixed inset-0 z-50">
      <div className={backdropClass(shown)} aria-hidden />
      <div className="absolute inset-0 flex justify-center pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && setSearchOpen(false)}>
      <div role="dialog" aria-label="Search" className={cx("panel-raised h-fit w-full max-w-xl origin-top overflow-hidden", dialogClass(shown))}>
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="h-4 w-4 text-copper" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearchOpen(false);
              if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(results.length - 1, s + 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
              if (e.key === "Enter") go(sel);
            }}
            placeholder="Search for coins, tickers, or creators..."
            className="h-12 flex-1 bg-transparent text-[15px] text-cream outline-none"
          />
          <span className="kbd">Esc</span>
        </div>
        <ul className="max-h-[420px] overflow-y-auto p-1.5">
          {results.length === 0 && <li className="px-3 py-6 text-center text-muted">No coins or creators match “{q}”.</li>}
          {results.map((r, i) => (
            <li key={r.kind === "coin" ? r.c.mint : r.t.handle}>
              <button onMouseEnter={() => setSel(i)} onClick={() => go(i)} className={cx("flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-left transition-all duration-100 ease-out", i === sel && "border-line-accent bg-surface-2 shadow-[0_4px_16px_rgba(200,125,85,0.08)]")}>
                {r.kind === "coin" ? (
                  <>
                    <img src={r.c.image} alt="" className="h-8 w-8 rounded-lg" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{r.c.name}</span>
                      <span className="text-xs text-muted">
                        ${r.c.ticker} · {shortAddr(r.c.mint)}
                      </span>
                    </span>
                    <span className="num text-sm text-cream">{usdCompact(r.c.mcapUsd)}</span>
                  </>
                ) : (
                  <>
                    <img src={r.t.avatar} alt="" className="h-8 w-8 rounded-full" />
                    <span className="flex-1">
                      <span className="block font-semibold">@{r.t.handle}</span>
                      <span className="text-xs text-muted">Creator · {r.t.squad ?? "No squad"}</span>
                    </span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
      </div>
    </div>
  );
}

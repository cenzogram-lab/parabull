/**
 * Mobile board (below md, spec 2A): a compact King of the Bull card, the "Live now" streams, then a
 * sticky Movers / New / Soon / Graduated tab row with the quick filters and
 * the row-density toggle, then the coin cards.
 */
import { Crown } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useNow } from "../../hooks/useNow";
import type { Coin } from "../../lib/types";
import { progressOf } from "../../mock/coins";
import { kingOf, useMarket } from "../../state/Market";
import { BullMark } from "../brand/BullMark";
import { Meter } from "../ui/visuals";
import { LiveNowStrip } from "./MobileLiveStrip";
import { CoinFilterButton, filterCount, MobileCoinFilterSheet, NO_FILTERS, passesFilters, type CoinFilters } from "./MobileCoinFilters";
import { FilterSummary, MobileCoinList, RowDensityButton, useListTop, useRemembered } from "./MobileCoinList";
import { shortUsd, useRowDensity } from "./MobileCoinRow";
import { MobileTabs } from "./MobileUi";
import { byChangeDesc } from "../../lib/format";

type Tab = "Movers" | "New" | "Soon" | "Graduated";
// Slightly tight tracking lets all four tabs and the two 44px controls fit a 390px row.
const TABS = (["Movers", "New", "Soon", "Graduated"] as const).map((value) => ({ value, label: <span className="tracking-tight">{value}</span> }));

const EMPTY: Record<Tab, string> = {
  Movers: "No coins are trading yet.",
  New: "No new launches yet.",
  Soon: "No coin is past 60% of its curve yet.",
  Graduated: "No coin has graduated to Raydium yet.",
};

/** Same orderings as the desktop Pro Screener. */
function listFor(coins: Coin[], tab: Tab): Coin[] {
  const curve = coins.filter((c) => !c.migrated);
  switch (tab) {
    case "New":
      return curve.sort((a, b) => b.createdAt - a.createdAt);
    case "Soon":
      return curve.filter((c) => progressOf(c) >= 0.6).sort((a, b) => progressOf(b) - progressOf(a));
    case "Graduated":
      return coins.filter((c) => c.migrated).sort((a, b) => b.mcapUsd - a.mcapUsd);
    default:
      return [...coins].sort((a, b) => byChangeDesc(a.change1h, b.change1h));
  }
}

/** The curve coin closest to graduation, in one tappable card under 96px tall. */
function KingCard({ coin }: { coin: Coin }) {
  const p = progressOf(coin);
  const done = `${(p * 100).toFixed(1)}%`;
  return (
    <Link
      to={`/coin/${coin.mint}`}
      aria-label={`King of the Bull: ${coin.name} ($${coin.ticker}), ${done} of the way to Raydium, market cap ${shortUsd(coin.mcapUsd)}`}
      className="brushed-dark relative flex items-center gap-3 overflow-hidden rounded-2xl border border-line-accent/80 p-3 shadow-lift transition-colors duration-100 ease-out active:border-copper"
    >
      <div aria-hidden className="pointer-events-none absolute -right-5 -top-9 opacity-[0.08]">
        <BullMark size={136} ring={false} title="" />
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-[radial-gradient(ellipse_at_left,rgba(200,125,85,0.16),transparent_70%)]" />
      <div className="relative shrink-0 pl-1 pt-1">
        <img src={coin.image} alt="" width={44} height={44} className="h-11 w-11 rounded-[10px] border border-line-accent bg-canvas-2 object-cover" />
        <span className="metal-gold absolute -left-0.5 -top-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-full text-canvas shadow-glow">
          <Crown className="h-3 w-3" strokeWidth={2.5} aria-hidden />
        </span>
      </div>
      <div className="relative min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="metal-text truncate font-display text-[11px] font-bold leading-4 tracking-[0.2em]">KING OF THE BULL</span>
          <span className="shrink-0 font-mono text-[13px] font-bold leading-4 text-gold">MC {shortUsd(coin.mcapUsd)}</span>
        </div>
        <div className="mt-1 flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-[15px] font-semibold leading-5 text-cream">{coin.name}</span>
          <span className="shrink-0 text-xs font-medium text-muted">${coin.ticker}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <Meter value={p} height={6} label={`${coin.ticker} bonding curve progress`} />
          </div>
          <span className="num shrink-0 text-[12px] font-semibold leading-4 text-gold">
            {done} <span className="font-medium text-muted">to Raydium</span>
          </span>
        </div>
      </div>
    </Link>
  );
}

export function MobileBoard() {
  const { coins } = useMarket();
  const now = useNow();
  const king = kingOf(coins);
  const [tab, setTab] = useRemembered<Tab>("board:tab", "Movers");
  const [filters, setFilters] = useRemembered<CoinFilters>("board:filters", NO_FILTERS);
  const [density, setDensity] = useRowDensity();
  const [sheet, setSheet] = useState(false);
  const [listTop, toTop] = useListTop();
  const base = useMemo(() => listFor(coins, tab), [coins, tab]);
  const rows = useMemo(() => base.filter((c) => passesFilters(c, filters, now)), [base, filters, now]);
  const active = filterCount(filters);
  const applyFilters = (f: CoinFilters) => {
    setFilters(f);
    toTop();
  };

  return (
    <div className="pb-2">
      <h1 className="sr-only">Board</h1>
      {king && (
        <div className="px-4 pb-1 pt-3">
          <KingCard coin={king} />
        </div>
      )}
      <LiveNowStrip />
      <div ref={listTop} className="h-2" />
      <MobileTabs
        sticky
        label="Screener"
        options={TABS}
        value={tab}
        onChange={(t) => {
          setTab(t);
          toTop();
        }}
        right={
          <>
            <CoinFilterButton active={active} onClick={() => setSheet(true)} />
            <RowDensityButton density={density} onChange={setDensity} />
          </>
        }
      />
      {active > 0 && rows.length > 0 && (
        <div className="pt-1">
          <FilterSummary shown={rows.length} total={base.length} onClear={() => applyFilters(NO_FILTERS)} />
        </div>
      )}
      <MobileCoinList label={`${tab} coins`} coins={rows} orderKey={`${tab}:${JSON.stringify(filters)}`} density={density} filtered={active > 0} onClearFilters={() => applyFilters(NO_FILTERS)} empty={EMPTY[tab]} />
      {/* A sibling of the sticky tab row: its backdrop blur would trap the sheet's fixed overlay. */}
      <MobileCoinFilterSheet open={sheet} onClose={() => setSheet(false)} value={filters} onChange={applyFilters} matches={(f) => base.filter((c) => passesFilters(c, f, now)).length} />
    </div>
  );
}

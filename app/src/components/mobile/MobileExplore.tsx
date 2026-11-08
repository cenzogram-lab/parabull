/**
 * Mobile screener (below md): Movers / New / Graduated in a sticky tab row,
 * a sort chip that opens a sheet of orderings, the shared quick filters, and
 * the same coin cards as the board.
 */
import { ArrowDownWideNarrow, Check, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { useNow } from "../../hooks/useNow";
import type { Coin } from "../../lib/types";
import { useMarket } from "../../state/Market";
import { cx } from "../ui/primitives";
import { CoinFilterButton, filterCount, MobileCoinFilterSheet, NO_FILTERS, passesFilters, type CoinFilters } from "./MobileCoinFilters";
import { MobileCoinList, RowDensityButton, useListTop, useRemembered } from "./MobileCoinList";
import { useRowDensity } from "./MobileCoinRow";
import { BottomSheet, MobileTabs } from "./MobileUi";
import { byChangeDesc } from "../../lib/format";

type Cat = "Movers" | "New" | "Graduated";
/** Tracked like the board's tabs, so the two screeners match. */
const CATS = (["Movers", "New", "Graduated"] as const).map((value) => ({ value, label: <span className="tracking-tight">{value}</span> }));

type SortKey = "mcap" | "vol" | "newest" | "c1h" | "c24h" | "traders";
const SORTS: readonly { key: SortKey; label: string; hint: string }[] = [
  { key: "mcap", label: "Market cap", hint: "Largest first" },
  { key: "vol", label: "24h volume", hint: "Most traded first" },
  { key: "newest", label: "Newest", hint: "Latest launches first" },
  { key: "c1h", label: "1h change", hint: "Biggest gains first" },
  { key: "c24h", label: "24h change", hint: "Biggest gains first" },
  { key: "traders", label: "Traders", hint: "Most traders in 24h first" },
];
const sortValue = (c: Coin, k: SortKey) => ({ mcap: c.mcapUsd, vol: c.vol24hUsd, newest: c.createdAt, c1h: c.change1h, c24h: c.change24h, traders: c.traders24h })[k];
/** Each tab opens in its own order (as on desktop); the sort chip overrides it until the tab changes. */
const TAB_SORT: Record<Cat, SortKey> = { Movers: "c1h", New: "newest", Graduated: "mcap" };

export function MobileExplore() {
  const { coins } = useMarket();
  const now = useNow();
  const [cat, setCat] = useRemembered<Cat>("explore:cat", "Movers");
  const [sort, setSort] = useRemembered<SortKey>("explore:sort", TAB_SORT.Movers);
  const [filters, setFilters] = useRemembered<CoinFilters>("explore:filters", NO_FILTERS);
  const [density, setDensity] = useRowDensity();
  const [sheet, setSheet] = useState<"sort" | "filters" | null>(null);
  const [listTop, toTop] = useListTop();
  const base = useMemo(() => (cat === "Graduated" ? coins.filter((c) => c.migrated) : coins), [coins, cat]);
  const rows = useMemo(() => base.filter((c) => passesFilters(c, filters, now)).sort((a, b) => byChangeDesc(sortValue(a, sort), sortValue(b, sort))), [base, filters, sort, now]);
  const active = filterCount(filters);
  const sortLabel = SORTS.find((s) => s.key === sort)?.label ?? "";
  const close = () => setSheet(null);
  const applyFilters = (f: CoinFilters) => {
    setFilters(f);
    toTop();
  };

  return (
    <div className="pb-2">
      <h1 className="px-4 pb-1 pt-4 text-[22px] font-semibold leading-7 tracking-tight text-cream">Explore</h1>
      <div ref={listTop} />
      <MobileTabs
        sticky
        label="Explore categories"
        options={CATS}
        value={cat}
        onChange={(c) => {
          setCat(c);
          setSort(TAB_SORT[c]);
          toTop();
        }}
        right={
          <>
            <CoinFilterButton active={active} onClick={() => setSheet("filters")} />
            <RowDensityButton density={density} onChange={setDensity} />
          </>
        }
      />
      <div className="flex items-center gap-2 px-4 pt-2">
        <p className="min-w-0 flex-1 truncate text-[12.5px] text-muted">
          <span className="num font-semibold text-cream">{rows.length}</span> {active ? `of ${base.length} coins` : rows.length === 1 ? "coin" : "coins"}
        </p>
        {active > 0 && rows.length > 0 && (
          <button type="button" onClick={() => applyFilters(NO_FILTERS)} className="h-11 shrink-0 px-1 text-[13px] font-semibold text-gold transition-opacity duration-100 ease-out active:opacity-70">
            Clear filters
          </button>
        )}
        <button
          type="button"
          onClick={() => setSheet("sort")}
          aria-haspopup="dialog"
          aria-label={`Sort: ${sortLabel}`}
          className="touch-target inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface pl-3 pr-2.5 text-[13px] font-semibold text-cream transition-colors duration-100 ease-out active:bg-surface-2"
        >
          <ArrowDownWideNarrow className="h-4 w-4 text-copper" strokeWidth={2} aria-hidden />
          {sortLabel}
          <ChevronDown className="h-3.5 w-3.5 text-muted" strokeWidth={2.25} aria-hidden />
        </button>
      </div>
      <MobileCoinList label={`${cat} coins`} coins={rows} orderKey={`${cat}:${sort}:${JSON.stringify(filters)}`} density={density} filtered={active > 0} onClearFilters={() => applyFilters(NO_FILTERS)} empty={cat === "Graduated" ? "No coin has graduated to Raydium yet." : "No coins yet."} />

      {/* Siblings of the sticky tab row: its backdrop blur would trap the sheets' fixed overlays. */}
      <BottomSheet open={sheet === "sort"} onClose={close} title="Sort by">
        <ul className="-mx-2 flex flex-col">
          {SORTS.map((s) => {
            const on = s.key === sort;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setSort(s.key);
                    close();
                    toTop();
                  }}
                  className="flex min-h-[52px] w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors duration-100 ease-out active:bg-surface-3"
                >
                  <span className="min-w-0 flex-1">
                    <span className={cx("block text-[15px] font-semibold leading-5", on ? "text-gold" : "text-cream")}>{s.label}</span>
                    <span className="block text-[12.5px] leading-[18px] text-muted">{s.hint}</span>
                  </span>
                  {on && <Check className="h-5 w-5 shrink-0 text-gold" strokeWidth={2.25} aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      </BottomSheet>
      <MobileCoinFilterSheet open={sheet === "filters"} onClose={close} value={filters} onChange={applyFilters} matches={(f) => base.filter((c) => passesFilters(c, f, now)).length} />
    </div>
  );
}

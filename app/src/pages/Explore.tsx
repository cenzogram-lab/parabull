import { ChevronsUpDown, Filter, GraduationCap, LayoutGrid, Lock, Rocket, Sparkles, Star, Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CategoryTabs, ChangePill, cx, Popover } from "../components/ui/primitives";
import { CoinAvatar, Meter, Sparkline } from "../components/ui/visuals";
import { useNow } from "../hooks/useNow";
import { age, compact, usdCompact } from "../lib/format";
import type { Coin } from "../lib/types";
import { progressOf } from "../mock/coins";
import { useApp } from "../state/AppState";
import { useMarket } from "../state/Market";

type Cat = "movers" | "new" | "graduated";
type SortKey = "mcap" | "age" | "trades" | "vol" | "traders" | "c1h" | "c6h" | "c24h";
interface Filters {
  minMcap: string;
  maxMcap: string;
  minVol: string;
  maxVol: string;
  lockedOnly: boolean;
}
const NO_FILTERS: Filters = { minMcap: "", maxMcap: "", minVol: "", maxVol: "", lockedOnly: false };

const sortValue = (c: Coin, k: SortKey) =>
  ({ mcap: c.mcapUsd, age: -c.createdAt, trades: c.buys24h + c.sells24h, vol: c.vol24hUsd, traders: c.traders24h, c1h: c.change1h, c6h: c.change6h, c24h: c.change24h })[k];

function Th({ label, k, sort, onSort, align = "right" }: { label: string; k?: SortKey; sort: { key: SortKey; dir: 1 | -1 } | null; onSort: (k: SortKey) => void; align?: "left" | "right" }) {
  return (
    <th className={cx("px-2 py-3 text-[11.5px] font-semibold uppercase tracking-wider text-muted", align === "right" ? "text-right" : "text-left")} aria-sort={k && sort?.key === k ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      {k ? (
        <button onClick={() => onSort(k)} className={cx("inline-flex items-center gap-1 uppercase tracking-wider hover:text-cream", sort?.key === k && "text-cream")}>
          {label}
          <ChevronsUpDown className="h-3 w-3" />
        </button>
      ) : (
        label
      )}
    </th>
  );
}

export function Explore() {
  const { coins } = useMarket();
  const { watchlist, toggleWatch } = useApp();
  const navigate = useNavigate();
  const now = useNow();
  const [cat, setCat] = useState<Cat>("movers");
  const [view, setView] = useState<"table" | "grid">("table");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const activeFilters = Object.entries(filters).filter(([k, v]) => (k === "lockedOnly" ? v : v !== "")).length;

  const rows = useMemo(() => {
    const num = (s: string, mul: number) => (s.trim() === "" ? null : Number(s) * mul);
    const [minM, maxM, minV, maxV] = [num(filters.minMcap, 1e3), num(filters.maxMcap, 1e3), num(filters.minVol, 1e3), num(filters.maxVol, 1e3)];
    let list = coins.filter((c) => {
      if (cat === "graduated" && !c.migrated) return false;
      if (minM !== null && c.mcapUsd < minM) return false;
      if (maxM !== null && c.mcapUsd > maxM) return false;
      if (minV !== null && c.vol24hUsd < minV) return false;
      if (maxV !== null && c.vol24hUsd > maxV) return false;
      if (filters.lockedOnly && !(c.locks.tweet && c.locks.tweet > now)) return false;
      return true;
    });
    list = cat === "new" ? list.sort((a, b) => b.createdAt - a.createdAt) : cat === "graduated" ? list.sort((a, b) => b.mcapUsd - a.mcapUsd) : list.sort((a, b) => b.change1h - a.change1h);
    if (sort) list = [...list].sort((a, b) => (sortValue(b, sort.key) - sortValue(a, sort.key)) * sort.dir);
    return list;
  }, [coins, cat, filters, sort, now]);
  const onSort = (k: SortKey) => setSort((s) => (s?.key === k ? (s.dir === 1 ? { key: k, dir: -1 } : null) : { key: k, dir: 1 }));

  return (
    <div className="px-8 py-6">
      <h1 className="text-[26px] font-semibold tracking-tight">Explore coins</h1>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <CategoryTabs
          value={cat}
          onChange={setCat}
          options={[
            { value: "movers", label: "Movers", icon: Rocket },
            { value: "new", label: "New", icon: Sparkles },
            { value: "graduated", label: "Graduated", icon: GraduationCap },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          <Popover
            className="w-80"
            trigger={(open) => (
              <button className={cx("btn-ghost h-11 px-3.5", (open || activeFilters > 0) && "border-line-accent text-gold")} aria-label="Filters">
                <Filter className="h-4 w-4" />
                Filters{activeFilters ? ` · ${activeFilters}` : ""}
              </button>
            )}
          >
            {(close) => (
              <div className="space-y-3">
                {(
                  [
                    ["Market cap ($K)", "minMcap", "maxMcap"],
                    ["24h volume ($K)", "minVol", "maxVol"],
                  ] as const
                ).map(([label, lo, hi]) => (
                  <div key={label}>
                    <div className="label mb-1.5">{label}</div>
                    <div className="flex items-center gap-2">
                      <input className="input h-9 py-1" inputMode="decimal" placeholder="Min" value={draft[lo]} onChange={(e) => setDraft({ ...draft, [lo]: e.target.value.replace(/[^0-9.]/g, "") })} />
                      <span className="text-muted">to</span>
                      <input className="input h-9 py-1" inputMode="decimal" placeholder="Max" value={draft[hi]} onChange={(e) => setDraft({ ...draft, [hi]: e.target.value.replace(/[^0-9.]/g, "") })} />
                    </div>
                  </div>
                ))}
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-line-soft bg-canvas-2 p-2.5">
                  <span>
                    <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                      <Lock className="h-3.5 w-3.5 text-rosebronze" /> Verified locks only
                    </span>
                    <span className="text-[11.5px] text-muted">Ticker, name and announcement tweet all locked on-chain</span>
                  </span>
                  <input type="checkbox" className="h-4 w-4 accent-[#E5A967]" checked={draft.lockedOnly} onChange={(e) => setDraft({ ...draft, lockedOnly: e.target.checked })} />
                </label>
                <div className="flex justify-between">
                  <button onClick={() => (setDraft(NO_FILTERS), setFilters(NO_FILTERS))} className="btn-ghost h-8 px-3 text-xs">
                    Reset
                  </button>
                  <button onClick={() => (setFilters(draft), close())} className="btn-gold h-8 px-4 text-xs">
                    Apply
                  </button>
                </div>
              </div>
            )}
          </Popover>
          <div className="inline-flex rounded-xl border border-line bg-surface p-1">
            {(
              [
                ["grid", LayoutGrid, "Grid"],
                ["table", Table2, "Table"],
              ] as const
            ).map(([v, Icon, label]) => (
              <button key={v} onClick={() => setView(v)} aria-pressed={view === v} className={cx("inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[13.5px] font-semibold", view === v ? "bg-surface-3 text-cream" : "text-muted hover:text-cream")}>
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === "table" ? (
        <div className="panel mt-5 overflow-x-auto">
          <table className="w-full min-w-[1100px] text-[13.5px]">
            <thead className="border-b border-line bg-canvas-2/60">
              <tr>
                <Th label="Coin" sort={sort} onSort={onSort} align="left" />
                <Th label="Graph" sort={sort} onSort={onSort} align="left" />
                <Th label="MCap" k="mcap" sort={sort} onSort={onSort} />
                <Th label="ATH" sort={sort} onSort={onSort} align="left" />
                <Th label="Age" k="age" sort={sort} onSort={onSort} />
                <Th label="Trades" k="trades" sort={sort} onSort={onSort} />
                <Th label="24H Vol" k="vol" sort={sort} onSort={onSort} />
                <Th label="Traders" k="traders" sort={sort} onSort={onSort} />
                <Th label="1H" k="c1h" sort={sort} onSort={onSort} />
                <Th label="6H" k="c6h" sort={sort} onSort={onSort} />
                <Th label="24H" k="c24h" sort={sort} onSort={onSort} />
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((c, i) => {
                const athRatio = c.mcapUsd / c.athUsd;
                return (
                  <tr key={c.mint} onClick={() => navigate(`/coin/${c.mint}`)} className="cursor-pointer border-b border-line-soft transition-colors hover:bg-surface-2">
                    <td className="py-2.5 pl-3 pr-2">
                      <div className="flex items-center gap-3">
                        <span className="num w-6 text-right text-muted">{i + 1}</span>
                        <CoinAvatar src={c.image} alt={c.name} size={38} graduated={c.migrated} />
                        <div className="min-w-0">
                          <Link to={`/coin/${c.mint}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 font-semibold hover:text-gold">
                            <span className="max-w-[200px] truncate">{c.name}</span>
                            {c.locks.tweet && c.locks.tweet > now && <Lock className="h-3 w-3 text-rosebronze" aria-label="Verified locks" />}
                          </Link>
                          <div className="text-[12.5px] text-muted">${c.ticker}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-2">
                      <Sparkline data={c.spark} width={84} height={30} label={`${c.ticker} 24h trend`} />
                    </td>
                    <td className="num px-2 text-right font-semibold">{usdCompact(c.mcapUsd)}</td>
                    <td className="px-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-[#2A211B]">
                          <div className={cx("h-full rounded-full", athRatio > 0.9 ? "bg-gold" : "bg-copper")} style={{ width: `${athRatio * 100}%` }} />
                        </div>
                        <span className="num text-[13px]">{usdCompact(c.athUsd).replace(".00", "")}</span>
                      </div>
                    </td>
                    <td className="num px-2 text-right">{age(now - c.createdAt)}</td>
                    <td className="num px-2 text-right">{(c.buys24h + c.sells24h).toLocaleString("en-US")}</td>
                    <td className="num px-2 text-right">{usdCompact(c.vol24hUsd)}</td>
                    <td className="num px-2 text-right">{c.traders24h.toLocaleString("en-US")}</td>
                    <td className="px-2 text-right">
                      <ChangePill value={c.change1h} />
                    </td>
                    <td className="px-2 text-right">
                      <ChangePill value={c.change6h} />
                    </td>
                    <td className="px-2 text-right">
                      <ChangePill value={c.change24h} />
                    </td>
                    <td className="pr-3 text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleWatch(c.mint);
                        }}
                        aria-label={watchlist.has(c.mint) ? "Remove from watchlist" : "Add to watchlist"}
                        className="btn-icon h-8 w-8"
                      >
                        <Star className={cx("h-4 w-4", watchlist.has(c.mint) && "fill-gold text-gold")} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <div className="py-12 text-center text-muted">No coins match these filters.</div>}
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-6">
          {rows.map((c) => (
            <Link key={c.mint} to={`/coin/${c.mint}`} className="panel group overflow-hidden transition-colors hover:border-line-accent">
              <img src={c.image} alt={c.name} className="aspect-square w-full object-cover" />
              <div className="p-3">
                <div className="truncate font-semibold group-hover:text-gold">{c.name}</div>
                <div className="flex items-center justify-between text-[12.5px] text-muted">
                  <span>${c.ticker}</span>
                  <span>{age(now - c.createdAt)}</span>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="num font-semibold">{usdCompact(c.mcapUsd)}</span>
                  <ChangePill value={c.change24h} size="xs" />
                </div>
                {!c.migrated && (
                  <div className="mt-2">
                    <Meter value={progressOf(c)} height={5} label={`${c.ticker} curve progress`} />
                  </div>
                )}
                <div className="mt-1.5 text-[11.5px] text-muted">{compact(c.traders24h)} traders · {usdCompact(c.vol24hUsd)} vol</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

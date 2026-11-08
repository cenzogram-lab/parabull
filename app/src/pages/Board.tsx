import { Activity, ArrowRight, ChevronUp, Crown, Flame, Globe, Lock, Maximize2, Megaphone, Minimize2, SlidersHorizontal, Trophy } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BullMark } from "../components/brand/BullMark";
import { XLogo } from "../components/brand/Wordmark";
import { ActiveLocks, CalloutCard, CoinCard, CoinRow } from "../components/coin/CoinViews";
import { MobileBoard } from "../components/mobile/MobileBoard";
import { ChangePill, cx, HotBadge, Panel, PanelHeader, Popover, Segmented, UnderlineTabs, Verified } from "../components/ui/primitives";
import { CoinAvatar, Meter, Sparkline, TraderAvatar } from "../components/ui/visuals";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useNow } from "../hooks/useNow";
import { age, compact, price, usdCompact, usdSigned } from "../lib/format";
import { GRADUATION_RAISE_LAMPORTS } from "../lib/protocol";
import { activeScreenerFilters, FEED_PAGE, nextFeedCount, NO_SCREENER_FILTERS, passesScreener, SCREENER_ROWS, type ScreenerFilters } from "../lib/screener";
import type { Coin, Period } from "../lib/types";
import { progressOf } from "../mock/coins";
import { useApp } from "../state/AppState";
import { kingOf, useMarket } from "../state/Market";

export function Board() {
  const isMobile = useIsMobile();
  const { layout } = useApp();
  if (isMobile) return <MobileBoard />;
  return layout === "pro" ? <TerminalBoard /> : <ClassicBoard />;
}

function KingOfTheBull({ coin }: { coin: Coin }) {
  const now = useNow();
  const p = progressOf(coin);
  const raised = Number(coin.reserves.realSol) / 1e9;
  const target = Number(GRADUATION_RAISE_LAMPORTS) / 1e9;
  return (
    <section className="brushed-dark relative overflow-hidden rounded-2xl border border-line-accent/80 shadow-lift">
      <div className="pointer-events-none absolute -right-10 -top-16 opacity-[0.09]">
        <BullMark size={340} ring={false} title="" />
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-[radial-gradient(ellipse_at_left,rgba(200,125,85,0.18),transparent_65%)]" />
      <div className="relative grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_auto] items-center gap-8 px-6 py-5">
        <div className="flex min-w-0 items-center gap-5">
          <div className="relative">
            <CoinAvatar src={coin.image} alt={coin.name} size={92} progress={p} rounded="2xl" />
            <span className="metal-gold absolute -left-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full text-canvas shadow-glow">
              <Crown className="h-4 w-4" strokeWidth={2.4} />
            </span>
          </div>
          <div className="min-w-0">
            <div className="metal-text font-display text-[13px] font-bold tracking-[0.22em]">KING OF THE BULL</div>
            <Link to={`/coin/${coin.mint}`} className="mt-1 block truncate text-[26px] font-semibold leading-8 hover:text-gold">
              {coin.name}
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
              <span className="font-semibold text-cream">${coin.ticker}</span>
              <span>by @{coin.creatorHandle}</span>
              <span>{age(now - coin.createdAt)} old</span>
              <ActiveLocks coin={coin} compact={false} />
            </div>
          </div>
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] font-medium text-muted">Closest to Raydium migration</span>
            <span className="text-[22px] font-semibold text-gold">{(p * 100).toFixed(1)}%</span>
          </div>
          <div className="mt-2.5">
            <Meter value={p} height={12} label={`${coin.ticker} bonding curve progress`} />
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted">
            <span>
              <span className="num text-cream">{raised.toFixed(1)}</span> / {target.toFixed(0)} SOL raised
            </span>
            <span>
              <span className="num text-cream">{(target - raised).toFixed(1)} SOL</span> to graduation
            </span>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-right">
            <dt className="text-xs text-muted">Market cap</dt>
            <dt className="text-xs text-muted">24h</dt>
            <dd className="text-lg font-semibold">{usdCompact(coin.mcapUsd)}</dd>
            <dd className="pt-1">
              <ChangePill value={coin.change24h} />
            </dd>
          </dl>
          <div className="flex flex-col gap-2">
            <Link to={`/coin/${coin.mint}`} className="btn-gold h-10 px-5 text-[14px]">
              Trade ${coin.ticker} <ArrowRight className="h-4 w-4" />
            </Link>
            <span className="text-center text-[11.5px] text-muted">{coin.holders.toLocaleString("en-US")} holders</span>
          </div>
        </div>
      </div>
    </section>
  );
}

type ScreenTab = "New" | "Soon" | "Graduated" | "Movers";

/** `expanded`: the panel spans the whole board row and lists every match (the Expand button). */
function ProScreener({ expanded, onToggleExpand }: { expanded: boolean; onToggleExpand: () => void }) {
  const { coins } = useMarket();
  const now = useNow();
  const [tab, setTab] = useState<ScreenTab>("New");
  const [filters, setFilters] = useState<ScreenerFilters>(NO_SCREENER_FILTERS);
  const active = activeScreenerFilters(filters);
  const list = useMemo(() => {
    const shown = coins.filter((c) => passesScreener(c, filters, now));
    const curve = shown.filter((c) => !c.migrated);
    switch (tab) {
      case "New":
        return [...curve].sort((a, b) => b.createdAt - a.createdAt);
      case "Soon":
        return curve.filter((c) => progressOf(c) >= 0.6).sort((a, b) => progressOf(b) - progressOf(a));
      case "Graduated":
        return shown.filter((c) => c.migrated).sort((a, b) => b.mcapUsd - a.mcapUsd);
      default:
        return [...shown].sort((a, b) => b.change1h - a.change1h);
    }
  }, [coins, tab, filters, now]);
  return (
    <Panel className={expanded ? "h-[calc(100vh-180px)] min-h-[660px] lg:col-span-2 2xl:col-span-4" : "h-[660px]"}>
      <PanelHeader
        icon={Activity}
        title="Pro Screener"
        actions={
          <>
            <Popover
              className="w-72"
              trigger={(open) => (
                <button
                  type="button"
                  className={cx("btn-icon relative h-7 w-7", (open || active > 0) && "text-gold")}
                  aria-label={active ? `Filters (${active} on)` : "Filters"}
                  aria-expanded={open}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  {active > 0 && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-gold" aria-hidden />}
                </button>
              )}
            >
              {(close) => <ScreenerFilterForm value={filters} onApply={(f) => (setFilters(f), close())} />}
            </Popover>
            <button type="button" onClick={onToggleExpand} className="btn-icon h-7 w-7" aria-label={expanded ? "Collapse panel" : "Expand panel"} aria-expanded={expanded}>
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          </>
        }
      />
      <div className="flex items-center justify-between border-b border-line px-2.5 py-2">
        <Segmented options={["New", "Soon", "Graduated", "Movers"] as const} value={tab} onChange={setTab} label="Screener" />
        <span className="text-xs text-muted">{list.length}</span>
      </div>
      {/* Expanded, the rows (sized for a narrow panel) flow into columns instead of stretching across the board. */}
      <div className={cx("min-h-0 flex-1 overflow-y-auto", expanded && "grid auto-rows-max grid-cols-1 lg:grid-cols-2 2xl:grid-cols-4")}>
        {(expanded ? list : list.slice(0, SCREENER_ROWS)).map((c) => (
          <CoinRow key={c.mint} coin={c} />
        ))}
        {list.length === 0 && <p className="col-span-full px-4 py-10 text-center text-[13px] text-muted">No coins match these filters.</p>}
      </div>
    </Panel>
  );
}

/** The screener's filter form: edits a draft, applied (and the popover closed) with Apply. */
function ScreenerFilterForm({ value, onApply }: { value: ScreenerFilters; onApply: (f: ScreenerFilters) => void }) {
  const [draft, setDraft] = useState(value);
  const [minK, setMinK] = useState(value.minMcapUsd ? String(value.minMcapUsd / 1e3) : "");
  const apply = (f: ScreenerFilters) => onApply(f);
  const row = "flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-line-soft bg-canvas-2 p-2.5";
  return (
    <div className="space-y-2.5">
      <label className={row}>
        <span>
          <span className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Lock className="h-3.5 w-3.5 text-rosebronze" /> Verified locks only
          </span>
          <span className="text-[11.5px] text-muted">Ticker, name and tweet all locked on-chain</span>
        </span>
        <input type="checkbox" className="h-4 w-4 accent-[#E5A967]" checked={draft.lockedOnly} onChange={(e) => setDraft({ ...draft, lockedOnly: e.target.checked })} />
      </label>
      <label className={row}>
        <span className="text-[13px] font-semibold">Has X or website</span>
        <input type="checkbox" className="h-4 w-4 accent-[#E5A967]" checked={draft.socialsOnly} onChange={(e) => setDraft({ ...draft, socialsOnly: e.target.checked })} />
      </label>
      <div>
        <div className="label mb-1.5">Min market cap ($K)</div>
        <input className="input h-9 py-1" inputMode="decimal" placeholder="Any" aria-label="Minimum market cap in thousands of dollars" value={minK} onChange={(e) => setMinK(e.target.value.replace(/[^0-9.]/g, ""))} />
      </div>
      <div className="flex justify-between pt-0.5">
        <button type="button" onClick={() => (setDraft(NO_SCREENER_FILTERS), setMinK(""), apply(NO_SCREENER_FILTERS))} className="btn-ghost h-8 px-3 text-xs">
          Reset
        </button>
        <button type="button" onClick={() => apply({ ...draft, minMcapUsd: Number(minK) > 0 ? Number(minK) * 1e3 : 0 })} className="btn-gold h-8 px-4 text-xs">
          Apply
        </button>
      </div>
    </div>
  );
}

type Tf = "1h" | "4h" | "12h" | "24h";
const changeFor = (c: Coin, tf: Tf) => (tf === "1h" ? c.change1h : tf === "4h" ? (c.change1h + c.change6h) / 2 : tf === "12h" ? (c.change6h + c.change24h) / 2 : c.change24h);

function Trending() {
  const { coins } = useMarket();
  const [tf, setTf] = useState<Tf>("24h");
  const list = useMemo(() => [...coins].sort((a, b) => b.vol24hUsd * (1 + Math.max(0, changeFor(b, tf))) - a.vol24hUsd * (1 + Math.max(0, changeFor(a, tf)))).slice(0, 24), [coins, tf]);
  return (
    <Panel className="h-[660px]">
      <PanelHeader icon={Flame} title="Trending" />
      <div className="flex items-center justify-between border-b border-line px-2.5 py-2">
        <span className="text-xs font-medium text-muted">By volume × momentum</span>
        <Segmented size="xs" options={["1h", "4h", "12h", "24h"] as const} value={tf} onChange={setTf} label="Timeframe" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.map((c) => (
          <Link key={c.mint} to={`/coin/${c.mint}`} className="hover-lift flex items-center gap-3 border border-transparent border-b-line-soft px-3 py-2.5">
            <CoinAvatar src={c.image} alt={c.name} size={40} graduated={c.migrated} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[14px] font-bold">{c.ticker}</span>
                {c.migrated && <Verified />}
                {c.hot && <HotBadge />}
              </div>
              <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
                <span className="num">{price(c.priceUsd)}</span>
                {c.socials.x && <XLogo className="h-3 w-3" />}
                {c.socials.website && <Globe className="h-3 w-3" />}
              </div>
            </div>
            <Sparkline data={c.spark} width={64} height={26} label={`${c.ticker} 24h trend`} />
            <div className="w-[76px] text-right">
              <div className="num text-[13.5px] font-semibold">{usdCompact(c.mcapUsd)}</div>
              <div className={cx("num text-[12px] font-semibold", changeFor(c, tf) >= 0 ? "text-gold" : "text-ember")}>
                {changeFor(c, tf) >= 0 ? "↑" : "↓"} {Math.abs(changeFor(c, tf) * 100).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%
              </div>
            </div>
          </Link>
        ))}
      </div>
    </Panel>
  );
}

function HotCallouts() {
  const { callouts, traders, byMint } = useMarket();
  return (
    <Panel className="h-[660px]">
      <PanelHeader icon={Megaphone} title="Hot callouts" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {callouts.map((c) => (
          <CalloutCard key={c.id} callout={c} trader={traders.find((t) => t.handle === c.handle)} coin={byMint.get(c.mint)} dense />
        ))}
      </div>
    </Panel>
  );
}

function MiniLeaderboard() {
  const { traders } = useMarket();
  const [who, setWho] = useState<"Traders" | "Earners">("Traders");
  const [metric, setMetric] = useState<"Profit" | "Volume">("Profit");
  const [period, setPeriod] = useState<Period>("1W");
  const rows = useMemo(() => {
    const key = (t: (typeof traders)[number]) => (who === "Earners" ? t.rewardsUsd : metric === "Profit" ? t.pnl[period] : t.volume[period]);
    return [...traders].sort((a, b) => key(b) - key(a)).map((t) => ({ t, v: key(t) }));
  }, [traders, who, metric, period]);
  return (
    <Panel className="h-[660px]">
      <PanelHeader icon={Trophy} title="Leaderboard" />
      <div className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-2">
        <Segmented options={["Traders", "Earners"] as const} value={who} onChange={setWho} label="Leaderboard" />
        <div className="flex gap-1.5">
          {who === "Traders" && <Segmented size="xs" options={["Profit", "Volume"] as const} value={metric} onChange={setMetric} label="Sort" />}
          <Segmented size="xs" options={["1D", "1W"] as const} value={period === "1M" ? "1W" : period} onChange={setPeriod} label="Period" />
        </div>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto">
        {rows.map(({ t, v }, i) => (
          <li key={t.handle} className="hover-lift flex items-center gap-3 border border-transparent border-b-line-soft px-3 py-2.5">
            <span className={cx("num w-5 text-center text-[13px] font-semibold", i < 3 ? "text-gold" : "text-muted")}>{i + 1}</span>
            <TraderAvatar src={t.avatar} size={34} verified={t.verified} ring={i === 0 ? "gold" : i === 1 ? "rose" : i === 2 ? "copper" : undefined} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[14px] font-semibold">{t.handle}</span>
                {t.x && <XLogo className="h-3 w-3 text-muted" />}
              </div>
              {t.squad && <div className="text-[11.5px] text-muted">{t.squad}</div>}
            </div>
            <span className={cx("num text-[14px] font-semibold", who === "Earners" || metric === "Profit" ? "text-gold" : "text-cream")}>
              {who === "Earners" ? `+$${compact(v)}` : metric === "Profit" ? usdSigned(v) : `$${compact(v)}`}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function TerminalBoard() {
  const { coins } = useMarket();
  const king = kingOf(coins);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-4 p-4">
      {king && <KingOfTheBull coin={king} />}
      {/* Expanded, the screener takes the whole first row and the other panels flow below it. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-[1.12fr_1fr_1.12fr_1fr]">
        <ProScreener expanded={expanded} onToggleExpand={() => setExpanded((e) => !e)} />
        <Trending />
        <HotCallouts />
        <MiniLeaderboard />
      </div>
    </div>
  );
}

function ClassicBoard() {
  const { coins, callouts, traders, byMint, following } = useMarket();
  const [feed, setFeed] = useState<"For you" | "Following">("For you");
  const [side, setSide] = useState<"Movers" | "Trending">("Movers");
  const [newOpen, setNewOpen] = useState(false);
  const [shown, setShown] = useState(FEED_PAGE);
  const all = feed === "For you" ? callouts : callouts.filter((c) => following.has(c.handle));
  const posts = all.slice(0, shown);
  const newest = [...coins].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
  const right = side === "Movers" ? [...coins].sort((a, b) => b.change1h - a.change1h) : [...coins].sort((a, b) => b.vol24hUsd - a.vol24hUsd);
  return (
    <div className="mx-auto grid max-w-[1320px] grid-cols-1 gap-12 px-8 py-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div>
        <UnderlineTabs size="lg" options={["For you", "Following"] as const} value={feed} onChange={(f) => (setFeed(f), setShown(FEED_PAGE))} />
        {posts.map((c) => (
          <CalloutCard key={c.id} callout={c} trader={traders.find((t) => t.handle === c.handle)} coin={byMint.get(c.mint)} />
        ))}
        {all.length === 0 && <p className="py-10 text-center text-[14px] text-muted">No updates yet from traders you follow.</p>}
        {/* Only while there is more to show; each click adds a page. */}
        {posts.length < all.length && (
          <button type="button" onClick={() => setShown((n) => nextFeedCount(n, all.length))} className="mt-4 text-[14px] font-semibold text-gold hover:underline">
            Show more updates <span className="font-normal text-muted">({all.length - posts.length} more)</span>
          </button>
        )}
      </div>
      <aside>
        <UnderlineTabs size="lg" options={["Movers", "Trending"] as const} value={side} onChange={setSide} />
        <button onClick={() => setNewOpen((o) => !o)} className="mt-4 flex w-full items-center justify-center gap-2 rounded-full border border-line bg-surface py-2 text-[14px] font-semibold hover:border-line-accent">
          <ChevronUp className={cx("h-4 w-4 transition-transform", !newOpen && "rotate-180")} />
          <span className="flex -space-x-2">
            {newest.slice(0, 3).map((c) => (
              <img key={c.mint} src={c.image} alt="" className="h-6 w-6 rounded-full ring-2 ring-surface" />
            ))}
          </span>
          new coins
        </button>
        {newOpen && (
          <div className="panel mt-2">
            {newest.map((c) => (
              <CoinRow key={c.mint} coin={c} />
            ))}
          </div>
        )}
        <div className="mt-3 space-y-1">
          {right.slice(0, 8).map((c) => (
            <CoinCard key={c.mint} coin={c} />
          ))}
        </div>
      </aside>
    </div>
  );
}

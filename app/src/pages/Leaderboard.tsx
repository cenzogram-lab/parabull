import { ArrowDownUp, ChevronDown, ChevronRight, Crown, Info, Trophy } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { XLogo } from "../components/brand/Wordmark";
import { CalloutCard } from "../components/coin/CoinViews";
import { byCalloutResult, calloutMove } from "../lib/calloutsClient";
import { MobileLeaderboard } from "../components/mobile/MobileLeaderboard";
import { cx, Segmented, UnderlineTabs } from "../components/ui/primitives";
import { TraderAvatar } from "../components/ui/visuals";
import { useIsMobile } from "../hooks/useMediaQuery";
import { compact, pct, usdCompact, usdSigned } from "../lib/format";
import type { Period } from "../lib/types";
import { useMarket } from "../state/Market";

type Tab = "Traders" | "Squads" | "Rewards" | "Best Callouts";
type Metric = "Profit" | "Volume";

const FRAMES = [
  { ring: "gold" as const, grad: "linear-gradient(135deg,#FBE3C4,#E5A967 35%,#B87333 70%,#F2C58C)" },
  { ring: "rose" as const, grad: "linear-gradient(135deg,#F6DCCD,#D49B7E 40%,#8F5B44 75%,#E8BFA8)" },
  { ring: "copper" as const, grad: "linear-gradient(135deg,#F0B993,#C87D55 40%,#7A4529 75%,#E0A27C)" },
  { ring: "bronze" as const, grad: "linear-gradient(135deg,#E2B47E,#B87333 40%,#5E3519 75%,#D39550)" },
];

interface Entry {
  key: string;
  name: string;
  avatar: string;
  sub?: string;
  x?: boolean;
  verified?: boolean;
  value: number;
  money: boolean;
  /** The value is a fraction shown as a percentage (a real callout's move since the call). */
  pct?: boolean;
  extra: string;
}

const fmtEntry = (e: Entry) => (e.pct ? pct(e.value, 0) : e.money ? usdSigned(e.value) : `$${compact(e.value)}`);
const signed = (e: Entry) => e.money || e.pct;

function Plaque({ e, rank, big }: { e: Entry; rank: number; big?: boolean }) {
  const f = FRAMES[rank - 1];
  return (
    <div className={cx("relative", big ? "z-10 -mt-6 w-[250px]" : "w-[190px]")}>
      {rank === 1 && <Crown className="absolute -top-8 left-1/2 h-9 w-9 -translate-x-1/2 text-gold drop-shadow-[0_0_12px_rgba(229,169,103,0.6)]" fill="#E5A967" />}
      <div className="rounded-2xl p-[3px] shadow-lift" style={{ background: f.grad }}>
        <div className="relative overflow-hidden rounded-[14px] bg-canvas">
          <img src={e.avatar} alt="" className="aspect-square w-full object-cover opacity-95" />
          <span className="metal-text absolute left-2.5 top-1 font-display text-5xl font-bold drop-shadow-[0_2px_2px_rgba(0,0,0,0.7)]">{rank}</span>
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-canvas via-canvas/85 to-transparent px-3 pb-2.5 pt-8">
            <div className="flex items-center gap-1.5 truncate text-[14px] font-semibold">
              {e.name}
              {e.x && <XLogo className="h-3 w-3 text-muted" />}
            </div>
            <div className={cx("num text-[15px] font-semibold", signed(e) ? (e.value >= 0 ? "text-gold" : "text-ember") : "text-cream")}>{fmtEntry(e)}</div>
            {e.sub && <div className="text-[11px] text-muted">{e.sub}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Why a tab has nobody ranked: callouts can be posted now; traders, squads and rewards need data the indexer doesn't serve yet. */
function emptyNote(tab: Tab): string {
  if (tab === "Best Callouts") return "Post a callout from a coin's Callouts tab: the best calls since then rank here.";
  if (tab === "Rewards") return "Earners rank here once reward epochs are published.";
  return "Trader and squad rankings aren't served by the indexer yet.";
}

/** Below md the mobile leaderboard replaces this page's whole tree; desktop renders unchanged. */
export function Leaderboard() {
  return useIsMobile() ? <MobileLeaderboard /> : <DesktopLeaderboard />;
}

function DesktopLeaderboard() {
  const { traders, squads, callouts, byMint } = useMarket();
  const [tab, setTab] = useState<Tab>("Traders");
  const [period, setPeriod] = useState<Period>("1D");
  const [metric, setMetric] = useState<Metric>("Profit");
  const [side, setSide] = useState<"1D" | "1W">("1D");
  const [open, setOpen] = useState<string | null>(null);

  const entries: Entry[] = useMemo(() => {
    if (tab === "Squads")
      return [...squads]
        .map((s) => ({ key: s.name, name: s.name, avatar: s.emblem, sub: `${s.tag} · ${s.members} members`, value: metric === "Profit" ? s.pnl[period] : s.volume[period], money: metric === "Profit", extra: `${s.members} members` }))
        .sort((a, b) => b.value - a.value);
    if (tab === "Rewards")
      return [...traders]
        .map((t) => ({ key: t.handle, name: t.handle, avatar: t.avatar, sub: "$PARABULL holder rewards", x: t.x, verified: t.verified, value: t.rewardsUsd * (period === "1D" ? 0.08 : period === "1W" ? 0.4 : 1), money: true, extra: t.squad ?? "" }))
        .sort((a, b) => b.value - a.value);
    if (tab === "Best Callouts")
      return [...callouts]
        .filter((c) => byMint.has(c.mint))
        .map((c) => ({ c, move: calloutMove(c, byMint.get(c.mint)!) }))
        .sort((a, b) => b.move - a.move)
        .map(({ c, move }) => {
          const t = traders.find((x) => x.handle === c.handle);
          const coin = byMint.get(c.mint)!;
          // A demo callout shows the caller's PnL; a real one has no position, so it shows the move since the call.
          return { key: c.id, name: c.handle, avatar: t?.avatar ?? coin.image, sub: `$${coin.ticker} · ${pct(move, 0)}`, x: t?.x, verified: t?.verified, value: c.position ? c.position.pnlUsd : move, money: !!c.position, pct: !c.position, extra: `Called $${coin.ticker} at ${usdCompact(c.calledAtMcap)}` };
        });
    return [...traders]
      .map((t) => ({ key: t.handle, name: t.handle, avatar: t.avatar, sub: t.squad, x: t.x, verified: t.verified, value: metric === "Profit" ? t.pnl[period] : t.volume[period], money: metric === "Profit", extra: `${t.trades[period]} trades · ${(t.winRate * 100).toFixed(0)}% win rate` }))
      .sort((a, b) => b.value - a.value);
  }, [tab, traders, squads, callouts, byMint, period, metric]);

  const top = entries.slice(0, 4);
  const best = useMemo(() => [...callouts].filter((c) => side === "1W" || Date.now() - c.ts < 24 * 3600_000).sort(byCalloutResult(byMint)), [callouts, side, byMint]);

  return (
    <div className="mx-auto grid max-w-[1500px] grid-cols-1 gap-10 px-8 py-6 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="min-w-0">
        <h1 className="text-[28px] font-semibold tracking-tight">Leaderboard</h1>
        <div className="mt-5">
          <UnderlineTabs options={["Traders", "Squads", "Rewards", "Best Callouts"] as const} value={tab} onChange={setTab} />
        </div>
        <button type="button" onClick={() => setTab("Best Callouts")} className="flex w-full items-center gap-2 border-b border-line-soft px-1 py-3.5 text-left text-[13.5px] text-muted hover:text-cream">
          <Info className="h-4 w-4" />A callout is a public call on a coin you hold: post one from the coin's Callouts tab. Make at least one to be ranked on the leaderboard.
          <ChevronRight className="ml-auto h-4 w-4" />
        </button>

        {top[0] && (
          <div className="mt-6 flex items-center justify-center gap-3">
            <span className="metal-text font-display text-6xl font-bold leading-none">1</span>
            <span className="text-[30px] font-semibold">{top[0].name}</span>
            <span className={cx("num text-[30px] font-semibold", signed(top[0]) ? "text-gold" : "text-cream")}>{fmtEntry(top[0])}</span>
          </div>
        )}
        {!top.length && (
          <div className="panel mt-8 flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Trophy className="h-8 w-8 text-copper" aria-hidden />
            <p className="text-[15px] font-semibold text-cream">No rankings yet</p>
            <p className="max-w-md text-[13.5px] text-muted">{emptyNote(tab)}</p>
          </div>
        )}
        <div className="relative mt-12 flex items-end justify-center gap-5">
          <div className="pointer-events-none absolute inset-x-10 bottom-0 top-10 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(229,169,103,0.16),transparent_65%)]" />
          {top[1] && <Plaque e={top[1]} rank={2} />}
          {top[0] && <Plaque e={top[0]} rank={1} big />}
          {top[2] && <Plaque e={top[2]} rank={3} />}
          {top[3] && <Plaque e={top[3]} rank={4} />}
        </div>

        <div className="mt-8 flex items-center justify-between">
          <div className="flex items-center gap-2 rounded-full border border-line bg-surface p-1 pl-3">
            <Trophy className="h-4 w-4 text-copper" />
            <Segmented options={["1D", "1W", "1M"] as const} value={period} onChange={setPeriod} label="Period" className="border-0 bg-transparent" />
          </div>
          {(tab === "Traders" || tab === "Squads") && (
            <button onClick={() => setMetric((m) => (m === "Profit" ? "Volume" : "Profit"))} className="btn-ghost h-10 rounded-full px-4">
              <ArrowDownUp className="h-4 w-4 text-copper" /> {metric}
            </button>
          )}
        </div>

        <ol className="mt-4 space-y-2">
          {entries.map((e, i) => (
            <li key={e.key} className="panel hover-lift overflow-hidden">
              <button onClick={() => setOpen((o) => (o === e.key ? null : e.key))} className="flex w-full items-center gap-4 px-4 py-3 text-left" aria-expanded={open === e.key}>
                <span className={cx("num w-6 text-center text-[15px] font-semibold", i < 3 ? "text-gold" : "text-muted")}>{i + 1}</span>
                <TraderAvatar src={e.avatar} size={42} verified={e.verified} ring={FRAMES[i]?.ring} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[15px] font-semibold">
                    {e.name}
                    {i === 0 && <Crown className="h-4 w-4 text-gold" />}
                    {e.x && <XLogo className="h-3 w-3 text-muted" />}
                    {e.sub && tab === "Traders" && <span className="rounded bg-surface-3 px-1.5 text-[10.5px] font-semibold text-rosebronze">{e.sub}</span>}
                  </span>
                  <span className="text-xs text-muted">{e.extra}</span>
                </span>
                <span className={cx("num text-[17px] font-semibold", signed(e) ? (e.value >= 0 ? "text-gold" : "text-ember") : "text-cream")}>{fmtEntry(e)}</span>
                <ChevronDown className={cx("h-4 w-4 text-muted transition-transform", open === e.key && "rotate-180")} />
              </button>
              {open === e.key && (
                <div className="grid grid-cols-3 gap-3 border-t border-line-soft px-4 py-3 text-xs">
                  {tab === "Traders" ? (
                    (() => {
                      const t = traders.find((x) => x.handle === e.key)!;
                      const coin = byMint.get(t.bestCoin);
                      return (
                        <>
                          <div>
                            <div className="text-muted">Volume ({period})</div>
                            <div className="num text-[14px] font-semibold">{usdCompact(t.volume[period])}</div>
                          </div>
                          <div>
                            <div className="text-muted">Win rate</div>
                            <div className="num text-[14px] font-semibold">{(t.winRate * 100).toFixed(1)}%</div>
                          </div>
                          <div>
                            <div className="text-muted">Best coin</div>
                            {coin && (
                              <Link to={`/coin/${coin.mint}`} className="flex items-center gap-1.5 text-[14px] font-semibold hover:text-gold">
                                <img src={coin.image} alt="" className="h-5 w-5 rounded" />${coin.ticker}
                              </Link>
                            )}
                          </div>
                        </>
                      );
                    })()
                  ) : (
                    <div className="col-span-3 text-muted">{e.extra}</div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>

      <aside>
        <h2 className="text-[28px] font-semibold tracking-tight">Best callouts</h2>
        <Segmented className="mt-5" options={["1D", "1W"] as const} value={side} onChange={setSide} label="Callout period" />
        <div className="panel mt-4 px-4">
          {!best.length && <p className="py-8 text-center text-[13.5px] text-muted">No callouts {side === "1D" ? "in the last 24 hours" : "this week"} yet.</p>}
          {best.slice(0, 8).map((c) => (
            <CalloutCard key={c.id} callout={c} trader={traders.find((t) => t.handle === c.handle)} coin={byMint.get(c.mint)} dense />
          ))}
        </div>
      </aside>
    </div>
  );
}

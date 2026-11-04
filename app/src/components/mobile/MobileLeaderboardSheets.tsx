/**
 * Bottom sheets of the mobile leaderboard: a trader's or squad's card (from a
 * podium plaque or a row), the sort picker, and the best callouts (from the
 * callout info card). Sheet bodies are components of their own, so their
 * hooks only run while a sheet is mounted.
 */
import { ChartColumn, Check, ChevronRight, TrendingUp } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useNow } from "../../hooks/useNow";
import { age, pct, usdCompact } from "../../lib/format";
import type { Callout, Coin, Period, Squad, Trader } from "../../lib/types";
import { useMarket } from "../../state/Market";
import { XLogo } from "../brand/Wordmark";
import { ChangePill, cx } from "../ui/primitives";
import { TraderAvatar } from "../ui/visuals";
import { fmtUsd, measureWord, RankAvatar, REWARD_SHARE, valueTone, type Entry, type Metric, type Tab } from "./MobileLeaderboardParts";
import { BottomSheet, FollowButton } from "./MobileUi";

const PERIODS: readonly Period[] = ["1D", "1W", "1M"];
const DAY = 24 * 3_600_000;

/** The row or plaque a sheet was opened from, with the board it was ranked on. */
export interface Picked {
  entry: Entry;
  rank: number;
  tab: Tab;
}

export function EntrySheet({ picked, open, onClose, period, metric, following, onFollow }: { picked: Picked | null; open: boolean; onClose: () => void; period: Period; metric: Metric; following: boolean; onFollow: () => void }) {
  return (
    <BottomSheet open={open} onClose={onClose} title={picked ? `Rank #${picked.rank} · ${period} ${measureWord(picked.tab, metric)}` : ""}>
      {picked?.entry.squad && <SquadCard s={picked.entry.squad} rank={picked.rank} period={period} metric={metric} following={following} onFollow={onFollow} />}
      {picked?.entry.trader && <TraderCard t={picked.entry.trader} rank={picked.rank} tab={picked.tab} period={period} metric={metric} following={following} onFollow={onFollow} />}
    </BottomSheet>
  );
}

function Stat({ label, value, tone = "text-cream" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-line-soft bg-canvas-2 px-3 py-2.5">
      <dt className="truncate text-[11.5px] font-medium text-muted">{label}</dt>
      <dd className={cx("num mt-0.5 truncate text-[16px] font-semibold leading-6", tone)}>{value}</dd>
    </div>
  );
}

/** The board's measure in each period, the selected one highlighted. */
function PeriodStrip({ title, values, money, active }: { title: string; values: Record<Period, number>; money: boolean; active: Period }) {
  return (
    <section className="mt-4">
      <h3 className="label">{title}</h3>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {PERIODS.map((p) => (
          <div key={p} className={cx("min-w-0 rounded-lg border px-2 py-2 text-center", p === active ? "border-line-accent bg-surface-4" : "border-line-soft bg-canvas-2")}>
            <div className={cx("text-[11px] font-semibold leading-4", p === active ? "text-gold" : "text-muted")}>{p}</div>
            <div className={cx("num mt-0.5 truncate text-[13.5px] font-semibold leading-5", valueTone({ money, value: values[p] }))}>{fmtUsd(values[p], money)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Identity({ avatar, rank, verified, title, sub, chip, extra }: { avatar: string; rank: number; verified?: boolean; title: string; sub: string; chip?: string; extra?: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 pt-1">
      <RankAvatar src={avatar} rank={rank} size={64} verified={verified} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[17px] font-semibold leading-6 text-cream">{title}</span>
          {verified && <span className="sr-only">(verified)</span>}
          {extra}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] leading-5 text-muted">
          <span className="truncate">{sub}</span>
          {chip && <span className="shrink-0 rounded bg-surface-3 px-1.5 text-[10.5px] font-semibold leading-[18px] text-rosebronze">{chip}</span>}
        </div>
      </div>
    </div>
  );
}

function TraderCard({ t, rank, tab, period, metric, following, onFollow }: { t: Trader; rank: number; tab: Tab; period: Period; metric: Metric; following: boolean; onFollow: () => void }) {
  const { byMint, squads } = useMarket();
  const coin = byMint.get(t.bestCoin);
  const tag = t.squad ? squads.find((s) => s.name === t.squad)?.tag : undefined;
  const rewards: Record<Period, number> = { "1D": t.rewardsUsd * REWARD_SHARE["1D"], "1W": t.rewardsUsd * REWARD_SHARE["1W"], "1M": t.rewardsUsd * REWARD_SHARE["1M"] };
  const strip = tab === "Rewards" ? { title: "Holder rewards by period", values: rewards, money: true } : metric === "Volume" ? { title: "Volume by period", values: t.volume, money: false } : { title: "Profit by period", values: t.pnl, money: true };
  return (
    <div>
      <Identity avatar={t.avatar} rank={rank} verified={t.verified} title={t.name} sub={`@${t.handle}${t.squad ? ` · ${t.squad}` : ""}`} chip={tag} extra={t.x && <XLogo className="h-3.5 w-3.5 shrink-0 text-muted" />} />
      <FollowButton size="lg" name={t.handle} on={following} onToggle={onFollow} className="mt-4" />
      <dl className="mt-4 grid grid-cols-2 gap-2">
        <Stat label={`${period} profit`} value={fmtUsd(t.pnl[period], true)} tone={valueTone({ money: true, value: t.pnl[period] })} />
        <Stat label={`${period} volume`} value={fmtUsd(t.volume[period], false)} />
        <Stat label={`${period} trades`} value={t.trades[period].toLocaleString("en-US")} />
        <Stat label="Win rate" value={`${(t.winRate * 100).toFixed(1)}%`} />
        <Stat label={`${period} holder rewards`} value={fmtUsd(rewards[period], true)} tone="text-gold" />
        <Stat label="Squad" value={t.squad ?? "None"} />
      </dl>
      <PeriodStrip {...strip} active={period} />
      {coin && <BestCoin coin={coin} />}
    </div>
  );
}

function BestCoin({ coin }: { coin: Coin }) {
  return (
    <section className="mt-4">
      <h3 className="label">Best coin</h3>
      <Link to={`/coin/${coin.mint}`} className="mt-2 flex min-h-14 items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2 transition-colors duration-100 ease-out active:bg-surface-2">
        <img src={coin.image} alt="" width={36} height={36} className="h-9 w-9 shrink-0 rounded-lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold leading-5 text-cream">${coin.ticker}</span>
          <span className="block truncate text-[12px] leading-4 text-muted">{coin.name}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="num text-[13px] font-semibold leading-5 text-cream">MC {usdCompact(coin.mcapUsd)}</span>
          <ChangePill value={coin.change24h} size="xs" soft />
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      </Link>
    </section>
  );
}

function SquadCard({ s, rank, period, metric, following, onFollow }: { s: Squad; rank: number; period: Period; metric: Metric; following: boolean; onFollow: () => void }) {
  const { traders } = useMarket();
  const byProfit = metric === "Profit";
  const members = useMemo(() => traders.filter((t) => t.squad === s.name).sort((a, b) => (byProfit ? b.pnl[period] - a.pnl[period] : b.volume[period] - a.volume[period])), [traders, s.name, byProfit, period]);
  return (
    <div>
      <Identity avatar={s.emblem} rank={rank} title={s.name} sub={`${s.members} members`} chip={s.tag} />
      <FollowButton size="lg" name={s.name} on={following} onToggle={onFollow} className="mt-4" />
      <dl className="mt-4 grid grid-cols-2 gap-2">
        <Stat label={`${period} profit`} value={fmtUsd(s.pnl[period], true)} tone={valueTone({ money: true, value: s.pnl[period] })} />
        <Stat label={`${period} volume`} value={fmtUsd(s.volume[period], false)} />
      </dl>
      <PeriodStrip title={byProfit ? "Profit by period" : "Volume by period"} values={byProfit ? s.pnl : s.volume} money={byProfit} active={period} />
      {members.length > 0 && (
        <section className="mt-4">
          <h3 className="label">Members on the leaderboard</h3>
          <ul className="mt-1">
            {members.map((t) => (
              <li key={t.handle} className="flex min-h-[52px] items-center gap-3 border-t border-line-soft py-2 first:border-t-0">
                <TraderAvatar src={t.avatar} size={32} verified={t.verified} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold leading-5 text-cream">{t.handle}</span>
                  <span className="block truncate text-[11.5px] leading-4 text-muted">{t.name}</span>
                </span>
                <span className={cx("num shrink-0 text-[13.5px] font-semibold", valueTone({ money: byProfit, value: byProfit ? t.pnl[period] : t.volume[period] }))}>{fmtUsd(byProfit ? t.pnl[period] : t.volume[period], byProfit)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const SORTS = [
  { value: "Profit", icon: TrendingUp, hint: "Net PnL over the period, highest first" },
  { value: "Volume", icon: ChartColumn, hint: "Traded volume over the period, highest first" },
] as const;

export function SortSheet({ open, onClose, metric, onChange }: { open: boolean; onClose: () => void; metric: Metric; onChange: (m: Metric) => void }) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Sort by">
      <div className="-mx-2 flex flex-col pb-1">
        {SORTS.map(({ value, icon: Icon, hint }) => {
          const on = value === metric;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              onClick={() => {
                onChange(value);
                onClose();
              }}
              className="flex min-h-[60px] items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors duration-100 ease-out active:bg-surface-3"
            >
              <span className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border", on ? "border-line-accent bg-surface-4 text-gold" : "border-line bg-surface text-copper")}>
                <Icon className="h-[18px] w-[18px]" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cx("block text-[14.5px] font-semibold leading-5", on ? "text-gold" : "text-cream")}>{value}</span>
                <span className="block text-[12.5px] leading-[18px] text-muted">{hint}</span>
              </span>
              {on && <Check className="h-5 w-5 shrink-0 text-gold" strokeWidth={2.5} aria-hidden />}
            </button>
          );
        })}
      </div>
    </BottomSheet>
  );
}

export function CalloutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Best callouts">
      <CalloutList />
    </BottomSheet>
  );
}

/** Best callouts of the last 24 hours by net PnL (the desktop rail's 1D list). */
function CalloutList() {
  const { callouts, traders, byMint } = useMarket();
  const now = useNow();
  // The window is fixed when the sheet opens, so a ticking clock never reshuffles the list.
  const [since] = useState(() => Date.now() - DAY);
  const best = useMemo(() => callouts.filter((c) => c.ts >= since).sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, 8), [callouts, since]);
  return (
    <div>
      <p className="text-[13px] leading-5 text-muted">
        <span className="font-semibold text-cream">A callout is a public call on a coin you hold.</span> Make at least one to be ranked on the leaderboard.
      </p>
      <h3 className="label mt-4">Last 24 hours, by net PnL</h3>
      {!best.length && <p className="py-6 text-center text-[13px] text-muted">No callouts in the last 24 hours.</p>}
      <ul className="mt-1">
        {best.map((c) => {
          const coin = byMint.get(c.mint);
          return coin ? <CalloutItem key={c.id} c={c} coin={coin} trader={traders.find((t) => t.handle === c.handle)} now={now} /> : null;
        })}
      </ul>
    </div>
  );
}

function CalloutItem({ c, coin, trader, now }: { c: Callout; coin: Coin; trader?: Trader; now: number }) {
  return (
    <li className="border-t border-line-soft py-3.5 first:border-t-0">
      <div className="flex items-center gap-2.5">
        <TraderAvatar src={trader?.avatar ?? coin.image} size={34} verified={trader?.verified} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold leading-5 text-cream">{trader?.name ?? c.handle}</div>
          <div className="truncate text-[12px] leading-4 text-muted">
            @{c.handle} · {age(now - c.ts)}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[10px] font-semibold uppercase leading-4 tracking-[0.08em] text-muted">Net PnL</div>
          <div className={cx("num text-[14px] font-semibold leading-5", valueTone({ money: true, value: c.pnlUsd }))}>{fmtUsd(c.pnlUsd, true)}</div>
        </div>
      </div>
      <p className="mt-2 text-[13.5px] leading-5 text-cream/95">{c.text}</p>
      <Link to={`/coin/${coin.mint}`} className="mt-2.5 flex min-h-[52px] items-center gap-3 rounded-xl border border-line bg-canvas-2 px-3 py-2 transition-colors duration-100 ease-out active:bg-surface-2">
        <img src={coin.image} alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold leading-5 text-cream">${coin.ticker}</span>
          <span className="block truncate text-[11.5px] leading-4 text-muted">Called at {usdCompact(c.calledAtMcap)} MC</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="num block text-[13px] font-semibold leading-5 text-cream">{usdCompact(coin.mcapUsd)}</span>
          <span className={cx("num block text-[11.5px] font-semibold leading-4", c.pnlPct >= 0 ? "text-gold" : "text-ember")}>{pct(c.pnlPct, 0)}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      </Link>
    </li>
  );
}

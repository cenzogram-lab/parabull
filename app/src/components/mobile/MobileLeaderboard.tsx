/**
 * Mobile leaderboard (below md): Traders / Squads / Rewards pill tabs, the
 * callout info card, the top-4 podium, period and sort controls, your pinned
 * rank card, then the full ranking. A podium plaque or a row opens that
 * trader's or squad's card in a bottom sheet; Follow uses the app's shared
 * follow list (useMarket), so the Following feed and notifications agree.
 */
import { ArrowDownUp, ChevronDown, ChevronRight, Info } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { usd, usdSigned } from "../../lib/format";
import { Rng } from "../../lib/rng";
import type { Period } from "../../lib/types";
import { useMarket } from "../../state/Market";
import { usePortfolio, type Portfolio } from "../../state/usePortfolio";
import { useRewardSummary, type RewardSummary } from "../portfolio/shared";
import { cx } from "../ui/primitives";
import { asideText, fmtUsd, measureWord, Podium, rankEntries, RankAvatar, valueTone, type Entry, type Metric, type Tab } from "./MobileLeaderboardParts";
import { CalloutsSheet, EntrySheet, SortSheet, type Picked } from "./MobileLeaderboardSheets";
import { FollowButton, PillTabs } from "./MobileUi";

const TABS = ["Traders", "Squads", "Rewards"] as const;
const PERIODS = ["1D", "1W", "1M"] as const;
/** How much more a week and a month trade than a day (the demo traders' scale). */
const PERIOD_SCALE: Record<Period, number> = { "1D": 1, "1W": 4.6, "1M": 13.5 };
/** Each period's window, for the holder rewards your epochs paid in it. */
const PERIOD_MS: Record<Period, number> = { "1D": 86_400_000, "1W": 7 * 86_400_000, "1M": 30 * 86_400_000 };
/** Eyebrow on the #1 plaque, per board and sort. */
const HERO_LABEL: Record<Tab, Record<Metric, string>> = {
  Traders: { Profit: "Top trader", Volume: "Top volume" },
  Squads: { Profit: "Top squad", Volume: "Top squad volume" },
  Rewards: { Profit: "Top earner", Volume: "Top earner" },
};

interface Standing {
  rank: number;
  rankLabel: string;
  value: number;
  money: boolean;
}

/** Where `value` would place among a board's entries; below the last of them, a (seeded) rank further down. */
function rankOn(entries: Entry[], value: number, seeded: number): number {
  const last = entries[entries.length - 1];
  return last && value >= last.value ? entries.filter((e) => e.value > value).length + 1 : Math.max(entries.length + 1, seeded);
}

/**
 * The wallet's own line on a board (demo). Profit comes from the portfolio:
 * 1D is its 24h change, 1W and 1M the equity curve's change over the window.
 * Rewards are what the wallet's holder-reward epochs paid in the period
 * (null until they're built). Volume and squad figures are seeded from the
 * address. A figure that would make the listed ranking places you in it,
 * and the list shows your row there; otherwise the rank is seeded too, so it
 * holds still between visits.
 */
function standing(p: Pick<Portfolio, "address" | "equityUsd" | "change24hUsd" | "history">, tab: Tab, metric: Metric, period: Period, entries: Entry[], rewards: RewardSummary | undefined, solUsd: number, now: number): Standing | null {
  const rng = (what: string) => new Rng(`leaderboard:you:${p.address}:${what}`);
  if (tab === "Rewards") {
    if (!rewards) return null;
    const value = rewards.epochs.filter((e) => e.verified && e.publishedAt > now - PERIOD_MS[period]).reduce((n, e) => n + (Number(e.you.amount) / 1e9) * solUsd, 0);
    return { rank: rankOn(entries, value, rng(`rank:rewards:${period}`).int(2_400, 9_800)), rankLabel: "Your rank", value, money: true };
  }
  let value: number;
  if (metric === "Volume") value = rng("volume").range(1.6, 3.4) * Math.max(p.equityUsd, 60) * PERIOD_SCALE[period];
  else if (period === "1D") value = p.change24hUsd;
  else {
    const h = p.history(period);
    value = h.length > 1 ? h[h.length - 1].v - h[0].v : 0;
  }
  if (tab === "Squads") {
    const squad = value * rng(`squad:${metric}`).range(3.5, 6.5);
    return { rank: rankOn(entries, squad, rng(`rank:squads:${metric}:${period}`).int(140, 620)), rankLabel: "Your squad rank", value: squad, money: metric === "Profit" };
  }
  const r = rng(`rank:traders:${metric}:${period}`);
  return { rank: rankOn(entries, value, metric === "Volume" ? r.int(9_000, 32_000) : value >= 0 ? r.int(12_000, 24_000) : r.int(24_000, 46_000)), rankLabel: "Your rank", value, money: metric === "Profit" };
}

export function MobileLeaderboard() {
  const { traders, squads, following, toggleFollow, solUsd } = useMarket();
  const portfolio = usePortfolio();
  const [now] = useState(() => Date.now());
  const [tab, setTab] = useState<Tab>("Traders");
  const [period, setPeriod] = useState<Period>("1D");
  const [metric, setMetric] = useState<Metric>("Profit");
  // The sheet keeps its last entry while it slides away.
  const [picked, setPicked] = useState<Picked | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [calloutsOpen, setCalloutsOpen] = useState(false);

  const entries = useMemo(() => rankEntries(tab, period, metric, traders, squads), [tab, period, metric, traders, squads]);
  const { address, equityUsd, change24hUsd, history, handle, avatar } = portfolio;
  const rewards = useRewardSummary(address, tab === "Rewards");
  const you = useMemo(
    () => standing({ address, equityUsd, change24hUsd, history }, tab, metric, period, entries, rewards, solUsd, now),
    [address, equityUsd, change24hUsd, history, tab, metric, period, entries, rewards, solUsd, now],
  );
  // Where your figure makes the listed board, your own row takes that place (on the podium too) and the rows from there move down one.
  const rows = useMemo(() => {
    if (!you || you.rank > entries.length) return entries;
    const line = tab === "Squads" ? "Your squad" : "Your portfolio";
    const mine: Entry = { key: "@you", name: handle, avatar, verified: false, meta: line, detail: line, value: you.value, money: you.money, you: true };
    return [...entries.slice(0, you.rank - 1), mine, ...entries.slice(you.rank - 1)];
  }, [entries, you, tab, handle, avatar]);
  const word = measureWord(tab, metric);

  const navigate = useNavigate();
  const openEntry = useCallback(
    (entry: Entry, rank: number) => {
      // Your own plaque opens your portfolio, like the pinned card.
      if (entry.you) {
        navigate("/portfolio");
        return;
      }
      setPicked({ entry, rank, tab });
      setEntryOpen(true);
    },
    [tab, navigate],
  );

  return (
    <>
      <div className="px-4 pt-4">
        <h1 className="text-[22px] font-semibold leading-7 tracking-tight text-cream">Leaderboard</h1>
        <PillTabs className="mt-3" options={TABS} value={tab} onChange={setTab} label="Leaderboard" />

        <button
          type="button"
          onClick={() => setCalloutsOpen(true)}
          aria-haspopup="dialog"
          className="mt-3 flex w-full items-center gap-3 rounded-xl border border-line bg-surface py-3 pl-3 pr-2.5 text-left transition-colors duration-100 ease-out active:bg-surface-2"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-canvas-2 text-copper" aria-hidden>
            <Info className="h-4 w-4" strokeWidth={2.25} />
          </span>
          <span className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-muted">
            <span className="font-semibold text-cream">A callout is a public call on a coin you hold.</span> Make at least one to be ranked on the leaderboard.
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        </button>

        <Podium className="mt-5" entries={rows} label={`${HERO_LABEL[tab][metric]} · ${period}`} word={word} onOpen={openEntry} />

        <div className="mt-5 flex items-center justify-between gap-3">
          <PillTabs className="w-fit" options={PERIODS} value={period} onChange={setPeriod} label="Period" />
          {tab !== "Rewards" && (
            <button type="button" onClick={() => setSortOpen(true)} aria-haspopup="dialog" aria-label={`Sort by ${metric.toLowerCase()}`} className="btn-ghost h-11 shrink-0 rounded-full pl-3.5 pr-3 text-[13.5px]">
              <ArrowDownUp className="h-4 w-4 text-copper" aria-hidden />
              {metric}
              <ChevronDown className="h-4 w-4 text-muted" aria-hidden />
            </button>
          )}
        </div>

        <PinnedRank className="mt-3" p={portfolio} you={you} label={`${period} ${word}`} />

        <ol aria-label={`${tab} by ${period} ${word}`} className="panel mt-3 overflow-hidden">
          {rows.map((e, i) =>
            e.you ? <YouRow key={e.key} e={e} rank={i + 1} word={word} /> : <RankRow key={e.key} e={e} rank={i + 1} word={word} following={following.has(e.key)} onFollow={toggleFollow} onOpen={openEntry} />,
          )}
        </ol>
      </div>

      {/* Sheets sit at the page root: an ancestor with a transform or backdrop blur would trap their fixed overlay. */}
      <EntrySheet picked={picked} open={entryOpen} onClose={() => setEntryOpen(false)} period={period} metric={metric} following={!!picked && following.has(picked.entry.key)} onFollow={() => picked && toggleFollow(picked.entry.key)} />
      <SortSheet open={sortOpen} onClose={() => setSortOpen(false)} metric={metric} onChange={setMetric} />
      <CalloutsSheet open={calloutsOpen} onClose={() => setCalloutsOpen(false)} />
    </>
  );
}

/** Your own standing on the current board, pinned above the ranking; opens the portfolio. `you` is null while it loads (your reward epochs). */
function PinnedRank({ p, you, label, className }: { p: Portfolio; you: Standing | null; label: string; className?: string }) {
  const rank = you ? `#${you.rank.toLocaleString("en-US")}` : "";
  // Under $100K the figure is printed in full, like the header's PnL.
  const value = !you ? "" : Math.abs(you.value) < 1e5 ? (you.money ? usdSigned(you.value) : usd(you.value)) : fmtUsd(you.value, you.money);
  // Under 380px it's always the compact figure ("+$2.22K"), which leaves the rank line its room.
  const short = you ? fmtUsd(you.value, you.money) : "";
  return (
    <Link
      to="/portfolio"
      aria-busy={!you || undefined}
      aria-label={you ? `${you.rankLabel} ${rank}, ${label} ${value}. Open your portfolio` : `Your rank: loading. Open your portfolio`}
      className={cx("panel-raised relative flex min-h-16 items-center gap-3 overflow-hidden border-gold/45 py-2.5 pl-3 pr-2 transition-colors duration-100 ease-out active:bg-surface-3", className)}
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-gold/70 to-transparent" />
      <span aria-hidden className="relative shrink-0">
        <img src={p.avatar} alt="" width={40} height={40} className="h-10 w-10 rounded-full ring-[1.5px] ring-copper/80 ring-offset-2 ring-offset-surface-2" />
        <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 rounded-full bg-gold px-1.5 text-[9px] font-bold uppercase leading-[13px] tracking-wide text-canvas ring-2 ring-surface-2">You</span>
      </span>
      <span aria-hidden className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold leading-5 text-cream">{p.handle}</span>
        {/* The label gives way first on a narrow phone, so the rank itself always shows. */}
        <span className="flex min-w-0 text-[12.5px] leading-[18px] text-muted">
          {you ? (
            <>
              <span className="truncate">{`${you.rankLabel}\u00a0`}</span>
              <span className="num shrink-0 font-semibold text-cream">{rank}</span>
            </>
          ) : (
            <span className="truncate">Your rank</span>
          )}
        </span>
      </span>
      <span aria-hidden className="shrink-0 text-right">
        <span className="block text-[10px] font-semibold uppercase leading-4 tracking-[0.08em] text-muted">{label}</span>
        {you ? (
          <span className={cx("num block text-[15px] font-semibold leading-5", valueTone(you))}>
            {short === value ? (
              value
            ) : (
              <>
                <span className="max-[379px]:hidden">{value}</span>
                <span className="min-[380px]:hidden">{short}</span>
              </>
            )}
          </span>
        ) : (
          <span className="ml-auto block h-5 w-16 animate-pulse rounded bg-surface-3" />
        )}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
    </Link>
  );
}

/** Your own row, where your figure ranks on the listed board: tinted gold and without Follow; like the pinned card, it opens your portfolio. */
function YouRow({ e, rank, word }: { e: Entry; rank: number; word: string }) {
  const top = rank <= 3;
  return (
    <li className="border-t border-line-soft first:border-t-0">
      <Link
        to="/portfolio"
        aria-label={`${rank}. You: ${fmtUsd(e.value, e.money)} ${word}. Open your portfolio`}
        className="flex min-h-[60px] items-center gap-2 bg-gold/[0.07] py-2 pl-2 pr-3 transition-colors duration-100 ease-out focus-visible:outline-offset-[-2px] active:bg-surface-2"
      >
        <span aria-hidden className={cx("num w-5 shrink-0 text-center text-[14px] font-semibold", top ? "text-gold" : "text-cream")}>{rank}</span>
        <span aria-hidden className="relative shrink-0">
          <RankAvatar src={e.avatar} rank={rank} />
          <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-gold px-1.5 text-[9px] font-bold uppercase leading-[13px] tracking-wide text-canvas ring-2 ring-surface">You</span>
        </span>
        <span aria-hidden className="min-w-0 flex-1">
          <span className={cx("block truncate text-[14px] font-semibold leading-5", top ? "text-gold" : "text-cream")}>{e.name}</span>
          <span className="mt-0.5 block truncate text-[11.5px] leading-4 text-muted">{e.meta}</span>
        </span>
        <span aria-hidden className="w-20 shrink-0 text-right">
          <span className={cx("num block truncate text-[13.5px] font-semibold leading-5", valueTone(e))}>{fmtUsd(e.value, e.money)}</span>
        </span>
      </Link>
    </li>
  );
}

/**
 * One ranking row. A full-row button underneath opens the card; the Follow
 * toggle sits above it as a sibling, so no control is nested in another.
 */
function RankRow({ e, rank, word, following, onFollow, onOpen }: { e: Entry; rank: number; word: string; following: boolean; onFollow: (key: string) => void; onOpen: (e: Entry, rank: number) => void }) {
  const top = rank <= 3;
  return (
    <li className="relative flex min-h-[60px] items-center gap-2 border-t border-line-soft py-2 pl-2 pr-3 first:border-t-0">
      <button
        type="button"
        onClick={() => onOpen(e, rank)}
        aria-label={`${rank}. ${e.name}: ${fmtUsd(e.value, e.money)} ${word}. Details`}
        className="absolute inset-0 transition-colors duration-100 ease-out focus-visible:outline-offset-[-2px] active:bg-surface-2"
      />
      <span aria-hidden className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2">
        <span className={cx("num w-5 shrink-0 text-center text-[14px] font-semibold", top ? "text-gold" : "text-muted")}>{rank}</span>
        <RankAvatar src={e.avatar} rank={rank} verified={e.verified} />
        <span className="min-w-0 flex-1">
          <span className={cx("block truncate text-[14px] font-semibold leading-5", top ? "text-gold" : "text-cream")}>{e.name}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4 text-muted">
            {/* Under 360px the squad tag gives its room to the win rate. */}
            {e.tag && <span className="shrink-0 rounded bg-surface-3 px-1 text-[10px] font-semibold leading-4 text-rosebronze max-[359px]:hidden">{e.tag}</span>}
            <span className="truncate">{e.meta}</span>
          </span>
        </span>
      </span>
      {/* Below 380px Follow shrinks to its icon, so names keep their room on narrow phones (the figures need their 80px: "+$474.20K"). */}
      <FollowButton name={e.name} on={following} onToggle={() => onFollow(e.key)} narrow />
      <span aria-hidden className="pointer-events-none relative w-20 shrink-0 text-right">
        <span className={cx("num block truncate text-[13.5px] font-semibold leading-5", valueTone(e))}>{fmtUsd(e.value, e.money)}</span>
        {e.aside && <span className={cx("num block truncate text-[11px] leading-4", e.aside.kind === "profit" ? valueTone({ money: true, value: e.aside.value }) : "text-muted")}>{asideText(e.aside)}</span>}
      </span>
    </li>
  );
}

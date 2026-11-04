/**
 * Pieces of the mobile leaderboard (below md): the ranking model, money
 * formatting, the podium, the artwork it uses (metal frames, a crown, laurel
 * wreaths, all drawn here in SVG/CSS for Parabull). The Follow toggle is
 * FollowButton in MobileUi.
 */
import { BadgeCheck } from "lucide-react";
import { useId, useMemo, type CSSProperties } from "react";
import { usdCompact } from "../../lib/format";
import type { Period, Squad, Trader } from "../../lib/types";
import { hex } from "../../theme/tokens";
import { cx } from "../ui/primitives";

export type Tab = "Traders" | "Squads" | "Rewards";
export type Metric = "Profit" | "Volume";

/** Share of a trader's monthly holder rewards credited to each period (the desktop board's factors). */
export const REWARD_SHARE: Record<Period, number> = { "1D": 0.08, "1W": 0.4, "1M": 1 };

export interface Entry {
  /** A trader's handle (shared by the Traders and Rewards boards) or `squad:<name>`. */
  key: string;
  name: string;
  avatar: string;
  verified: boolean;
  /** Squad tag chip shown before `meta`. */
  tag?: string;
  /** Short second line in the list. */
  meta: string;
  /** Longer line on the podium hero. */
  detail: string;
  value: number;
  /** Signed money (gold up, ember down); otherwise volume, in cream. */
  money: boolean;
  /** The other figure, under the value: volume when ranking by profit, profit when ranking by volume. */
  aside?: { kind: "volume" | "profit"; value: number };
  trader?: Trader;
  squad?: Squad;
}

/** One board, best first: traders or squads by profit or volume, or traders by holder rewards. */
export function rankEntries(tab: Tab, period: Period, metric: Metric, traders: Trader[], squads: Squad[]): Entry[] {
  const tagOf = new Map(squads.map((s) => [s.name, s.tag]));
  const byProfit = metric === "Profit";
  const list: Entry[] =
    tab === "Squads"
      ? squads.map((s) => ({
          key: `squad:${s.name}`,
          name: s.name,
          avatar: s.emblem,
          verified: false,
          meta: `${s.members} members`,
          detail: `${s.tag} · ${s.members} members`,
          value: byProfit ? s.pnl[period] : s.volume[period],
          money: byProfit,
          aside: byProfit ? { kind: "volume", value: s.volume[period] } : { kind: "profit", value: s.pnl[period] },
          squad: s,
        }))
      : traders.map((t) => {
          const base = { key: t.handle, name: t.handle, avatar: t.avatar, verified: t.verified, trader: t };
          if (tab === "Rewards") {
            // The row's context is the longer window: the last 30 days, or the last week on the 1M board.
            const meta = period === "1M" ? `${usdCompact(t.rewardsUsd * REWARD_SHARE["1W"])} in 7d` : `${usdCompact(t.rewardsUsd)} in 30d`;
            return { ...base, meta, detail: [t.name, t.squad].filter(Boolean).join(" · "), value: t.rewardsUsd * REWARD_SHARE[period], money: true };
          }
          const win = `${Math.round(t.winRate * 100)}% win`;
          return {
            ...base,
            tag: t.squad ? tagOf.get(t.squad) : undefined,
            meta: win,
            detail: `${t.squad ?? t.name} · ${t.trades[period].toLocaleString("en-US")} trades`,
            value: byProfit ? t.pnl[period] : t.volume[period],
            money: byProfit,
            aside: byProfit ? { kind: "volume" as const, value: t.volume[period] } : { kind: "profit" as const, value: t.pnl[period] },
          };
        });
  return list.sort((a, b) => b.value - a.value);
}

/** "+$146.95K", "-$56.11", "$1.21M": two decimals at every scale, so stacked figures line up. */
export function fmtUsd(n: number, signed: boolean): string {
  const a = Math.abs(n);
  const [div, unit] = a >= 999_995_000 ? [1e9, "B"] : a >= 999_995 ? [1e6, "M"] : a >= 999.995 ? [1e3, "K"] : [1, ""];
  const sign = signed ? (n < 0 ? "-" : "+") : n < 0 ? "-" : "";
  return `${sign}$${(a / div).toFixed(2)}${unit}`;
}

export const valueTone = (e: { money: boolean; value: number }) => (e.money ? (e.value >= 0 ? "text-gold" : "text-ember") : "text-cream");

/** The small figure under a row's value. */
export function asideText(a: NonNullable<Entry["aside"]>): string {
  return a.kind === "volume" ? `Vol ${usdCompact(a.value)}` : `${a.value < 0 ? "-" : "+"}${usdCompact(Math.abs(a.value))}`;
}

/** What a board ranks by: "profit", "volume" or "rewards". */
export const measureWord = (tab: Tab, metric: Metric) => (tab === "Rewards" ? "rewards" : metric === "Profit" ? "profit" : "volume");

/* Artwork ---------------------------------------------------------------- */

/** Metal ramps for the wreaths: highlight, base token, shade. */
const TIER_RAMP = {
  gold: ["#FBE3C4", hex.gold, "#9A5B26"],
  rose: ["#F6DCCD", hex.rosebronze, "#80503B"],
  copper: ["#F0B993", hex.copper, "#6E3D22"],
} as const;
type Tier = keyof typeof TIER_RAMP;
/** Wreath metal for ranks 1, 2 and 3. */
const RANK_TIER: readonly Tier[] = ["gold", "rose", "copper"];

/** Plaque frames for podium ranks 1-4 (the desktop podium's gradients). */
const FRAME = [
  "linear-gradient(135deg,#FBE3C4,#E5A967 35%,#B87333 70%,#F2C58C)",
  "linear-gradient(135deg,#F6DCCD,#D49B7E 40%,#8F5B44 75%,#E8BFA8)",
  "linear-gradient(135deg,#F0B993,#C87D55 40%,#7A4529 75%,#E0A27C)",
  "linear-gradient(135deg,#E2B47E,#B87333 40%,#5E3519 75%,#D39550)",
] as const;

const f = (n: number) => n.toFixed(2);
/** An almond leaf from its base at (0,0) to its tip at (len,0). */
const leafPath = (len: number, w: number) => `M0 0C${f(len * 0.2)} ${f(-w)} ${f(len * 0.7)} ${f(-w)} ${f(len)} 0C${f(len * 0.7)} ${f(w * 0.7)} ${f(len * 0.2)} ${f(w * 0.7)} 0 0Z`;

/**
 * The left branch of a laurel wreath on a circle of radius `r` centred in a
 * `size` box: a stem arc from the bottom up to the upper left, outer and
 * inner leaves alternating along it (smaller towards the tip) and a tip leaf.
 * The right branch is its mirror image; the top stays open.
 */
function laurelBranch(size: number, r: number) {
  const c = size / 2;
  const k = size / 44;
  const at = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return [c + r * Math.cos(a), c + r * Math.sin(a)] as const;
  };
  const leaves: { d: string; transform: string }[] = [];
  // deg + 90 is the stem's direction of growth (bottom, then left, then top); `turn` tilts a leaf off it.
  const put = (deg: number, len: number, w: number, turn: number) => {
    const [x, y] = at(deg);
    leaves.push({ d: leafPath(len * k, w * k), transform: `translate(${f(x)} ${f(y)}) rotate(${(deg + 90 + turn).toFixed(1)})` });
  };
  const n = 7;
  const from = 104;
  const to = 236;
  const step = (to - from) / (n - 1);
  for (let i = 0; i < n; i++) {
    const deg = from + step * i;
    const s = 1 - 0.35 * (i / (n - 1));
    put(deg, 6.2 * s, 2.2 * s, -34);
    if (i < n - 1) put(deg + step / 2, 4.5 * s, 1.9 * s, 30);
  }
  put(to, 3.9, 1.5, 4);
  // The stem starts past the bottom so the two branches cross there.
  const [sx, sy] = at(from - 18);
  const [ex, ey] = at(to);
  return { stem: `M${f(sx)} ${f(sy)}A${f(r)} ${f(r)} 0 0 1 ${f(ex)} ${f(ey)}`, leaves };
}

/** Laurel wreath ring around a centred round avatar of `inner` px. */
function Laurel({ size, inner, tier }: { size: number; inner: number; tier: Tier }) {
  const id = `laurel-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const branch = useMemo(() => laurelBranch(size, inner / 2 + 2.4 * (size / 44)), [size, inner]);
  const [hi, base, lo] = TIER_RAMP[tier];
  const half = (
    <>
      <path d={branch.stem} fill="none" stroke={`url(#${id})`} strokeWidth={0.9 * (size / 44)} strokeLinecap="round" />
      <g fill={`url(#${id})`}>
        {branch.leaves.map((l) => (
          <path key={l.transform} d={l.d} transform={l.transform} />
        ))}
      </g>
    </>
  );
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={hi} />
          <stop offset="0.45" stopColor={base} />
          <stop offset="1" stopColor={lo} />
        </linearGradient>
      </defs>
      {half}
      <g transform={`translate(${size} 0) scale(-1 1)`}>{half}</g>
    </svg>
  );
}

/** Three-point crown with orb tips and a band, in currentColor. */
export function CrownGlyph({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden focusable="false">
      <path d="M3.4 9.2 7.9 12.6 12 6.4l4.1 6.2 4.5-3.4-1.5 8.3H4.9L3.4 9.2Z" />
      <rect x="4.9" y="18.6" width="14.2" height="2.5" rx="1.25" />
      <circle cx="3.2" cy="7.7" r="1.75" />
      <circle cx="12" cy="4.3" r="1.75" />
      <circle cx="20.8" cy="7.7" r="1.75" />
    </svg>
  );
}

/** Amber-gold medallion with the crown struck in obsidian, for the #1 plaque. */
function CrownBadge({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cx("metal-gold flex h-7 w-7 items-center justify-center rounded-full text-canvas shadow-[0_0_0_2px_#141210,0_4px_12px_rgba(0,0,0,0.6),0_0_14px_rgba(229,169,103,0.45)]", className)}>
      <CrownGlyph className="h-[17px] w-[17px]" />
    </span>
  );
}

/** Square identicon in a metal frame (podium plaques); #1 wears the crown medallion. */
function FramedAvatar({ src, size, rank }: { src: string; size: number; rank: number }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span className="block h-full w-full rounded-2xl p-[2.5px] shadow-[0_8px_18px_-8px_rgba(0,0,0,0.9)]" style={{ background: FRAME[rank - 1] }}>
        <img src={src} alt="" width={size} height={size} className="h-full w-full rounded-[13.5px] bg-canvas object-cover" />
      </span>
      {rank === 1 && <CrownBadge className="absolute -left-2.5 -top-2.5 -rotate-12" />}
    </span>
  );
}

/**
 * Round avatar in a `size` box: ranks 1-3 sit in a gold, rose-bronze or
 * copper laurel wreath (#1 with a crown in its opening), the rest in a plain
 * bronze rim. Verified traders get the gold check.
 */
export function RankAvatar({ src, rank, size = 44, verified = false }: { src: string; rank: number; size?: number; verified?: boolean }) {
  const tier = rank >= 1 && rank <= 3 ? RANK_TIER[rank - 1] : null;
  const inner = Math.round(size * (tier ? 0.68 : 0.8));
  const k = size / 44;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <span className="relative" style={{ width: inner, height: inner }}>
        <img src={src} alt="" width={inner} height={inner} className={cx("h-full w-full rounded-full bg-canvas", !tier && "ring-1 ring-line")} />
        {verified && (
          <span className="absolute -bottom-0.5 -right-0.5 flex rounded-full bg-surface" style={{ padding: k }}>
            <BadgeCheck className="text-gold" style={{ width: 13 * k, height: 13 * k }} strokeWidth={2.25} aria-hidden />
          </span>
        )}
      </span>
      {tier && <Laurel size={size} inner={inner} tier={tier} />}
      {rank === 1 && <CrownGlyph className="absolute left-1/2 -translate-x-1/2 text-gold drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]" style={{ top: -4 * k, width: 13 * k, height: 13 * k }} />}
    </span>
  );
}

/* Podium ------------------------------------------------------------------ */

/** Gold edge of the #1 plaque: bright at the top left, burnished through the middle. */
const HERO_EDGE = "linear-gradient(135deg,rgba(251,227,196,0.95),rgba(229,169,103,0.6) 28%,rgba(107,76,56,0.7) 58%,rgba(229,169,103,0.75))";
/** Plaque sizes for ranks 2, 3 and 4: each step down is a little smaller, so the row cascades. */
const STEP_AVATAR: Record<number, number> = { 2: 60, 3: 52, 4: 44 };

/** Top four: a full-width #1 plaque, then #2-#4 stepping down beneath it. */
export function Podium({ entries, label, word, onOpen, className }: { entries: Entry[]; label: string; word: string; onOpen: (e: Entry, rank: number) => void; className?: string }) {
  const [first, ...rest] = entries.slice(0, 4);
  if (!first) return null;
  const aria = (e: Entry, rank: number) => `Rank ${rank}, ${e.name}: ${fmtUsd(e.value, e.money)} ${word}. Details`;
  return (
    <section aria-label="Top 4" className={cx("relative", className)}>
      <button type="button" onClick={() => onOpen(first, 1)} aria-label={aria(first, 1)} className="relative block w-full rounded-2xl p-px text-left shadow-lift transition-transform duration-100 ease-out active:scale-[0.99]" style={{ background: HERO_EDGE }}>
        <span className="brushed-dark relative flex items-center gap-3 overflow-hidden rounded-[15px] py-4 pl-2 pr-3.5">
          <span aria-hidden className="pointer-events-none absolute -left-14 -top-20 h-60 w-60 rounded-full bg-[radial-gradient(closest-side,rgba(229,169,103,0.17),transparent)]" />
          <span aria-hidden className="metal-text relative w-9 shrink-0 text-center font-display text-[54px] font-bold leading-none">1</span>
          <FramedAvatar src={first.avatar} size={76} rank={1} />
          <span className="relative min-w-0 flex-1 pl-0.5">
            <span className="block truncate text-[10.5px] font-bold uppercase leading-4 tracking-[0.1em] text-gold/85">{label}</span>
            <span className="mt-1 flex min-w-0 items-center gap-1">
              <span className="truncate text-[16px] font-semibold leading-5 text-cream">{first.name}</span>
              {first.verified && <BadgeCheck className="h-4 w-4 shrink-0 text-gold" aria-hidden />}
            </span>
            {/* One size down under 340px, so a six-figure value keeps its K. */}
            <span className={cx("mt-0.5 block truncate text-[24px] font-semibold leading-8 tracking-tight min-[340px]:text-[26px]", valueTone(first))}>{fmtUsd(first.value, first.money)}</span>
            <span className="block truncate text-[12px] leading-4 text-muted">{first.detail}</span>
          </span>
        </span>
      </button>
      {rest.length > 0 && (
        <div className="mt-2.5 grid grid-cols-3 items-end gap-2">
          {rest.map((e, i) => {
            const rank = i + 2;
            return (
              <button
                key={e.key}
                type="button"
                onClick={() => onOpen(e, rank)}
                aria-label={aria(e, rank)}
                className="relative flex w-full min-w-0 flex-col items-center rounded-xl border border-line bg-surface px-1.5 pb-2.5 pt-3.5 text-center shadow-panel transition-colors duration-100 ease-out active:bg-surface-2"
              >
                <span aria-hidden className="metal-text absolute left-2 top-1.5 font-display text-[24px] font-bold leading-none">
                  {rank}
                </span>
                <FramedAvatar src={e.avatar} size={STEP_AVATAR[rank]} rank={rank} />
                <span className="mt-2 block w-full truncate text-[12px] font-semibold leading-4 text-cream">{e.name}</span>
                <span className={cx("num mt-0.5 block w-full truncate text-[13px] font-semibold leading-4", valueTone(e))}>{fmtUsd(e.value, e.money)}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

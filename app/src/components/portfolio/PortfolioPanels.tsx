/**
 * The Portfolio tab panels for open positions, closed positions and your
 * callouts ("Replies"). Every card that goes to a coin page is a single link;
 * notes, stats and icons inside it are plain text.
 */
import { ArrowDownUp, ChevronRight, Eye, Heart, Megaphone, MessageCircle, Repeat2, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { age, compact, pct, tokens, usd, usdCompact, usdSigned } from "../../lib/format";
import type { Callout, Coin } from "../../lib/types";
import type { ClosedPosition, PositionNote } from "../../mock/portfolio";
import { useMarket } from "../../state/Market";
import type { Holding, Portfolio } from "../../state/usePortfolio";
import { ChangePill, cx } from "../ui/primitives";
import { Segment } from "./Segment";
import { shortDate } from "./shared";

const up = (n: number) => n >= 0;
const tone = (n: number) => (up(n) ? "text-gold" : "text-ember");
const signedPct = (f: number) => `${up(f) ? "up" : "down"} ${pct(Math.abs(f), 1, false)}`;

/** Coin thumbnail with a fine burnished-copper frame. */
function Thumb({ coin, size }: { coin: Coin; size: 32 | 44 | 56 }) {
  const cls = size === 56 ? "h-14 w-14 rounded-xl" : size === 44 ? "h-11 w-11 rounded-[10px]" : "h-8 w-8 rounded-lg";
  return <img src={coin.image} alt="" width={size} height={size} loading="lazy" decoding="async" className={cx("shrink-0 border border-line-accent bg-canvas-2 object-cover", cls)} />;
}

/** An icon and a count, with the noun for screen readers. */
function Count({ icon: Icon, n, noun }: { icon: LucideIcon; n: number; noun: string }) {
  return (
    <span className="num inline-flex shrink-0 items-center gap-1">
      <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      {compact(n)}
      <span className="sr-only"> {noun}</span>
    </span>
  );
}

export function EmptyNote({ children }: { children: string }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13.5px] text-muted">{children}</p>;
}

/* Open ------------------------------------------------------------------- */

const SORTS = ["Size", "PnL"] as const;
type Sort = (typeof SORTS)[number];

/** The holder's thesis attached under a position: a quoted note with its engagement. */
function Thesis({ note, now }: { note: PositionNote; now: number }) {
  return (
    <div className="mt-3 border-l-2 border-copper/50 pl-3">
      <p className="line-clamp-3 text-[13.5px] leading-[19px] text-cream/90">{note.text}</p>
      <div className="mt-2 flex items-center gap-3 text-[11.5px] leading-4 text-muted">
        <span className="min-w-0 flex-1 truncate">Updated {age(now - note.updatedAt)} ago</span>
        <Count icon={Heart} n={note.likes} noun="likes" />
        <Count icon={Repeat2} n={note.reposts} noun="reposts" />
        <Count icon={Eye} n={note.views} noun="views" />
      </div>
    </div>
  );
}

/**
 * One open position. The coin name is the card's only link, stretched over
 * the whole card by its ::before, so the thesis stays readable text.
 */
function HoldingCard({ h, now }: { h: Holding; now: number }) {
  const { coin } = h;
  const amount = `${tokens(h.tokens)} ${coin.ticker}`;
  return (
    <li className="relative rounded-xl border border-line bg-surface p-3 transition-colors duration-100 ease-out active:bg-surface-2 md:hover:border-line-accent md:hover:bg-surface-2">
      <div className="flex items-center gap-3">
        <Thumb coin={coin} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <Link
              to={`/coin/${coin.mint}`}
              aria-label={`${coin.name}: ${amount} worth ${usd(h.valueUsd)}, unrealized ${usdSigned(h.pnlUsd)}, ${signedPct(h.pnlPct)}`}
              className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-5 text-cream outline-none before:absolute before:inset-0 before:z-[1] before:rounded-xl focus-visible:before:outline focus-visible:before:outline-2 focus-visible:before:outline-offset-2 focus-visible:before:outline-gold"
            >
              {coin.name}
            </Link>
            <span aria-hidden className="num shrink-0 text-[15px] font-semibold leading-5 text-cream">
              {usd(h.valueUsd)}
            </span>
          </div>
          <div aria-hidden className="mt-1.5 flex items-center gap-2">
            <span className="num min-w-0 flex-1 truncate text-[12.5px] leading-[18px] text-muted">{amount}</span>
            <span className={cx("num shrink-0 text-[12.5px] font-semibold leading-[18px]", tone(h.pnlUsd))}>{usdSigned(h.pnlUsd)}</span>
            <ChangePill value={h.pnlPct} size="xs" soft />
          </div>
        </div>
      </div>
      {h.note && <Thesis note={h.note} now={now} />}
    </li>
  );
}

export function OpenPanel({ p, onBalance }: { p: Portfolio; onBalance: () => void }) {
  const [sort, setSort] = useState<Sort>("Size");
  const [now] = useState(() => Date.now());
  // usePortfolio already lists the largest position first.
  const list = useMemo(() => (sort === "Size" ? p.holdings : [...p.holdings].sort((a, b) => b.pnlUsd - a.pnlUsd)), [p.holdings, sort]);
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={onBalance} aria-haspopup="dialog" aria-label={`Balance: ${usd(p.cashUsd)} in SOL. Details`} className="-ml-1.5 flex h-11 min-w-0 items-center gap-1.5 rounded-lg px-1.5 transition-colors duration-100 ease-out hover:bg-surface active:bg-surface-2">
          <span className="text-[14px] font-medium text-muted">Balance</span>
          <span className="num truncate text-[15px] font-semibold text-cream">{usd(p.cashUsd)}</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          <ArrowDownUp className="h-3.5 w-3.5 text-muted" aria-hidden />
          <Segment label="Sort positions by" options={SORTS} value={sort} onChange={setSort} />
        </div>
      </div>
      {list.length ? (
        <ul aria-label={`Open positions, by ${sort === "Size" ? "size" : "PnL"}`} className="mt-2 flex flex-col gap-2.5">
          {list.map((h) => (
            <HoldingCard key={h.coin.mint} h={h} now={now} />
          ))}
        </ul>
      ) : (
        <div className="mt-2">
          <EmptyNote>No open positions. Buy a coin from the board and it shows up here.</EmptyNote>
        </div>
      )}
    </div>
  );
}

/* Closed ----------------------------------------------------------------- */

function ClosedRow({ c, coin }: { c: ClosedPosition; coin: Coin }) {
  const amount = `${compact(c.tokens, 2)} ${coin.ticker}`;
  const date = shortDate.format(c.closedAt);
  return (
    <li>
      <Link
        to={`/coin/${coin.mint}`}
        aria-label={`${coin.name}: sold ${amount} on ${date}. Bought for ${usd(c.entryUsd)}, sold for ${usd(c.exitUsd)}, realized ${usdSigned(c.pnlUsd)}, ${signedPct(c.pnlPct)}`}
        className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 transition-colors duration-100 ease-out active:bg-surface-2 md:hover:border-line-accent md:hover:bg-surface-2"
      >
        <Thumb coin={coin} size={44} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold leading-5 text-cream">{coin.name}</span>
            <span className={cx("num shrink-0 text-[14.5px] font-semibold leading-5", tone(c.pnlUsd))}>{usdSigned(c.pnlUsd)}</span>
          </span>
          <span className="mt-1 flex items-center gap-2">
            <span className="num min-w-0 flex-1 truncate text-[12.5px] leading-[18px] text-muted">
              {usd(c.entryUsd)} <span className="text-muted/70">→</span> <span className="text-cream/90">{usd(c.exitUsd)}</span>
            </span>
            <ChangePill value={c.pnlPct} size="xs" soft />
          </span>
          <span className="num mt-0.5 block truncate text-[11.5px] leading-4 text-muted">
            {amount} · closed {date}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function ClosedPanel({ closed }: { closed: ClosedPosition[] }) {
  const { byMint } = useMarket();
  const rows = closed.flatMap((c) => {
    const coin = byMint.get(c.mint);
    return coin ? [{ c, coin }] : [];
  });
  const realized = rows.reduce((n, r) => n + r.c.pnlUsd, 0);
  const wins = rows.filter((r) => r.c.pnlUsd > 0).length;
  if (!rows.length) return <EmptyNote>Nothing sold yet. Positions you close land here with their realized PnL.</EmptyNote>;
  return (
    <div>
      <div className="flex min-h-11 items-center justify-between gap-3">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="text-[14px] font-medium text-muted">Realized</span>
          <span className={cx("num truncate text-[15px] font-semibold", tone(realized))}>{usdSigned(realized)}</span>
        </p>
        <p className="num shrink-0 text-[12.5px] text-muted">
          {wins} of {rows.length} in profit
        </p>
      </div>
      <ul aria-label="Closed positions, newest first" className="mt-2 flex flex-col gap-2.5">
        {/* A coin can be sold more than once (your demo sells come first). */}
        {rows.map((r, i) => (
          <ClosedRow key={`${r.c.mint}:${r.c.closedAt}:${i}`} c={r.c} coin={r.coin} />
        ))}
      </ul>
    </div>
  );
}

/* Replies ---------------------------------------------------------------- */

/**
 * Four of the demo callouts, shown as yours (newest first): coins you hold
 * are picked first, one per coin. Their position figures belong to the
 * original caller, so the card shows only the call itself (market cap then
 * and now).
 */
function useYourCallouts(p: Portfolio) {
  const { callouts, byMint } = useMarket();
  const held = useMemo(() => new Set(p.holdings.map((h) => h.coin.mint)), [p.holdings]);
  return useMemo(() => {
    const seen = new Set<string>();
    const out: { c: Callout; coin: Coin }[] = [];
    const ordered = [...callouts].sort((a, b) => Number(held.has(b.mint)) - Number(held.has(a.mint)) || b.ts - a.ts);
    for (const c of ordered) {
      const coin = byMint.get(c.mint);
      if (!coin || seen.has(c.mint)) continue;
      seen.add(c.mint);
      out.push({ c, coin });
      if (out.length === 4) break;
    }
    return out.sort((a, b) => b.c.ts - a.c.ts);
  }, [callouts, byMint, held]);
}

function CalloutCard({ c, coin, p, now }: { c: Callout; coin: Coin; p: Portfolio; now: number }) {
  const move = c.calledAtMcap > 0 ? coin.mcapUsd / c.calledAtMcap - 1 : 0;
  return (
    <li>
      <article aria-label={`Your callout on ${coin.ticker}, ${age(now - c.ts)} ago`} className="rounded-xl border border-line bg-surface p-3">
        <div className="flex items-center gap-2.5">
          <img src={p.avatar} alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-full ring-1 ring-copper/70 ring-offset-1 ring-offset-surface" />
          <p className="min-w-0 flex-1 truncate text-[13px] leading-[18px]">
            <span className="font-semibold text-cream">{p.handle}</span> <span className="text-muted">· {age(now - c.ts)}</span>
          </p>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2 text-[11px] font-semibold leading-5 text-copper">
            <Megaphone className="h-3 w-3" strokeWidth={2.25} aria-hidden />
            Callout
          </span>
        </div>
        <p className="mt-2 line-clamp-4 text-[14px] leading-5 text-cream/95">{c.text}</p>
        <Link
          to={`/coin/${coin.mint}`}
          aria-label={`${coin.name} ($${coin.ticker}): called at ${usdCompact(c.calledAtMcap)} market cap, now ${usdCompact(coin.mcapUsd)}, ${signedPct(move)}`}
          className="mt-2.5 flex min-h-11 items-center gap-2.5 rounded-lg border border-line bg-canvas-2 py-1.5 pl-1.5 pr-2 transition-colors duration-100 ease-out active:bg-surface-2 md:hover:border-line-accent"
        >
          <Thumb coin={coin} size={32} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-[18px] text-cream">${coin.ticker}</span>
            <span className="num block truncate text-[11.5px] leading-4 text-muted">
              Called at {usdCompact(c.calledAtMcap)} <span className="text-muted/70">→</span> <span className="text-cream/90">{usdCompact(coin.mcapUsd)}</span>
            </span>
          </span>
          <ChangePill value={move} size="xs" soft />
          <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        </Link>
        <div className="mt-2.5 flex items-center gap-4 text-[12px] leading-4 text-muted">
          <Count icon={Eye} n={c.views} noun="views" />
          <Count icon={Heart} n={c.likes} noun="likes" />
          <Count icon={MessageCircle} n={c.comments} noun="replies" />
          <Count icon={Repeat2} n={c.shares} noun="reposts" />
        </div>
      </article>
    </li>
  );
}

export function RepliesPanel({ p }: { p: Portfolio }) {
  const mine = useYourCallouts(p);
  const [now] = useState(() => Date.now());
  if (!mine.length) return <EmptyNote>No callouts yet. Post a public call on a coin you hold and it shows up here.</EmptyNote>;
  return (
    <div>
      <p className="flex min-h-11 items-center text-[13px] text-muted">Your public calls on coins, newest first.</p>
      <ul aria-label="Your callouts" className="mt-1 flex flex-col gap-2.5">
        {mine.map(({ c, coin }) => (
          <CalloutCard key={c.id} c={c} coin={coin} p={p} now={now} />
        ))}
      </ul>
    </div>
  );
}

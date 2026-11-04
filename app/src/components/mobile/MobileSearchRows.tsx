/**
 * Rows for the search page (spec 2D): coin rows (framed thumbnail, name,
 * ticker and age, optionally the market cap and 24h change), creator rows
 * and the Trending chips, plus the matching that ranks search results.
 * A row's remove button sits beside its link, never inside it.
 */
import { TrendingUp, X } from "lucide-react";
import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { age, pct, shortAddr, usdCompact } from "../../lib/format";
import type { Coin, Trader } from "../../lib/types";
import { ChangePill, cx } from "../ui/primitives";
import { TraderAvatar } from "../ui/visuals";
import { AgeLabel, IconButton } from "./MobileUi";

/** What a query is compared with: trimmed, lowercase, without a leading `$` (tickers) or `@` (handles). */
export const normalizeQuery = (q: string) =>
  q
    .trim()
    .replace(/^[$@]+/, "")
    .toLowerCase();

export interface CoinHit {
  coin: Coin;
  /** True when only the mint address matched (a pasted contract address). */
  byMint: boolean;
}

/** Lower is better: exact ticker, exact name, ticker prefix, name prefix, word prefix, anywhere, then mint prefix. */
function coinScore(c: Coin, s: string): number | null {
  const t = c.ticker.toLowerCase();
  const n = c.name.toLowerCase();
  if (t === s) return 0;
  if (n === s) return 1;
  if (t.startsWith(s)) return 2;
  if (n.startsWith(s)) return 3;
  if (n.split(/[\s-]+/).some((w) => w.startsWith(s))) return 4;
  if (t.includes(s) || n.includes(s)) return 5;
  // Two characters would match a random mint now and then; three almost never do.
  if (s.length >= 3 && c.mint.toLowerCase().startsWith(s)) return 6;
  return null;
}

/** Coins whose name, ticker or mint (prefix) match, best matches first, then by 24h volume; `total` counts past the limit. */
export function searchCoins(coins: Coin[], s: string, limit = 20): { hits: CoinHit[]; total: number } {
  if (!s) return { hits: [], total: 0 };
  const ranked = coins
    .flatMap((coin) => {
      const score = coinScore(coin, s);
      return score === null ? [] : [{ coin, score }];
    })
    .sort((a, b) => a.score - b.score || b.coin.vol24hUsd - a.coin.vol24hUsd);
  return { hits: ranked.slice(0, limit).map(({ coin, score }) => ({ coin, byMint: score === 6 })), total: ranked.length };
}

/** Creators by handle or display name, best matches first, then by today's PnL (the leaderboard order); `total` counts past the limit. */
export function searchCreators(traders: Trader[], s: string, limit = 8): { hits: Trader[]; total: number } {
  if (!s) return { hits: [], total: 0 };
  const score = (t: Trader) => {
    const h = t.handle.toLowerCase();
    const n = t.name.toLowerCase();
    if (h === s) return 0;
    if (h.startsWith(s)) return 1;
    if (n.startsWith(s)) return 2;
    return h.includes(s) || n.includes(s) ? 3 : null;
  };
  const ranked = traders
    .flatMap((t) => {
      const sc = score(t);
      return sc === null ? [] : [{ t, sc }];
    })
    .sort((a, b) => a.sc - b.sc || b.t.pnl["1D"] - a.t.pnl["1D"]);
  return { hits: ranked.slice(0, limit).map(({ t }) => t), total: ranked.length };
}

/** The coins with the most 24h volume, best first. */
export const topByVolume = (coins: Coin[], n: number) => [...coins].sort((a, b) => b.vol24hUsd - a.vol24hUsd).slice(0, n);

/** `text` with the first case-insensitive match of the normalized query in gold. */
function Highlight({ text, query }: { text: string; query: string }) {
  const lower = text.toLowerCase();
  // Lowercasing can change the length of some non-ASCII text, which would shift the slice.
  const i = query && lower.length === text.length ? lower.indexOf(query) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent text-gold">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

const signedUsd = (n: number) => `${n >= 0 ? "+" : "-"}${usdCompact(Math.abs(n))}`;

/** Spoken version of a coin row, since the arrow icons and abbreviations don't read aloud well. */
function coinLabel(coin: Coin, now: number, figures: boolean) {
  const parts = [`${coin.name} ($${coin.ticker})`];
  if (figures) parts.push(`market cap ${usdCompact(coin.mcapUsd)}`, `${coin.change24h >= 0 ? "up" : "down"} ${pct(Math.abs(coin.change24h), 1, false)} in 24 hours`);
  parts.push(`launched ${age(now - coin.createdAt)} ago`);
  return parts.join(", ");
}

/**
 * One coin: a link to its page, and an optional 44px remove button beside it.
 * `figures` adds the market cap and 24h change on the right; `wash` tints
 * the row faintly from the right, gold for a 24h gain and ember for a loss.
 */
export function CoinSearchRow({
  coin,
  now,
  thumb,
  figures = false,
  wash = false,
  query = "",
  byMint = false,
  onPick,
  onRemove,
  removeLabel,
}: {
  coin: Coin;
  now: number;
  /** Thumbnail size in px. */
  thumb: 56 | 60;
  figures?: boolean;
  wash?: boolean;
  /** Normalized query to highlight in the name and ticker. */
  query?: string;
  byMint?: boolean;
  onPick?: () => void;
  onRemove?: (e: MouseEvent<HTMLButtonElement>) => void;
  removeLabel?: string;
}) {
  const up = coin.change24h >= 0;
  // Rows bleed 8px left so thumbnails line up with the section titles while the press state has room. The
  // right edge stays on the content edge when something visible ends there (the wash, the remove button);
  // plain rows bleed both ways so their figures end on it.
  const bleed = wash || onRemove ? "-ml-2" : "-mx-2";
  return (
    <li
      className={cx(
        "flex items-center rounded-xl",
        bleed,
        wash && "bg-gradient-to-l via-35% to-transparent to-70%",
        wash && (up ? "from-gold/[0.08] via-gold/[0.03]" : "from-ember/[0.1] via-ember/[0.035]"),
      )}
    >
      <Link
        to={`/coin/${coin.mint}`}
        onClick={onPick}
        aria-label={coinLabel(coin, now, figures)}
        className={cx("flex min-w-0 flex-1 items-center gap-3 rounded-xl py-2 pl-2 transition-colors duration-100 ease-out active:bg-surface-2/80 md:hover:bg-surface-2/70", onRemove ? "pr-1" : wash ? "pr-2.5" : "pr-2")}
      >
        <img
          src={coin.image}
          alt=""
          width={thumb}
          height={thumb}
          loading="lazy"
          decoding="async"
          className={cx("shrink-0 rounded-xl border border-line-accent bg-canvas-2 object-cover", thumb === 60 ? "h-[60px] w-[60px]" : "h-14 w-14")}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[15px] font-semibold leading-5 text-cream">
            <Highlight text={coin.name} query={byMint ? "" : query} />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-4 text-muted">
            <span className="min-w-0 truncate font-medium">
              $<Highlight text={coin.ticker} query={byMint ? "" : query} />
            </span>
            {byMint ? (
              <span className="shrink-0 font-mono text-[11.5px] text-rosebronze">{shortAddr(coin.mint, 5)}</span>
            ) : (
              // Under 360px a row with figures drops the age, so the ticker keeps its room.
              <span className={cx("flex shrink-0", figures && "max-[359px]:hidden")}>
                <AgeLabel ms={now - coin.createdAt} />
              </span>
            )}
          </span>
        </span>
        {figures && (
          <span className="flex shrink-0 flex-col items-end gap-1">
            <span className="num text-[15px] font-bold leading-5 text-cream">{usdCompact(coin.mcapUsd)}</span>
            <span className="flex leading-4">
              {/* The softer loss tint keeps ember at 4.5:1 over the row's ember wash. */}
              <ChangePill value={coin.change24h} soft={wash} />
            </span>
          </span>
        )}
      </Link>
      {onRemove && removeLabel && (
        <IconButton label={removeLabel} onClick={onRemove} data-remove="" className="md:hover:bg-surface-2 md:hover:text-cream">
          <X className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
        </IconButton>
      )}
    </li>
  );
}

/** A creator match: avatar, @handle, name and squad, today's PnL. Opens the leaderboard. */
export function CreatorRow({ trader, query, onPick }: { trader: Trader; query: string; onPick?: () => void }) {
  const pnl = trader.pnl["1D"];
  return (
    <li className="-mx-2">
      <Link
        to="/leaderboard"
        onClick={onPick}
        aria-label={`@${trader.handle}${trader.verified ? ", verified" : ""}, ${trader.squad ?? "no squad"}, ${signedUsd(pnl)} profit today. Opens the leaderboard`}
        className="flex items-center gap-3 rounded-xl p-2 transition-colors duration-100 ease-out active:bg-surface-2/80 md:hover:bg-surface-2/70"
      >
        <span className="flex h-14 w-14 shrink-0 items-center justify-center">
          <TraderAvatar src={trader.avatar} size={48} verified={trader.verified} ring="bronze" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[15px] font-semibold leading-5 text-cream">
            @<Highlight text={trader.handle} query={query} />
          </span>
          <span className="truncate text-[13px] leading-4 text-muted">
            <Highlight text={trader.name} query={query} /> · {trader.squad ?? "No squad"}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className={cx("num text-[15px] font-bold leading-5", pnl >= 0 ? "text-gold" : "text-ember")}>{signedUsd(pnl)}</span>
          <span className="text-[11.5px] font-medium leading-4 text-muted">1D PnL</span>
        </span>
      </Link>
    </li>
  );
}

/** Ticker chips that start a search for that coin (44px tall). */
export function TrendingChips({ coins, onPick, label = "Trending" }: { coins: Coin[]; onPick: (coin: Coin) => void; label?: string }) {
  if (!coins.length) return null;
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-muted">
        <TrendingUp className="h-3.5 w-3.5 text-copper" strokeWidth={2.25} aria-hidden />
        {label}
      </p>
      <ul className="mt-2.5 flex flex-wrap gap-2">
        {coins.map((c) => (
          <li key={c.mint}>
            <button
              type="button"
              onClick={() => onPick(c)}
              aria-label={`Search for $${c.ticker}`}
              className="chip h-11 gap-2 rounded-full pl-1.5 pr-3.5 text-[13px] font-semibold text-cream active:bg-surface-2 md:h-10"
            >
              <img src={c.image} alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-full border border-line-accent object-cover" />${c.ticker}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

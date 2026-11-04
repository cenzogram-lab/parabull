/**
 * The search page's resting sections (spec 2D), Recent searches and
 * Recently viewed, and the coin and creator results that replace them
 * while you type.
 */
import { SearchX, TrendingUp } from "lucide-react";
import { useRef, type MouseEvent } from "react";
import type { Coin, Trader } from "../../lib/types";
import { CoinSearchRow, CreatorRow, TrendingChips, type CoinHit } from "./MobileSearchRows";
import { SectionHeader } from "./MobileUi";

/**
 * Keeps keyboard focus in a section whose rows are being removed: after a
 * remove button takes its row away, focus goes to the next row's button
 * (else the previous one, else the heading); after Clear All, to the
 * heading. Taps that never focused anything leave focus alone, so the
 * on-screen keyboard never pops up.
 */
function useListFocus() {
  const section = useRef<HTMLElement>(null);
  const heading = () => {
    const h = section.current?.querySelector<HTMLElement>("h2");
    h?.setAttribute("tabindex", "-1");
    return h;
  };
  const afterRender = (move: () => void) => requestAnimationFrame(move);
  const remove = (index: number, e: MouseEvent<HTMLButtonElement>, run: () => void) => {
    const hadFocus = document.activeElement === e.currentTarget;
    run();
    if (!hadFocus) return;
    afterRender(() => {
      const buttons = section.current?.querySelectorAll<HTMLElement>("[data-remove]");
      (buttons?.[index] ?? buttons?.[index - 1] ?? heading())?.focus({ preventScroll: true });
    });
  };
  const clear = (run: () => void) => {
    const hadFocus = !!section.current?.contains(document.activeElement);
    run();
    if (hadFocus) afterRender(() => heading()?.focus({ preventScroll: true }));
  };
  return { section, remove, clear };
}

export function RecentSearches({ coins, now, trending, onPick, onRemove, onClear, onTrending }: { coins: Coin[]; now: number; trending: Coin[]; onPick: (coin: Coin) => void; onRemove: (mint: string) => void; onClear: () => void; onTrending: (coin: Coin) => void }) {
  const focus = useListFocus();
  return (
    <section ref={focus.section}>
      <SectionHeader title="Recent searches" action={coins.length ? { label: "Clear All", ariaLabel: "Clear all recent searches", onClick: () => focus.clear(onClear) } : undefined} />
      {coins.length ? (
        <ul className="flex flex-col">
          {coins.map((c, i) => (
            <CoinSearchRow key={c.mint} coin={c} now={now} thumb={56} onPick={() => onPick(c)} onRemove={(e) => focus.remove(i, e, () => onRemove(c.mint))} removeLabel={`Remove ${c.name} from recent searches`} />
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-4 pb-1">
          <p className="text-[13px] leading-5 text-muted">Coins you open from search will show up here.</p>
          <TrendingChips coins={trending} onPick={onTrending} />
        </div>
      )}
    </section>
  );
}

/** Coin pages you opened, newest first; before you've opened any, the most traded coins instead. */
export function RecentlyViewed({ coins, popular, now, onPick, onPickPopular, onRemove, onClear }: { coins: Coin[]; popular: Coin[]; now: number; onPick: (coin: Coin) => void; onPickPopular: (coin: Coin) => void; onRemove: (mint: string) => void; onClear: () => void }) {
  const focus = useListFocus();
  const viewed = coins.length > 0;
  if (!viewed && !popular.length) return null;
  return (
    <section ref={focus.section}>
      <SectionHeader
        title="Recently viewed"
        action={viewed ? { label: "Clear All", ariaLabel: "Clear all recently viewed coins", onClick: () => focus.clear(onClear) } : undefined}
        note={
          viewed ? undefined : (
            <>
              <TrendingUp className="h-3.5 w-3.5 text-copper" strokeWidth={2.25} aria-hidden />
              Popular right now
            </>
          )
        }
      />
      <ul className="flex flex-col gap-1">
        {viewed
          ? coins.map((c, i) => <CoinSearchRow key={c.mint} coin={c} now={now} thumb={60} figures wash onPick={() => onPick(c)} onRemove={(e) => focus.remove(i, e, () => onRemove(c.mint))} removeLabel={`Remove ${c.name} from recently viewed`} />)
          : popular.map((c) => <CoinSearchRow key={c.mint} coin={c} now={now} thumb={60} figures wash onPick={() => onPickPopular(c)} />)}
      </ul>
    </section>
  );
}

function ResultsHeading({ title, count }: { title: string; count: number }) {
  return (
    <h2 className="flex min-h-11 items-center gap-2 text-[15px] font-semibold text-cream">
      {title}
      <span className="num rounded-full border border-line-soft bg-surface px-2 text-[12px] font-semibold leading-5 text-muted">{count}</span>
    </h2>
  );
}

function MoreHint({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return <p className="pt-2 text-center text-[12.5px] leading-5 text-muted">Showing the top {shown} of {total}. Keep typing to narrow it down.</p>;
}

/** Matches for the query, or a friendly empty state with a few trending coins to try. */
export function SearchResults({ query, display, coins, creators, now, suggestions, onPickCoin, onPickCreator, onSuggestion }: {
  /** Normalized query, for highlighting. */
  query: string;
  /** The query as typed, for the empty state. */
  display: string;
  coins: { hits: CoinHit[]; total: number };
  creators: { hits: Trader[]; total: number };
  now: number;
  suggestions: Coin[];
  onPickCoin: (coin: Coin) => void;
  onPickCreator: () => void;
  onSuggestion: (coin: Coin) => void;
}) {
  if (!coins.hits.length && !creators.hits.length)
    return (
      <div className="flex flex-col items-center pt-8 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full border border-line bg-surface text-copper shadow-panel" aria-hidden>
          <SearchX className="h-6 w-6" strokeWidth={1.9} />
        </span>
        {/* A pasted address is one long word: shorten it, and let anything else wrap anywhere. */}
        <h2 className="mt-4 w-full text-[16px] font-semibold leading-6 text-cream [overflow-wrap:anywhere]">Nothing matches “{display.length > 32 ? `${display.slice(0, 30)}…` : display}”</h2>
        <p className="mt-1.5 max-w-xs text-[13px] leading-5 text-muted">Check the spelling, try a ticker or a creator’s @handle, or paste a coin’s mint address.</p>
        <div className="mt-7 w-full text-left">
          <TrendingChips coins={suggestions} onPick={onSuggestion} label="Try a trending coin" />
        </div>
      </div>
    );
  return (
    <>
      {coins.hits.length > 0 && (
        <section>
          <ResultsHeading title="Coins" count={coins.total} />
          <ul className="flex flex-col">
            {coins.hits.map(({ coin, byMint }) => (
              <CoinSearchRow key={coin.mint} coin={coin} now={now} thumb={56} figures query={query} byMint={byMint} onPick={() => onPickCoin(coin)} />
            ))}
          </ul>
          <MoreHint shown={coins.hits.length} total={coins.total} />
        </section>
      )}
      {creators.hits.length > 0 && (
        <section className={coins.hits.length ? "mt-5" : undefined}>
          <ResultsHeading title="Creators" count={creators.total} />
          <ul className="flex flex-col">
            {creators.hits.map((t) => (
              <CreatorRow key={t.handle} trader={t} query={query} onPick={onPickCreator} />
            ))}
          </ul>
          <MoreHint shown={creators.hits.length} total={creators.total} />
        </section>
      )}
    </>
  );
}

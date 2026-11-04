/**
 * Search (spec 2D). At rest it shows Recent searches (coins picked from
 * search) and Recently viewed (coin pages opened); typing swaps them for
 * coin and creator results. Below md the field is pinned above the bottom
 * nav (or the on-screen keyboard); from md up the same sections sit in a
 * centered column under an inline field.
 */
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { MobileSearchBar, SearchField } from "../components/mobile/MobileSearchBar";
import { normalizeQuery, searchCoins, searchCreators, topByVolume } from "../components/mobile/MobileSearchRows";
import { RecentlyViewed, RecentSearches, SearchResults } from "../components/mobile/MobileSearchSections";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useNow } from "../hooks/useNow";
import type { Coin } from "../lib/types";
import { useApp } from "../state/AppState";
import { useMarket } from "../state/Market";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function SearchPage() {
  const isMobile = useIsMobile();
  const now = useNow();
  const { coins, byMint, traders } = useMarket();
  const { searchHistory, addSearchHistory, removeSearchHistory, clearSearchHistory, recent, removeRecent, clearRecent } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  // The query comes back from the URL when you return from a result (see `remember`).
  const [query, setQuery] = useState(() => new URLSearchParams(location.search).get("q") ?? "");
  const input = useRef<HTMLInputElement>(null);
  const s = normalizeQuery(query);

  // Ranked once: the demo keeps trading, and the chips and suggestions shouldn't reshuffle under your finger.
  const [ranked] = useState(() => topByVolume(coins, 11).map((c) => c.mint));
  const lookup = (mints: string[]) => mints.flatMap((m) => byMint.get(m) ?? []);
  const searched = lookup(searchHistory);
  const viewed = lookup(recent);
  const popular = viewed.length ? [] : lookup(ranked.slice(0, 5));
  // The Trending chips skip whatever the Popular rows already show.
  const trending = lookup(popular.length ? ranked.slice(5, 11) : ranked.slice(0, 6));

  const coinHits = useMemo(() => searchCoins(coins, s), [coins, s]);
  const creatorHits = useMemo(() => searchCreators(traders, s), [traders, s]);

  // Search in the nav (or ⌘K) while you're already here: back to the field.
  const firstKey = useRef(location.key);
  useEffect(() => {
    if (location.key !== firstKey.current) input.current?.focus();
  }, [location.key]);

  /** Writes the query into this history entry, so Back from a result restores it. */
  const remember = () => {
    const params = new URLSearchParams(location.search);
    if (query.trim()) params.set("q", query.trim());
    else params.delete("q");
    const qs = params.toString();
    const search = qs ? `?${qs}` : "";
    if (search !== location.search) navigate({ pathname: location.pathname, search }, { replace: true });
  };
  /** A coin opened from this page goes to the top of Recent searches. */
  const pickCoin = (coin: Coin) => {
    remember();
    // React Router changes routes in a transition; updating the history in the same one means this page never re-renders with the list reshuffled on the way out.
    startTransition(() => addSearchHistory(coin.mint));
  };
  const startSearch = (coin: Coin) => {
    setQuery(`$${coin.ticker}`);
    // The chip goes away with the resting sections, so put keyboard focus back in the field (on a phone that would raise the keyboard over the results).
    if (!isMobile) input.current?.focus();
  };
  const submit = () => {
    // On a phone the keyboard's Search key tucks the keyboard away so the results show; on desktop Enter opens the best match.
    if (isMobile) return input.current?.blur();
    const top = coinHits.hits[0]?.coin;
    if (top) {
      pickCoin(top);
      navigate(`/coin/${top.mint}`);
    } else if (creatorHits.hits.length) {
      remember();
      navigate("/leaderboard");
    }
  };

  const body = s ? (
    <SearchResults query={s} display={query.trim()} coins={coinHits} creators={creatorHits} now={now} suggestions={lookup(ranked.slice(0, 6))} onPickCoin={pickCoin} onPickCreator={remember} onSuggestion={startSearch} />
  ) : (
    <>
      <RecentSearches coins={searched} now={now} trending={trending} onPick={pickCoin} onRemove={removeSearchHistory} onClear={clearSearchHistory} onTrending={startSearch} />
      <div className="mt-6">
        <RecentlyViewed coins={viewed} popular={popular} now={now} onPick={remember} onPickPopular={pickCoin} onRemove={removeRecent} onClear={clearRecent} />
      </div>
    </>
  );
  // Announced politely as you type.
  const status = s ? `${plural(coinHits.total, "coin", "coins")} and ${plural(creatorHits.total, "creator", "creators")} match` : "";
  const field = { value: query, onChange: setQuery, onSubmit: submit, inputRef: input };

  if (isMobile)
    return (
      // pb-8 on top of the shell's nav padding: the last row ends clear of the pinned bar.
      <div className="px-4 pb-8 pt-2">
        <h1 className="sr-only">Search</h1>
        <p role="status" className="sr-only">
          {status}
        </p>
        {body}
        <MobileSearchBar {...field} />
      </div>
    );

  return (
    <div className="mx-auto w-full max-w-xl px-6 pb-16 pt-8">
      <h1 className="text-2xl font-semibold tracking-tight text-cream">Search</h1>
      <SearchField {...field} className="mt-4" />
      <p role="status" className="sr-only">
        {status}
      </p>
      <div className="mt-6">{body}</div>
    </div>
  );
}

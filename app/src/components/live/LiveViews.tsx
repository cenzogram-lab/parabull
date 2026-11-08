/**
 * Real live streams (Cloudflare Stream, hooks/useLiveStreams.ts) in the app's pages:
 * - `StreamLivePage`: /live when streaming is configured. The chosen stream plays beside its coin's chat; the other
 *   coins live now are listed under it. Nobody live: an empty state, not demo streams.
 * - `CoinLivePanel`: on a coin's page, while that coin is live, its stream above the chart.
 */
import { ArrowRight, Radio } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { shortWallet } from "../../lib/chatMessage";
import { usdCompact } from "../../lib/format";
import type { LiveStream } from "../../lib/stream";
import type { LiveState } from "../../hooks/useLiveStreams";
import { useMarket } from "../../state/Market";
import { CoinChat } from "../coin/CoinChat";
import { ChangePill, cx } from "../ui/primitives";
import { StreamPlayer } from "./StreamPlayer";

function useCoinLabel() {
  const { byMint } = useMarket();
  return (s: LiveStream) => {
    const coin = byMint.get(s.mint);
    return { coin, name: coin ? `$${coin.ticker}` : shortWallet(s.mint), title: s.title ?? (coin ? `${coin.name} live` : "Live stream") };
  };
}

export function StreamLivePage({ live }: { live: LiveState }) {
  const label = useCoinLabel();
  const [picked, setPicked] = useState<string | null>(null);
  const streams = live.streams;
  const hero = streams.find((s) => s.input === picked) ?? streams[0];
  const others = streams.filter((s) => s !== hero);

  return (
    <div className="px-8 py-6 max-md:px-4 max-md:py-4">
      <div className="flex items-center gap-3 max-md:flex-wrap max-md:gap-y-0.5">
        <h1 className="text-[28px] font-semibold tracking-tight max-md:text-[24px]">Live</h1>
        <span className="inline-flex items-center gap-1.5 text-sm text-muted" aria-live="polite">
          <Radio className="h-4 w-4 text-ember" aria-hidden /> {live.loaded ? `${streams.length} live now` : "Checking who's live…"}
        </span>
      </div>

      {live.error && <p className="mt-3 text-[13px] text-ember">{live.error}</p>}

      {!hero ? (
        live.loaded && (
          <div className="panel mt-5 flex flex-col items-center gap-2 px-6 py-14 text-center">
            <Radio className="h-7 w-7 text-muted" aria-hidden />
            <p className="text-[15px] font-semibold">Nobody is live right now</p>
            <p className="max-w-md text-[13px] text-muted">When a coin's creator starts streaming, it plays here with the coin's chat beside it.</p>
          </div>
        )
      ) : (
        <>
          <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2.2fr)_minmax(320px,1fr)] max-md:mt-3 max-md:gap-3">
            <div className="overflow-hidden rounded-2xl border border-line-accent/70 bg-surface shadow-lift">
              <StreamPlayer key={hero.input} src={hero.hls} title={label(hero).title} className="aspect-video" />
              <HeroCaption s={hero} />
            </div>
            {/* The stream's coin chat, fixed height and absolutely placed beside the player on xl (see /live demo). */}
            <div className="relative h-[420px] max-md:h-[360px] xl:h-auto">
              <CoinChat mint={hero.mint} className="panel h-full xl:absolute xl:inset-0" />
            </div>
          </div>
          {others.length > 0 && (
            <section className="mt-8" aria-labelledby="live-others">
              <h2 id="live-others" className="mb-3 text-lg font-semibold">
                Also live
              </h2>
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {others.map((s) => {
                  const l = label(s);
                  return (
                    <li key={s.input}>
                      <button type="button" onClick={() => (setPicked(s.input), window.scrollTo({ top: 0, behavior: "smooth" }))} className="hover-lift flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left">
                        {l.coin ? <img src={l.coin.image} alt="" className="h-10 w-10 rounded-lg" /> : <Radio className="h-10 w-10 rounded-lg bg-surface-2 p-2.5 text-ember" aria-hidden />}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-semibold">{l.title}</span>
                          <span className="block truncate text-xs text-muted">
                            {l.name}
                            {s.creator ? ` · ${shortWallet(s.creator)}` : ""}
                          </span>
                        </span>
                        <span className="rounded bg-candle-down px-1.5 text-[10px] font-bold uppercase text-cream">Live</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function HeroCaption({ s }: { s: LiveStream }) {
  const label = useCoinLabel();
  const l = label(s);
  return (
    <div className="flex items-center gap-3 p-3.5">
      {l.coin && <img src={l.coin.image} alt="" className="h-10 w-10 shrink-0 rounded-lg" />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold">{l.title}</div>
        <div className="flex items-center gap-2 text-[12.5px] text-muted">
          <span className="font-semibold text-cream">{l.name}</span>
          {l.coin && <span className="num">{usdCompact(l.coin.mcapUsd)} MC</span>}
          {l.coin && <ChangePill value={l.coin.change24h} size="xs" />}
          {s.creator && <span className="truncate">by {shortWallet(s.creator)}</span>}
        </div>
      </div>
      <Link to={`/coin/${s.mint}`} className="btn-gold h-10 shrink-0 px-4 max-md:h-11">
        Trade {l.name.startsWith("$") ? l.name : ""} <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}

/** A coin's stream on its page while it is live; nothing otherwise. */
export function CoinLivePanel({ live, mint, className }: { live: LiveState; mint: string; className?: string }) {
  const label = useCoinLabel();
  const s = live.streams.find((x) => x.mint === mint);
  if (!s) return null;
  const l = label(s);
  return (
    <section aria-label="Live stream" className={cx("overflow-hidden rounded-2xl border border-line-accent/70 bg-surface", className)}>
      {/* Capped on wide screens so the chart stays near the top; the video letterboxes in black. */}
      <StreamPlayer key={s.input} src={s.hls} title={l.title} className="aspect-video md:max-h-[420px] md:w-full" />
      <div className="flex items-center gap-2 px-3.5 py-2.5 text-[13px]">
        <span className="font-semibold">{l.title}</span>
        {s.creator && <span className="truncate text-muted">by {shortWallet(s.creator)}</span>}
      </div>
    </section>
  );
}

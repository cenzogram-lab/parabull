/**
 * The way into /live on a phone (the desktop sidebar link is hidden below md):
 * - `LiveChip`: a header chip with a pulsing dot, on every page;
 * - `LiveNowStrip`: "Live now" on the board, the most-watched streams in a swipeable row and a "See all" link.
 */
import { ChevronRight, Eye, Radio } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { streamArt } from "../../lib/art";
import { compact } from "../../lib/format";
import { useMarket } from "../../state/Market";
import { cx } from "../ui/primitives";

function PulseDot() {
  return (
    <span className="relative flex h-2 w-2" aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-ember" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-ember" />
    </span>
  );
}

/** Header chip to /live. Under 360px it keeps only the dot and icon so the portfolio capsule keeps its room. */
export function LiveChip() {
  const { pathname } = useLocation();
  const { streams } = useMarket();
  const here = pathname === "/live";
  const live = streams.filter((s) => s.kind === "live").length;
  return (
    <Link
      to="/live"
      aria-label={live ? `Live: ${live} streams` : "Live"}
      aria-current={here ? "page" : undefined}
      className={cx(
        "touch-target inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-bold transition-[transform,border-color] duration-100 ease-out active:scale-95",
        here ? "border-ember/60 bg-candle-down/30 text-cream" : "border-line text-cream",
      )}
    >
      <PulseDot />
      <span className="max-[359px]:hidden">Live</span>
      <Radio className="hidden h-3.5 w-3.5 max-[359px]:block" aria-hidden />
    </Link>
  );
}

/** The board's "Live now" row: up to six streams by viewers, each opening its coin; "See all" opens /live. */
export function LiveNowStrip() {
  const { streams, byMint } = useMarket();
  const live = streams
    .filter((s) => s.kind === "live" && byMint.has(s.mint))
    .sort((a, b) => b.viewers - a.viewers)
    .slice(0, 6);
  if (!live.length) return null;
  const watching = live.reduce((n, s) => n + s.viewers, 0);
  return (
    <section aria-labelledby="live-now" className="pt-3">
      <div className="flex items-center gap-2 px-4">
        <PulseDot />
        <h2 id="live-now" className="text-[14px] font-semibold">
          Live now
        </h2>
        <span className="text-xs text-muted">{compact(watching)} watching</span>
        <Link to="/live" className="touch-target ml-auto inline-flex items-center gap-0.5 text-[13px] font-semibold text-gold">
          See all <ChevronRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
      <ul className="scrollbar-none mt-2 flex snap-x snap-mandatory scroll-px-4 gap-2.5 overflow-x-auto px-4 pb-1">
        {live.map((s) => {
          const coin = byMint.get(s.mint)!;
          return (
            <li key={s.id} className="w-[148px] shrink-0 snap-start">
              <Link to={`/coin/${coin.mint}`} aria-label={`${s.title}: @${s.handle} live on $${coin.ticker}, ${s.viewers} watching`} className="block transition-opacity duration-100 ease-out active:opacity-80">
                <span className="relative block overflow-hidden rounded-xl border border-line">
                  <img src={streamArt(s.id)} alt="" className="aspect-video w-full object-cover" />
                  <span className="absolute bottom-1 left-1 inline-flex items-center gap-1 rounded bg-canvas/80 px-1 text-[10.5px] font-semibold">
                    <Eye className="h-3 w-3" aria-hidden /> {compact(s.viewers)}
                  </span>
                  <img src={coin.image} alt="" className="absolute bottom-1 right-1 h-6 w-6 rounded-md ring-2 ring-canvas" />
                </span>
                <span className="mt-1 block truncate text-[12.5px] font-semibold leading-4">{s.title}</span>
                <span className="block truncate text-[11.5px] leading-4 text-muted">
                  @{s.handle} · ${coin.ticker}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

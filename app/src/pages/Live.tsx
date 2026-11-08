import { ArrowRight, ChevronLeft, ChevronRight, Eye, Film, Radio, Users } from "lucide-react";
import { useRef } from "react";
import { Link } from "react-router-dom";
import { CoinChat } from "../components/coin/CoinChat";
import { StreamLivePage } from "../components/live/LiveViews";
import { useLiveStreams } from "../hooks/useLiveStreams";
import { ChangePill } from "../components/ui/primitives";
import { TraderAvatar } from "../components/ui/visuals";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useNow } from "../hooks/useNow";
import { streamArt } from "../lib/art";
import { age, compact, usdCompact } from "../lib/format";
import type { Coin, Stream, Trader } from "../lib/types";
import { useMarket } from "../state/Market";

function LivePill() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-candle-down px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-cream shadow-[inset_0_0_0_1px_#B5503A]">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-ember" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-ember" />
      </span>
      Live
    </span>
  );
}

function StreamCard({ s, coin, trader }: { s: Stream; coin?: Coin; trader?: Trader }) {
  const now = useNow();
  return (
    <Link to={coin ? `/coin/${coin.mint}` : "/live"} className="group w-[300px] shrink-0 max-md:w-[272px] max-md:snap-start">
      <div className="relative overflow-hidden rounded-xl border border-line">
        <img src={streamArt(s.id)} alt="" className="aspect-video w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
        <div className="absolute left-2 top-2">{s.kind === "live" ? <LivePill /> : <span className="rounded-md bg-canvas/80 px-1.5 py-0.5 text-[11px] font-semibold"><Film className="mr-1 inline h-3 w-3" />{`0:${String(s.durationSec).padStart(2, "0")}`}</span>}</div>
        <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-canvas/80 px-1.5 py-0.5 text-[11px] font-semibold">
          <Eye className="h-3 w-3" /> {compact(s.viewers)}
        </span>
        {coin && <img src={coin.image} alt="" className="absolute bottom-2 right-2 h-8 w-8 rounded-lg ring-2 ring-canvas" />}
      </div>
      <div className="mt-2.5 flex gap-2.5">
        <TraderAvatar src={trader?.avatar ?? ""} size={32} verified={trader?.verified} />
        <div className="min-w-0">
          <div className="line-clamp-2 text-[13.5px] font-semibold leading-5 group-hover:text-gold">{s.title}</div>
          <div className="text-xs text-muted">
            @{s.handle} · {s.kind === "live" ? `live for ${age(now - s.startedAt)}` : "clip"}
          </div>
          {coin && (
            <div className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11.5px]">
              <span className="font-semibold">${coin.ticker}</span>
              <span className="num text-muted">{usdCompact(coin.mcapUsd)}</span>
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

function Row({ title, icon: Icon, streams }: { title: string; icon: typeof Users; streams: Stream[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const { byMint, traders } = useMarket();
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * 640, behavior: "smooth" });
  return (
    <section className="mt-10 max-md:mt-8">
      <div className="mb-4 flex items-center gap-2 max-md:mb-3">
        <Icon className="h-5 w-5 text-copper" />
        <h2 className="text-lg font-semibold">{title}</h2>
        {/* Phones swipe the row (it snaps card by card), so the arrows are desktop-only. */}
        <div className="ml-auto flex gap-1 max-md:hidden">
          <button onClick={() => scroll(-1)} className="btn-icon border border-line" aria-label="Scroll left">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button onClick={() => scroll(1)} className="btn-icon border border-line" aria-label="Scroll right">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div ref={ref} className="scrollbar-none flex gap-5 overflow-x-auto pb-2 max-md:-mx-4 max-md:snap-x max-md:snap-mandatory max-md:scroll-px-4 max-md:gap-3 max-md:px-4">
        {streams.map((s) => (
          <StreamCard key={s.id} s={s} coin={byMint.get(s.mint)} trader={traders.find((t) => t.handle === s.handle)} />
        ))}
      </div>
    </section>
  );
}

/** The spotlight below md: the stream with only its live badges on the picture, then who's streaming, the coin and one Trade button under it. */
function MobileSpotlight({ s, coin, trader }: { s: Stream; coin: Coin; trader?: Trader }) {
  const now = useNow();
  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-line-accent/70 bg-surface shadow-lift">
      <div className="relative">
        <img src={streamArt(s.id)} alt="" className="aspect-video w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-canvas/60 via-transparent to-canvas/30" />
        <div className="absolute left-3 top-3 flex items-center gap-2">
          <LivePill />
          <span className="inline-flex items-center gap-1 rounded-md bg-canvas/80 px-2 py-0.5 text-xs font-semibold">
            <Eye className="h-3.5 w-3.5" aria-hidden /> {s.viewers.toLocaleString("en-US")} watching
          </span>
        </div>
        <div className="absolute bottom-3 right-3 flex h-5 items-end gap-[3px]" aria-hidden>
          {[0.5, 0.9, 0.6, 1, 0.7, 0.4, 0.8].map((h, i) => (
            <span key={i} className="w-[3px] animate-pulse rounded-full bg-gold/80" style={{ height: `${h * 100}%`, animationDelay: `${i * 120}ms` }} />
          ))}
        </div>
      </div>
      <div className="p-3.5">
        <div className="flex gap-3">
          <TraderAvatar src={trader?.avatar ?? ""} size={40} verified={trader?.verified} ring="gold" />
          <div className="min-w-0">
            <div className="line-clamp-2 text-[16px] font-semibold leading-[22px]">{s.title}</div>
            <div className="mt-0.5 truncate text-[12.5px] text-muted">
              @{s.handle} · live for {age(now - s.startedAt)}
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-line-soft bg-canvas-2 px-3 py-2">
          <img src={coin.image} alt="" className="h-8 w-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold">{coin.name}</div>
            <div className="num truncate text-xs text-muted">
              ${coin.ticker} · {usdCompact(coin.mcapUsd)} MC
            </div>
          </div>
          <ChangePill value={coin.change24h} size="xs" />
        </div>
        <Link to={`/coin/${coin.mint}`} className="btn-gold mt-3 h-12 w-full text-[15px]">
          Trade ${coin.ticker} <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

/** Real streams when Cloudflare Stream is configured (VITE_CHAT_URL + VITE_STREAM_HOST); the demo page otherwise. */
export function Live() {
  const live = useLiveStreams();
  return live.configured ? <StreamLivePage live={live} /> : <DemoLive />;
}

function DemoLive() {
  const { streams, byMint, traders } = useMarket();
  const now = useNow();
  const isMobile = useIsMobile();
  const live = streams.filter((s) => s.kind === "live");
  const hero = [...live].sort((a, b) => b.viewers - a.viewers)[0];
  const heroCoin = hero ? byMint.get(hero.mint) : undefined;
  const heroTrader = hero ? traders.find((t) => t.handle === hero.handle) : undefined;
  const byMcap = [...live].sort((a, b) => (byMint.get(b.mint)?.mcapUsd ?? 0) - (byMint.get(a.mint)?.mcapUsd ?? 0));
  const clips = streams.filter((s) => s.kind === "clip").sort((a, b) => b.viewers - a.viewers);

  return (
    <div className="px-8 py-6 max-md:px-4 max-md:py-4">
      <div className="flex items-center gap-3 max-md:flex-wrap max-md:gap-y-0.5">
        <h1 className="text-[28px] font-semibold tracking-tight max-md:text-[24px]">Live</h1>
        <span className="inline-flex items-center gap-1.5 text-sm text-muted">
          <Radio className="h-4 w-4 text-ember" /> {live.length} streams · {compact(live.reduce((n, s) => n + s.viewers, 0))} watching
        </span>
      </div>

      {hero && heroCoin && (
        <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2.2fr)_minmax(320px,1fr)] max-md:mt-0 max-md:gap-3">
          {isMobile ? (
            <MobileSpotlight s={hero} coin={heroCoin} trader={heroTrader} />
          ) : (
            <div className="relative overflow-hidden rounded-2xl border border-line-accent/70 shadow-lift">
              <img src={streamArt(hero.id)} alt="" className="aspect-video w-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-canvas via-canvas/10 to-canvas/30" />
              <div className="absolute left-4 top-4 flex items-center gap-2">
                <LivePill />
                <span className="inline-flex items-center gap-1 rounded-md bg-canvas/80 px-2 py-0.5 text-xs font-semibold">
                  <Eye className="h-3.5 w-3.5" /> {hero.viewers.toLocaleString("en-US")} watching
                </span>
              </div>
              <Link to={`/coin/${heroCoin.mint}`} className="absolute right-4 top-4 inline-flex items-center gap-2 rounded-full border border-line-accent bg-canvas/85 py-1 pl-1 pr-3 backdrop-blur hover:border-gold">
                <img src={heroCoin.image} alt="" className="h-7 w-7 rounded-full" />
                <span className="text-[13px] font-bold">${heroCoin.ticker}</span>
                <span className="num text-[13px]">{usdCompact(heroCoin.mcapUsd)}</span>
                <ChangePill value={heroCoin.change24h} size="xs" />
              </Link>
              <div className="absolute bottom-4 right-4 flex h-6 items-end gap-[3px]" aria-hidden>
                {[0.5, 0.9, 0.6, 1, 0.7, 0.4, 0.8].map((h, i) => (
                  <span key={i} className="w-[3px] animate-pulse rounded-full bg-gold/80" style={{ height: `${h * 100}%`, animationDelay: `${i * 120}ms` }} />
                ))}
              </div>
              <div className="absolute inset-x-5 bottom-5 flex items-end gap-3 pr-24">
                <TraderAvatar src={heroTrader?.avatar ?? ""} size={46} verified={heroTrader?.verified} ring="gold" />
                <div className="min-w-0">
                  <div className="truncate text-xl font-semibold">{hero.title}</div>
                  <div className="text-[13px] text-muted">
                    @{hero.handle} · live for {age(now - hero.startedAt)} · {heroCoin.name}
                  </div>
                </div>
                <Link to={`/coin/${heroCoin.mint}`} className="btn-gold ml-auto h-10 shrink-0 px-4">
                  Trade ${heroCoin.ticker} <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          )}
          {/* The spotlight coin's real chat room, a fixed-height panel that scrolls inside. Beside the stream (xl) it
              fills the row the video sets: absolutely placed, so 200 messages can't make the row taller. */}
          <div className="relative h-[420px] max-md:h-[360px] xl:h-auto">
            <CoinChat mint={heroCoin.mint} className="panel h-full xl:absolute xl:inset-0" />
          </div>
        </div>
      )}

      <Row title="Most viewers" icon={Users} streams={[...live].sort((a, b) => b.viewers - a.viewers)} />
      <Row title="Highest market cap" icon={Radio} streams={byMcap} />
      <Row title="Trending clips" icon={Film} streams={clips} />
    </div>
  );
}

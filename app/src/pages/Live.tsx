import { ArrowRight, ChevronLeft, ChevronRight, Eye, Film, MessageSquare, Radio, Users } from "lucide-react";
import { useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { ChangePill } from "../components/ui/primitives";
import { TraderAvatar } from "../components/ui/visuals";
import { useNow } from "../hooks/useNow";
import { streamArt } from "../lib/art";
import { age, compact, usdCompact } from "../lib/format";
import { Rng } from "../lib/rng";
import type { Coin, Stream, Trader } from "../lib/types";
import { HANDLES } from "../mock/catalog";
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
    <Link to={coin ? `/coin/${coin.mint}` : "/live"} className="group w-[300px] shrink-0">
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
    <section className="mt-10">
      <div className="mb-4 flex items-center gap-2">
        <Icon className="h-5 w-5 text-copper" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="ml-auto flex gap-1">
          <button onClick={() => scroll(-1)} className="btn-icon border border-line" aria-label="Scroll left">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button onClick={() => scroll(1)} className="btn-icon border border-line" aria-label="Scroll right">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div ref={ref} className="scrollbar-none flex gap-5 overflow-x-auto pb-2">
        {streams.map((s) => (
          <StreamCard key={s.id} s={s} coin={byMint.get(s.mint)} trader={traders.find((t) => t.handle === s.handle)} />
        ))}
      </div>
    </section>
  );
}

const CHAT = ["just aped 1 SOL", "curve almost done", "this dev actually ships", "LFG", "who's holding through raydium?", "tweet lock is a nice touch", "buying every dip", "the bull is charging", "chart looks healthy", "gm from the trading pit"];

export function Live() {
  const { streams, byMint, traders } = useMarket();
  const now = useNow();
  const live = streams.filter((s) => s.kind === "live");
  const hero = [...live].sort((a, b) => b.viewers - a.viewers)[0];
  const heroCoin = hero ? byMint.get(hero.mint) : undefined;
  const heroTrader = hero ? traders.find((t) => t.handle === hero.handle) : undefined;
  const chat = useMemo(() => {
    const rng = new Rng("chat");
    return Array.from({ length: 14 }, (_, i) => ({ id: i, handle: HANDLES[rng.int(0, HANDLES.length - 1)][0], text: rng.pick(CHAT) }));
  }, []);
  const byMcap = [...live].sort((a, b) => (byMint.get(b.mint)?.mcapUsd ?? 0) - (byMint.get(a.mint)?.mcapUsd ?? 0));
  const clips = streams.filter((s) => s.kind === "clip").sort((a, b) => b.viewers - a.viewers);

  return (
    <div className="px-8 py-6">
      <div className="flex items-center gap-3">
        <h1 className="text-[28px] font-semibold tracking-tight">Live</h1>
        <span className="inline-flex items-center gap-1.5 text-sm text-muted">
          <Radio className="h-4 w-4 text-ember" /> {live.length} streams · {compact(live.reduce((n, s) => n + s.viewers, 0))} watching
        </span>
      </div>

      {hero && heroCoin && (
        <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2.2fr)_minmax(320px,1fr)]">
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
          <div className="panel flex min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-[13.5px] font-semibold">
              <MessageSquare className="h-4 w-4 text-copper" /> Live chat
              <span className="ml-auto text-xs font-normal text-muted">{compact(hero.viewers)} in chat</span>
            </div>
            <ul className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3 text-[13px]">
              {chat.map((m) => (
                <li key={m.id}>
                  <span className="font-semibold text-copper">@{m.handle}</span> <span className="text-cream/90">{m.text}</span>
                </li>
              ))}
            </ul>
            <div className="border-t border-line p-3">
              <input disabled className="input h-10 cursor-not-allowed text-sm" placeholder="Connect your wallet to chat" />
            </div>
          </div>
        </div>
      )}

      <Row title="Most viewers" icon={Users} streams={[...live].sort((a, b) => b.viewers - a.viewers)} />
      <Row title="Highest market cap" icon={Radio} streams={byMcap} />
      <Row title="Trending clips" icon={Film} streams={clips} />
    </div>
  );
}

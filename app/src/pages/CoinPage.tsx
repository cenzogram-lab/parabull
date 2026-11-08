import { Check, Copy, ExternalLink, Globe, Lock, Send, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { XLogo } from "../components/brand/Wordmark";
import { CoinChat } from "../components/coin/CoinChat";
import { GoLiveButton } from "../components/live/GoLive";
import { CoinLivePanel } from "../components/live/LiveViews";
import { useLiveStreams } from "../hooks/useLiveStreams";
import { XAutomationButton } from "../components/coin/XAutomationModal";
import { CoinCallouts, EscrowGauge, HoldersTable, MigrationGauge, TradesTable } from "../components/coin/CoinWidgets";
import { PriceChart } from "../components/coin/PriceChart";
import { TradePanel, TradeStats } from "../components/coin/TradePanel";
import { MobileTradeTerminal } from "../components/mobile/MobileTradeTerminal";
import { ChangePill, cx, StageBadge, UnderlineTabs } from "../components/ui/primitives";
import { CoinAvatar } from "../components/ui/visuals";
import { explorer } from "../config";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useNow } from "../hooks/useNow";
import { age, compact, countdown, shortAddr, usdCompact } from "../lib/format";
import { dexScreenerUrl, raydiumSwapUrl } from "../lib/links";
import type { Coin } from "../lib/types";
import { progressOf } from "../mock/coins";
import { useApp } from "../state/AppState";
import { useCoinView, useMarket, type CoinState } from "../state/Market";
import { safeLink } from "../lib/launchRules";

function CopyPill({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(value).catch(() => undefined);
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-canvas-2 px-2.5 font-mono text-[12px] text-muted hover:border-line-accent hover:text-cream"
      aria-label="Copy contract address"
    >
      CA {shortAddr(value, 5)}
      {done ? <Check className="h-3.5 w-3.5 text-gold" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function LockTimers({ coin }: { coin: Coin }) {
  const now = useNow();
  const locks = [
    ["Ticker", coin.locks.ticker],
    ["Name", coin.locks.name],
    ["Tweet", coin.locks.tweet],
  ] as const;
  const active = locks.filter(([, t]) => t && t > now);
  if (!active.length) return <span className="text-xs text-muted">Registry locks expired: the ticker and name can be reused.</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {active.map(([k, t]) => (
        <span key={k} className="inline-flex items-center gap-1.5 rounded-lg border border-rosebronze/30 bg-rosebronze/10 px-2 py-1 text-[11.5px] font-semibold text-rosebronze" title={`${k} locked on-chain until ${new Date(t!).toLocaleString()}`}>
          <Lock className="h-3 w-3" />
          {k === "Tweet" ? "Verified tweet" : `${k} lock`}
          <span className="num font-mono text-cream">{countdown(t! - now)}</span>
        </span>
      ))}
    </div>
  );
}

/** Why a coin page has no coin to show yet. */
const NO_COIN: Record<Exclude<CoinState, "ready">, { title: string; body: string }> = {
  loading: { title: "Loading coin…", body: "Reading this coin from the chain." },
  missing: { title: "Coin not found", body: "No coin on Parabull has this address." },
  error: { title: "Couldn't load this coin", body: "The market indexer didn't answer. Try again in a moment." },
  unconfigured: { title: "Market data isn't set up", body: "This build has no indexer (VITE_INDEXER_URL), so it can't show on-chain coins." },
};

export function CoinPage() {
  const { mint = "" } = useParams();
  const { solUsd } = useMarket();
  // Chain mode: a coin that isn't on the board yet (created seconds ago, or past the list) is fetched on its own.
  const { coin, state } = useCoinView(mint);
  const live = useLiveStreams();
  const { markViewed, watchlist, toggleWatch } = useApp();
  const now = useNow();
  const isMobile = useIsMobile();
  const [tab, setTab] = useState<"Holders" | "Trades" | "Callouts" | "Chat">("Trades");
  useEffect(() => {
    if (coin) markViewed(coin.mint);
  }, [coin?.mint]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!coin) {
    const msg = NO_COIN[state === "ready" ? "loading" : state];
    return (
      <div className="flex flex-col items-center gap-4 px-4 py-16 text-center" role={state === "loading" ? "status" : undefined}>
        <h1 className="text-lg font-semibold">{msg.title}</h1>
        <p className="text-[13.5px] text-muted">{msg.body}</p>
        {state !== "loading" && (
          <Link to="/explore" className="btn-gold h-11 px-5">
            Explore coins
          </Link>
        )}
      </div>
    );
  }

  // Keyed by coin, so another coin starts on a fresh terminal (tab, expanded lists, chart).
  if (isMobile) return <MobileTradeTerminal key={coin.mint} coin={coin} />;

  const watched = watchlist.has(coin.mint);
  return (
    <div className="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,7fr)_minmax(340px,3fr)]">
      <div className="min-w-0 space-y-4">
        <div className="panel p-4">
          <div className="flex flex-wrap items-start gap-4">
            <CoinAvatar src={coin.image} alt={coin.name} size={64} progress={progressOf(coin)} graduated={coin.migrated} rounded="2xl" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[22px] font-semibold leading-7">{coin.name}</h1>
                <span className="text-[15px] font-semibold text-muted">${coin.ticker}</span>
                <StageBadge stage={coin.stage} />
                <span className="text-xs text-muted">
                  {age(now - coin.createdAt)} ago by <span className="text-cream">@{coin.creatorHandle}</span>
                </span>
              </div>
              <p className="mt-1 max-w-3xl text-[13px] text-muted">{coin.description}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <CopyPill value={coin.mint} />
                <a href={explorer("token", coin.mint)} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1 rounded-full border border-line px-2.5 text-[12px] text-muted hover:text-cream">
                  Solscan <ExternalLink className="h-3 w-3" />
                </a>
                {/* After graduation the coin trades on its Raydium CPMM pool; DexScreener charts it. */}
                {coin.migrated && (
                  <>
                    <a href={raydiumSwapUrl(coin.mint)} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1 rounded-full border border-gold/40 px-2.5 text-[12px] font-semibold text-gold hover:border-gold/70">
                      Raydium <ExternalLink className="h-3 w-3" />
                    </a>
                    <a href={dexScreenerUrl(coin.mint)} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1 rounded-full border border-line px-2.5 text-[12px] text-muted hover:text-cream">
                      DexScreener <ExternalLink className="h-3 w-3" />
                    </a>
                  </>
                )}
                {safeLink(coin.socials.x) && (
                  <a href={safeLink(coin.socials.x)} target="_blank" rel="noreferrer" className="btn-icon h-7 w-7 rounded-full border border-line" aria-label="X">
                    <XLogo className="h-3.5 w-3.5" />
                  </a>
                )}
                {safeLink(coin.socials.website) && (
                  <a href={safeLink(coin.socials.website)} target="_blank" rel="noreferrer" className="btn-icon h-7 w-7 rounded-full border border-line" aria-label="Website">
                    <Globe className="h-3.5 w-3.5" />
                  </a>
                )}
                {safeLink(coin.socials.telegram) && (
                  <a href={safeLink(coin.socials.telegram)} target="_blank" rel="noreferrer" className="btn-icon h-7 w-7 rounded-full border border-line" aria-label="Telegram">
                    <Send className="h-3.5 w-3.5" />
                  </a>
                )}
                <span className={cx("inline-flex h-7 items-center rounded-full border px-2.5 text-[12px] font-semibold", coin.devPct === 0 ? "border-gold/40 text-gold" : coin.devPct > 4 ? "border-ember/40 text-ember" : "border-line text-cream")}>
                  Dev holds {coin.devPct.toFixed(1)}%
                </span>
              </div>
            </div>
            {/* The creator's X automation sits before Watch; for everyone else this renders nothing, so the header is unchanged. */}
            <div className="flex shrink-0 items-center gap-2">
              <GoLiveButton coin={coin} variant="desktop" />
              <XAutomationButton coin={coin} variant="desktop" />
              <button onClick={() => toggleWatch(coin.mint)} className={cx("btn-ghost h-9 px-3", watched && "border-gold/50 text-gold")} aria-pressed={watched}>
                <Star className={cx("h-4 w-4", watched && "fill-gold")} /> {watched ? "Watching" : "Watch"}
              </button>
            </div>
          </div>
          <div className="mt-3 border-t border-line-soft pt-3">
            <LockTimers coin={coin} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-4">
          {[
            ["Market cap", usdCompact(coin.mcapUsd), `${compact(coin.mcapUsd / solUsd)} SOL`, <ChangePill key="c" value={coin.change24h} size="xs" />],
            ["24h volume", usdCompact(coin.vol24hUsd), `${(coin.buys24h + coin.sells24h).toLocaleString("en-US")} trades`, null],
            ["Holders", coin.holders.toLocaleString("en-US"), `${coin.traders24h.toLocaleString("en-US")} traders today`, null],
            ["All-time high", usdCompact(coin.athUsd), `${((coin.mcapUsd / coin.athUsd) * 100).toFixed(0)}% of ATH`, null],
          ].map(([k, v, sub, extra]) => (
            <div key={k as string} className="bg-surface px-4 py-3">
              <div className="text-xs text-muted">{k}</div>
              <div className="mt-0.5 flex items-center gap-2">
                <span className="text-[20px] font-semibold">{v}</span>
                {extra}
              </div>
              <div className="num text-[11.5px] text-muted">{sub}</div>
            </div>
          ))}
        </div>

        {/* While the coin's creator is streaming (Cloudflare Stream), the stream sits above the chart. */}
        <CoinLivePanel live={live} mint={coin.mint} />

        <PriceChart coin={coin} />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <MigrationGauge coin={coin} />
          <EscrowGauge coin={coin} />
        </div>

        <div className="panel">
          <div className="px-4 pt-3">
            <UnderlineTabs options={["Trades", "Holders", "Callouts", "Chat"] as const} value={tab} onChange={setTab} />
          </div>
          {/* The chat scrolls its own message list, with the composer pinned under it. */}
          {tab === "Chat" ? (
            <CoinChat mint={coin.mint} className="h-[520px] border-t border-line" />
          ) : (
            <div className="max-h-[520px] overflow-y-auto">{tab === "Holders" ? <HoldersTable coin={coin} /> : tab === "Trades" ? <TradesTable coin={coin} /> : <CoinCallouts coin={coin} />}</div>
          )}
        </div>
      </div>

      <aside className="space-y-4 xl:sticky xl:top-[112px] xl:self-start">
        <TradePanel coin={coin} />
        <TradeStats coin={coin} />
      </aside>
    </div>
  );
}

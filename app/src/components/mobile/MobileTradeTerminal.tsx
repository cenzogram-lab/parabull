/**
 * Mobile coin terminal (/coin/:mint below md): a compact header with the
 * contract, links and launch locks, the four metrics as a 2x2 grid, the
 * chart, the curve and listing gauges, 24h stats, then Trades / Holders /
 * Callouts, and the Buy / Sell bar that opens the trade sheet.
 */
import { Check, CircleAlert, Copy, ExternalLink, Globe, Lock, Send, Star } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { explorer } from "../../config";
import { useNow } from "../../hooks/useNow";
import { age, compact, countdown, shortAddr, usdCompact } from "../../lib/format";
import { dexScreenerUrl, raydiumSwapUrl } from "../../lib/links";
import type { Coin } from "../../lib/types";
import { progressOf } from "../../mock/coins";
import { useApp } from "../../state/AppState";
import { useMarket } from "../../state/Market";
import { XLogo } from "../brand/Wordmark";
import { CoinChat } from "../coin/CoinChat";
import { CoinCallouts, EscrowGauge, MigrationGauge } from "../coin/CoinWidgets";
import { PriceChart } from "../coin/PriceChart";
import { TradeStats } from "../coin/TradePanel";
import { ChangePill, cx, StageBadge } from "../ui/primitives";
import { CoinAvatar } from "../ui/visuals";
import { MobileTabs } from "./MobileUi";
import { MobileTradeBar } from "./MobileTradeBar";
import { HolderList, TradeFeed } from "./MobileTradeLists";
import { XAutomationButton } from "../coin/XAutomationModal";
import { safeLink } from "../../lib/launchRules";
import { useLiveStreams } from "../../hooks/useLiveStreams";
import { CoinLivePanel } from "../live/LiveViews";

type Tab = "Trades" | "Holders" | "Callouts" | "Chat";
const TABS = ["Trades", "Holders", "Callouts", "Chat"] as const;
/** The mobile header's height: where the sticky tab row pins. */
const HEADER_PX = 56;

/** Two lines of description; a longer one becomes a button that expands it. */
function Blurb({ text }: { text: string }) {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    const check = () => setLong(open || el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, open, text]);
  if (!text.trim()) return null;
  const body = (
    <span ref={setEl} className={cx("block", !open && "line-clamp-2")}>
      {text}
    </span>
  );
  if (!long) return <p className="mt-2.5 text-[13px] leading-5 text-muted">{body}</p>;
  return (
    <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-2 block min-h-11 w-full py-0.5 text-left text-[13px] leading-5 text-muted">
      {body}
      <span className="mt-0.5 block text-xs font-semibold text-gold">{open ? "Show less" : "Show more"}</span>
    </button>
  );
}

/**
 * Contract address pill: tap to copy; it confirms in place for a moment, and only once the clipboard took it. If it
 * didn't (blocked, or no clipboard on a plain-http origin), it says so and a toast shows the full address instead.
 */
function CaPill({ mint }: { mint: string }) {
  const { toast } = useApp();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    let ok = false;
    try {
      // Throws too when navigator.clipboard is missing.
      await navigator.clipboard.writeText(mint);
      ok = true;
    } catch {
      toast({ tone: "info", title: "Couldn't copy the contract address", body: mint });
    }
    setState(ok ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), ok ? 1400 : 2400);
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={state === "copied" ? "Contract address copied" : state === "failed" ? "Couldn't copy the contract address" : `Copy contract address ${mint}`}
      className="flex h-11 min-w-0 flex-1 items-center justify-between gap-2 rounded-full border border-line bg-canvas-2 pl-4 pr-3.5 font-mono text-[12.5px] transition-colors duration-100 ease-out active:border-line-accent"
    >
      {state === "copied" ? (
        <span className="font-sans text-[13px] font-semibold text-gold">Copied</span>
      ) : state === "failed" ? (
        <span className="truncate font-sans text-[13px] font-semibold text-ember">Couldn't copy</span>
      ) : (
        <span className="min-w-0 truncate">
          <span className="text-muted">CA</span> <span className="text-cream">{shortAddr(mint, 5)}</span>
        </span>
      )}
      {state === "copied" ? <Check className="h-4 w-4 shrink-0 text-gold" aria-hidden /> : state === "failed" ? <CircleAlert className="h-4 w-4 shrink-0 text-ember" aria-hidden /> : <Copy className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
    </button>
  );
}

const roundLink = "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-muted transition-colors duration-100 ease-out active:border-line-accent active:text-cream";

/** The 3-day launch locks still running, one tile each: three across from 360px, wrapping below that so no countdown clips. */
function LockTiles({ coin }: { coin: Coin }) {
  const now = useNow();
  const locks: [string, number][] = [];
  if (coin.locks.ticker > now) locks.push(["Ticker lock", coin.locks.ticker]);
  if (coin.locks.name > now) locks.push(["Name lock", coin.locks.name]);
  if (coin.locks.tweet !== null && coin.locks.tweet > now) locks.push(["Tweet lock", coin.locks.tweet]);
  if (!locks.length) return <p className="text-xs leading-5 text-muted">Registry locks expired: the ticker and name can be reused.</p>;
  return (
    <ul aria-label="Launch locks, held on-chain for 3 days" className="grid grid-cols-[repeat(auto-fit,minmax(5.75rem,1fr))] gap-2">
      {locks.map(([label, until]) => (
        <li key={label} title={`${label}: held on-chain until ${new Date(until).toLocaleString()}`} className="min-w-0 rounded-lg border border-rosebronze/30 bg-rosebronze/10 px-1.5 py-1.5">
          <span className="flex items-center gap-1 truncate text-[11px] font-semibold leading-4 text-rosebronze">
            <Lock className="h-3 w-3 shrink-0" strokeWidth={2.5} aria-hidden />
            {label}
          </span>
          <span className="num mt-0.5 block truncate font-mono text-[11.5px] leading-4 text-cream">{countdown(until - now)}</span>
        </li>
      ))}
    </ul>
  );
}

/** One cell of the 2x2 metrics; `change` (the 24h pill) follows the sub line and wraps under it on the narrowest phones. */
function Metric({ label, value, sub, change }: { label: string; value: string; sub: string; change?: ReactNode }) {
  return (
    <div className="min-w-0 bg-surface px-3 py-2.5">
      <div className="truncate text-xs text-muted">{label}</div>
      <div className="num mt-0.5 truncate text-[18px] font-semibold leading-6 text-cream">{value}</div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="num min-w-0 truncate text-[11.5px] leading-5 text-muted">{sub}</span>
        {change}
      </div>
    </div>
  );
}

export function MobileTradeTerminal({ coin }: { coin: Coin }) {
  const { solUsd } = useMarket();
  const live = useLiveStreams();
  const { watchlist, toggleWatch } = useApp();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("Trades");
  const tabsAnchor = useRef<HTMLDivElement>(null);
  const watched = watchlist.has(coin.mint);
  const socials = [
    { href: safeLink(coin.socials.x), label: "X", icon: <XLogo className="h-4 w-4" /> },
    { href: safeLink(coin.socials.website), label: "Website", icon: <Globe className="h-[18px] w-[18px]" aria-hidden /> },
    { href: safeLink(coin.socials.telegram), label: "Telegram", icon: <Send className="h-[18px] w-[18px]" aria-hidden /> },
  ].filter((s) => !!s.href);

  // Once the tab row is pinned, a new tab starts at its top rather than wherever the old one was scrolled to.
  const pick = (t: Tab) => {
    setTab(t);
    const anchor = tabsAnchor.current;
    if (!anchor) return;
    const top = anchor.getBoundingClientRect().top;
    if (top < HEADER_PX) window.scrollTo({ top: window.scrollY + top - HEADER_PX });
  };

  return (
    <div className="pt-3">
      <div className="space-y-3 px-4">
        <section aria-label={`${coin.name} overview`} className="panel p-3.5">
          <div className="flex items-start gap-3">
            <div className="p-[5px]">
              <CoinAvatar src={coin.image} alt={coin.name} size={52} progress={progressOf(coin)} graduated={coin.migrated} rounded="2xl" />
            </div>
            <div className="min-w-0 flex-1 pt-1">
              <h1 className="truncate text-[19px] font-semibold leading-6 text-cream">{coin.name}</h1>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[13.5px] font-semibold text-muted">${coin.ticker}</span>
                <StageBadge stage={coin.stage} />
              </div>
              <div className="mt-0.5 truncate text-xs text-muted">
                {age(now - coin.createdAt)} ago by <span className="text-cream">@{coin.creatorHandle}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => toggleWatch(coin.mint)}
              aria-pressed={watched}
              aria-label="Watch"
              className={cx(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors duration-100 ease-out active:scale-95",
                watched ? "border-gold/50 bg-gold/10 text-gold" : "border-line text-muted active:text-cream",
              )}
            >
              <Star className={cx("h-5 w-5", watched && "fill-gold")} aria-hidden />
            </button>
          </div>

          <Blurb text={coin.description} />

          <div className="mt-3 flex gap-2">
            <CaPill mint={coin.mint} />
            <XAutomationButton coin={coin} variant="phone" />
            <a href={explorer("token", coin.mint)} target="_blank" rel="noreferrer" className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-line px-4 text-[13px] font-medium text-muted transition-colors duration-100 ease-out active:border-line-accent active:text-cream">
              Solscan <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          </div>
          {/* After graduation the coin trades on its Raydium CPMM pool; DexScreener charts it. */}
          {coin.migrated && (
            <div className="mt-2 flex gap-2">
              <a href={raydiumSwapUrl(coin.mint)} target="_blank" rel="noreferrer" className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full border border-gold/40 text-[13px] font-semibold text-gold active:border-gold/70">
                Trade on Raydium <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
              <a href={dexScreenerUrl(coin.mint)} target="_blank" rel="noreferrer" className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full border border-line text-[13px] font-medium text-muted active:border-line-accent active:text-cream">
                DexScreener <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {socials.map((s) => (
              <a key={s.label} href={s.href} target="_blank" rel="noreferrer" aria-label={`${coin.name} on ${s.label}`} className={roundLink}>
                {s.icon}
              </a>
            ))}
            <span className={cx("ml-auto inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-[12px] font-semibold", coin.devPct === 0 ? "border-gold/40 text-gold" : coin.devPct > 4 ? "border-ember/40 text-ember" : "border-line text-cream")}>
              Dev holds {coin.devPct.toFixed(1)}%
            </span>
          </div>

          <div className="mt-3 border-t border-line-soft pt-3">
            <LockTiles coin={coin} />
          </div>
        </section>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
          <Metric label="Market cap" value={usdCompact(coin.mcapUsd)} sub={`${compact(coin.mcapUsd / solUsd)} SOL`} change={<ChangePill value={coin.change24h} size="xs" soft />} />
          <Metric label="24h volume" value={usdCompact(coin.vol24hUsd)} sub={`${(coin.buys24h + coin.sells24h).toLocaleString("en-US")} trades`} />
          <Metric label="Holders" value={coin.holders.toLocaleString("en-US")} sub={`${coin.traders24h.toLocaleString("en-US")} traders today`} />
          <Metric label="All-time high" value={usdCompact(coin.athUsd)} sub={`${((coin.mcapUsd / coin.athUsd) * 100).toFixed(0)}% of ATH`} />
        </div>

        <CoinLivePanel live={live} mint={coin.mint} />
        <PriceChart coin={coin} />
        <MigrationGauge coin={coin} />
        <EscrowGauge coin={coin} />
        <TradeStats coin={coin} />
      </div>

      {/* Marks where the tab row sits when it isn't pinned. */}
      <div ref={tabsAnchor} className="mt-4" />
      <MobileTabs sticky options={TABS} value={tab} onChange={pick} label={`$${coin.ticker} activity`} />
      <div role="tabpanel" aria-label={tab}>
        {tab === "Trades" && <TradeFeed coin={coin} />}
        {tab === "Holders" && <HolderList coin={coin} />}
        {tab === "Callouts" && <CoinCallouts coin={coin} />}
        {/* A fixed-height panel that scrolls inside, so the composer stays above the Buy / Sell bar. */}
        {tab === "Chat" && <CoinChat mint={coin.mint} className="mx-4 mt-3 h-[60vh] min-h-[320px] rounded-2xl border border-line bg-surface" />}
      </div>

      <MobileTradeBar coin={coin} />
    </div>
  );
}

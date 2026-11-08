import { ArrowUpRight, Check, Copy, Eye, Heart, Link2, MessageCircle, MoreHorizontal, Share2, UserPlus } from "lucide-react";
import { Link } from "react-router-dom";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useNow } from "../../hooks/useNow";
import { age, pct, shortAddr, usd, usdCompact, usdSigned } from "../../lib/format";
import type { Callout, Coin, Trader } from "../../lib/types";
import { progressOf } from "../../mock/coins";
import { useApp } from "../../state/AppState";
import { useMarket } from "../../state/Market";
import { calloutMove } from "../../lib/calloutsClient";
import { XLogo } from "../brand/Wordmark";
import { FollowButton } from "../mobile/MobileUi";
import { AgeTag, ChangePill, cx, HotBadge, LockBadge, Popover, StageBadge } from "../ui/primitives";
import { CoinAvatar, Meter, TraderAvatar } from "../ui/visuals";

export function ActiveLocks({ coin, compact = true }: { coin: Coin; compact?: boolean }) {
  const now = useNow();
  const locks: ("Ticker" | "Name" | "Tweet")[] = [];
  if (coin.locks.ticker > now) locks.push("Ticker");
  if (coin.locks.name > now) locks.push("Name");
  if (coin.locks.tweet && coin.locks.tweet > now) locks.push("Tweet");
  if (!locks.length) return null;
  return (
    <span className="flex flex-nowrap gap-1 max-md:flex-wrap">
      {locks.map((k) => (
        <LockBadge key={k} kind={k} compact={compact && k !== "Tweet"} />
      ))}
    </span>
  );
}

/** Pro Screener row card. */
export function CoinRow({ coin, preview = false }: { coin: Coin; preview?: boolean }) {
  const now = useNow();
  const body = (
    <div className={cx("px-3 py-2.5", !preview && "hover-lift border border-transparent border-b-line-soft")}>
      <div className="flex items-start gap-3">
        <div className="pl-1 pt-1">
          <CoinAvatar src={coin.image} alt={coin.name} size={42} progress={progressOf(coin)} graduated={coin.migrated} />
        </div>
        <div className="min-w-0 flex-1 pl-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold">{coin.name}</span>
            {coin.hot && !coin.migrated && <HotBadge />}
            <StageBadge stage={coin.stage} />
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[12.5px] text-muted">
            <span className="font-medium">${coin.ticker}</span>
            <AgeTag ms={age(now - coin.createdAt)} />
            <span className="truncate">by @{coin.creatorHandle}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <span className="num text-[14px] font-semibold">
            {usdCompact(coin.mcapUsd)} <span className="text-[11px] font-medium text-muted">MC</span>
          </span>
          <ChangePill value={coin.change24h} size="xs" />
          {!coin.migrated && <span className="num text-[11px] text-muted">{Math.round(progressOf(coin) * 100)}% bonded</span>}
        </div>
      </div>
      <div className="mt-1.5 pl-[60px]">
        <ActiveLocks coin={coin} compact={false} />
      </div>
    </div>
  );
  return preview ? body : <Link to={`/coin/${coin.mint}`}>{body}</Link>;
}

/** Classic big-image card (Movers column, explore grid). */
export function CoinCard({ coin }: { coin: Coin }) {
  const now = useNow();
  return (
    <Link to={`/coin/${coin.mint}`} className="hover-lift group flex gap-4 rounded-2xl border border-transparent p-2">
      <CoinAvatar src={coin.image} alt={coin.name} size={112} rounded="2xl" />
      <div className="min-w-0 flex-1 py-1">
        <div className="truncate text-[17px] font-semibold leading-6 group-hover:text-gold">{coin.name}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[14px] text-muted">
          <span className="font-medium">{coin.ticker}</span>
          <AgeTag ms={age(now - coin.createdAt)} />
        </div>
        <div className="mt-0.5 flex items-center gap-1 font-mono text-[12.5px] text-muted">
          {shortAddr(coin.mint, 4)}
          <Copy className="h-3 w-3" aria-hidden />
        </div>
        <div className="mt-1 text-[19px] font-semibold">
          {usdCompact(coin.mcapUsd)} <span className="text-sm font-medium text-muted">MC</span>
        </div>
        {!coin.migrated && (
          <div className="mt-1.5 max-w-[180px]">
            <Meter value={progressOf(coin)} height={5} label={`${coin.ticker} bonding curve progress`} />
          </div>
        )}
      </div>
    </Link>
  );
}

/**
 * The callout's "More" menu: open the coin, copy the callout's link, or share it. The link is /c/<id>: opening it
 * credits the caller with the buys it brings in (src/lib/referral.ts).
 */
function CalloutMenu({ callout, coin }: { callout: Callout; coin: Coin }) {
  const { toast } = useApp();
  const url = `${window.location.origin}/c/${encodeURIComponent(callout.id)}`;
  const copy = async (text: string, title: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: "good", title, body: text.length > 80 ? `${text.slice(0, 80)}…` : text });
    } catch {
      toast({ tone: "info", title: "Copy this link", body: text });
    }
  };
  const share = async () => {
    const text = `@${callout.handle} on $${coin.ticker}: ${callout.text}`;
    try {
      if (navigator.share) return await navigator.share({ title: `$${coin.ticker} on Parabull`, text, url });
      await copy(`${text} ${url}`, "Callout copied");
    } catch (e) {
      // Closing the share sheet rejects with AbortError: nothing to report.
      if ((e as Error).name !== "AbortError") toast({ tone: "info", title: "Share this link", body: url });
    }
  };
  const item = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-surface-2";
  return (
    <Popover
      className="w-52 p-1.5"
      trigger={(open) => (
        <button type="button" className="btn-icon h-7 w-7" aria-label="More" aria-haspopup="menu" aria-expanded={open}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label={`@${callout.handle}'s callout`}>
          <Link role="menuitem" to={`/coin/${coin.mint}`} onClick={close} className={item}>
            <ArrowUpRight className="h-4 w-4 text-copper" /> View ${coin.ticker}
          </Link>
          <button role="menuitem" type="button" onClick={() => (close(), void copy(url, "Link copied"))} className={item}>
            <Link2 className="h-4 w-4 text-copper" /> Copy callout link
          </button>
          <button role="menuitem" type="button" onClick={() => (close(), void share())} className={item}>
            <Share2 className="h-4 w-4 text-copper" /> Share callout
          </button>
        </div>
      )}
    </Popover>
  );
}

/** Social callout: a public call on a coin the trader holds. */
export function CalloutCard({ callout, trader, coin, dense = false }: { callout: Callout; trader?: Trader; coin?: Coin; dense?: boolean }) {
  const now = useNow();
  const isMobile = useIsMobile();
  const { following, toggleFollow } = useMarket();
  if (!coin) return null;
  const move = calloutMove(callout, coin);
  return (
    <article className={cx("border-b border-line-soft", dense ? "px-3 py-3" : "px-1 py-5")}>
      <div className="flex gap-3">
        <TraderAvatar src={trader?.avatar ?? coin.image} size={dense ? 36 : 42} verified={trader?.verified} ring={trader?.verified ? "gold" : undefined} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
            <span className="shrink-0 font-semibold">{trader?.name ?? callout.handle}</span>
            {trader?.x && <XLogo className="h-3 w-3 shrink-0 text-muted" />}
            <span className="min-w-0 truncate text-[12.5px] text-muted">@{callout.handle}</span>
            <span className="shrink-0 text-[12.5px] text-muted">· {age(now - callout.ts)}</span>
            <div className="ml-auto flex items-center gap-1">
              {/* Below md it's the shared follow toggle (as on the leaderboard); the desktop button is unchanged. */}
              {isMobile ? (
                <FollowButton name={`@${callout.handle}`} on={following.has(callout.handle)} onToggle={() => toggleFollow(callout.handle)} />
              ) : (
                <button
                  type="button"
                  onClick={() => toggleFollow(callout.handle)}
                  aria-pressed={following.has(callout.handle)}
                  aria-label={`Follow @${callout.handle}`}
                  className={cx(
                    "touch-target inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold hover:border-line-accent",
                    following.has(callout.handle) ? "border-gold/40 text-gold" : "border-line text-cream",
                  )}
                >
                  {following.has(callout.handle) ? <Check className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
                  {following.has(callout.handle) ? "Following" : "Follow"}
                </button>
              )}
              {!dense && <CalloutMenu callout={callout} coin={coin} />}
            </div>
          </div>
          <p className={cx("mt-1.5 text-cream/95", dense ? "text-[13px] leading-5" : "text-[14.5px] leading-6")}>{callout.text}</p>
          <Link to={`/coin/${coin.mint}`} className="hover-lift mt-3 flex items-center gap-3 rounded-xl border border-line bg-canvas-2 p-3">
            <img src={coin.image} alt="" className="h-9 w-9 rounded-lg" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-semibold">{coin.ticker}</div>
              <div className="truncate text-xs text-muted">{coin.name}</div>
            </div>
            {callout.position ? (
              <>
                <div className="text-right">
                  <div className="text-[11.5px] text-muted">Position</div>
                  <div className="num text-[13px] font-semibold">{callout.position.closed ? "Closed" : usd(callout.position.usd)}</div>
                </div>
                <div className="min-w-[88px] text-right max-md:min-w-0">
                  <div className="text-[11.5px] text-muted">Net PnL</div>
                  <div className={cx("num text-[13px] font-semibold", callout.position.pnlUsd >= 0 ? "text-gold" : "text-ember")}>{usdSigned(callout.position.pnlUsd)}</div>
                </div>
              </>
            ) : (
              // A real callout records the market cap at the call, not the caller's position: show the move since.
              <div className="min-w-[88px] text-right max-md:min-w-0">
                <div className="text-[11.5px] text-muted">Since call</div>
                <div className={cx("num text-[13px] font-semibold", move >= 0 ? "text-gold" : "text-ember")}>{pct(move, 0)}</div>
              </div>
            )}
          </Link>
          <div className="mt-2.5 flex items-center gap-4 text-[12.5px] text-muted">
            {/* Demo callouts carry made-up views and reactions; real ones have none yet, so nothing is shown. */}
            {callout.engagement && (
              <>
                <span className="flex items-center gap-1">
                  <Eye className="h-3.5 w-3.5" /> {callout.engagement.views.toLocaleString("en-US")}
                </span>
                {!dense && (
                  <span className="flex items-center gap-1">
                    <MessageCircle className="h-3.5 w-3.5" /> {callout.engagement.comments}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Heart className="h-3.5 w-3.5" /> {callout.engagement.likes}
                </span>
                {!dense && (
                  <span className="flex items-center gap-1">
                    <Share2 className="h-3.5 w-3.5" /> {callout.engagement.shares}
                  </span>
                )}
              </>
            )}
            <span className="ml-auto truncate font-medium">
              {dense ? "Called" : "Called at"} {usdCompact(callout.calledAtMcap)}
              {dense ? "" : " MC"} → <span className="text-gold">{usdCompact(coin.mcapUsd)}</span>
              {!dense && <span className={move >= 0 ? "text-gold" : "text-ember"}> ({pct(move, 0)})</span>}
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}

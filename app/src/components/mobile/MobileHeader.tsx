import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ArrowDown, ArrowUp, Bell, Crown, Gift, Lock, Megaphone, Sprout, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { isDemo } from "../../config";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { age, pct, sol, usd, usdCompact, usdSigned } from "../../lib/format";
import { GRADUATION_RAISE_LAMPORTS } from "../../lib/protocol";
import { progressOf } from "../../mock/coins";
import { DEMO_WALLET, walletEpochs, type DemoEpoch } from "../../mock/protocol";
import { useApp } from "../../state/AppState";
import { kingOf, useMarket } from "../../state/Market";
import { usePortfolio } from "../../state/usePortfolio";
import { cx } from "../ui/primitives";
import { LiveChip } from "./MobileLiveStrip";
import { BottomSheet, IconButton } from "./MobileUi";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The curve's graduation raise, about 85 SOL. */
const GRADUATION_SOL = Math.round(Number(GRADUATION_RAISE_LAMPORTS) / 1e9);

/** "-$56.11 ↓ 7.8%": signed USD, then the arrow and percentage; gold for gains, ember on a bronze-red tint for losses. */
function PnlBadge({ usdChange, pctChange }: { usdChange: number; pctChange: number }) {
  const up = usdChange >= 0;
  const Arrow = up ? ArrowUp : ArrowDown;
  return (
    <span className={cx("num inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-px text-[11px] font-semibold leading-4", up ? "bg-gold/10 text-gold" : "bg-candle-down/30 text-ember")}>
      {usdSigned(usdChange)}
      <span className="inline-flex items-center">
        <Arrow className="h-3 w-3" strokeWidth={2.5} aria-hidden />
        {pct(Math.abs(pctChange), 1, false)}
      </span>
    </span>
  );
}

/** The newest holder-reward epoch the wallet can still claim (null if none). */
const claimableEpoch = (epochs: readonly DemoEpoch[], claimed: ReadonlySet<number>) => epochs.filter((e) => e.you && !e.expired && !claimed.has(e.epoch)).pop() ?? null;

/** Sticky mobile header (below md): portfolio capsule on the left, the Live chip, Deposit and notifications on the right. */
export function MobileHeader() {
  const p = usePortfolio();
  const isMobile = useIsMobile();
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { toast, claimedFor } = useApp();
  const { key } = useLocation();
  const [sheet, setSheet] = useState(false);
  const [seen, setSeen] = useState(false);
  // The sheet belongs to the page it opened over: a navigation (Back, ⌘K, a link) or a switch to the desktop layout closes it.
  useEffect(() => setSheet(false), [key, isMobile]);
  // Building the demo reward epochs (real Merkle trees) takes ~150ms, so do it
  // when the browser is idle rather than as the sheet opens; undefined = not yet.
  const [epochs, setEpochs] = useState<readonly DemoEpoch[]>();
  const wallet = publicKey ?? DEMO_WALLET;
  useEffect(() => {
    if (!isMobile) return;
    setEpochs(undefined);
    const run = () => setEpochs(walletEpochs(wallet));
    // Safari has no requestIdleCallback.
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = window.setTimeout(run, 1200);
    return () => window.clearTimeout(t);
  }, [isMobile, wallet]);
  // The wallet's claims on the $PARABULL page count at once.
  const epoch = epochs && claimableEpoch(epochs, claimedFor(wallet.toBase58()));

  const deposit = async () => {
    if (!publicKey) return setVisible(true);
    const addr = publicKey.toBase58();
    try {
      await navigator.clipboard.writeText(addr);
      toast({ tone: "good", title: "Address copied: send SOL to it to deposit", body: addr });
    } catch {
      toast({ tone: "info", title: "Your deposit address", body: `Send SOL to ${addr}` });
    }
  };

  return (
    <>
      <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line bg-canvas/90 px-4 backdrop-blur-md md:hidden">
        {/* Under 330px the capsule gives up its right padding, so the figure and the Demo tag fit beside Deposit. */}
        <Link to="/portfolio" aria-label={`${isDemo ? "Portfolio" : "Demo portfolio"}: ${usd(p.equityUsd)}, ${usdSigned(p.change24hUsd)} today`} className="flex min-w-0 items-center gap-2.5 rounded-full py-1 pr-2 transition-opacity duration-100 ease-out active:opacity-80 max-[329px]:pr-0">
          <img src={p.avatar} alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-full ring-[1.5px] ring-copper/80 ring-offset-1 ring-offset-canvas" />
          <span className="flex min-w-0 flex-col items-start">
            {/* The figure truncates first: the Demo tag sits beside it, never inside the ellipsis. */}
            <span className="flex min-w-0 max-w-full items-center gap-1.5">
              <span className="num min-w-0 truncate text-[15px] font-semibold leading-5 text-cream">{usd(p.equityUsd)}</span>
              {/* Chain mode still shows the seeded portfolio (there's no indexer yet), even for a connected wallet: say so by the figure. */}
              {!isDemo && <span className="shrink-0 rounded border border-line px-1 text-[9px] font-bold uppercase leading-[13px] tracking-wide text-rosebronze">Demo</span>}
            </span>
            <PnlBadge usdChange={p.change24hUsd} pctChange={p.change24hPct} />
          </span>
        </Link>
        <div className="flex shrink-0 items-center gap-1.5">
          <LiveChip />
          <button
            type="button"
            onClick={deposit}
            className="touch-target rounded-full bg-gold px-3.5 py-1.5 text-xs font-bold text-canvas transition-[transform,background-color] duration-100 ease-out hover:bg-bronze active:scale-95"
          >
            Deposit
          </button>
          <IconButton
            label={seen ? "Notifications" : "Notifications, unread"}
            onClick={() => {
              setSheet(true);
              setSeen(true);
            }}
            className="-mr-2.5"
          >
            <Bell className="h-[22px] w-[22px]" strokeWidth={1.9} aria-hidden />
            {!seen && <span aria-hidden className="absolute right-[11px] top-[10px] h-2 w-2 rounded-full bg-gold ring-2 ring-canvas" />}
          </IconButton>
        </div>
      </header>
      {/* Outside the header: its backdrop blur would become the containing block of the sheet's fixed overlay. */}
      <BottomSheet open={sheet} onClose={() => setSheet(false)} title="Notifications">
        <NotificationList epoch={epoch} onPick={() => setSheet(false)} />
      </BottomSheet>
    </>
  );
}

type Note = { id: string; icon: LucideIcon; tone: keyof typeof TONE; title: string; body: string; to: string; at: number };
const TONE = { gold: "text-gold", ember: "text-ember", copper: "text-copper", rose: "text-rosebronze" } as const;

/** Demo notifications drawn from the live demo data; mounted only while the sheet is open. */
function NotificationList({ epoch, onPick }: { epoch: DemoEpoch | null | undefined; onPick: () => void }) {
  const { coins, callouts, following } = useMarket();
  const { holdings } = usePortfolio();
  const [now] = useState(() => Date.now());

  const notes: Note[] = [];
  const mover = [...holdings].sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))[0];
  if (mover) {
    const up = mover.change24h >= 0;
    notes.push({ id: "mover", icon: up ? TrendingUp : TrendingDown, tone: up ? "gold" : "ember", title: `$${mover.coin.ticker} is ${up ? "up" : "down"} ${pct(Math.abs(mover.change24h), 1, false)} today`, body: `Your position is worth ${usd(mover.valueUsd)} (${usdSigned(mover.pnlUsd)} unrealized)`, to: `/coin/${mover.coin.mint}`, at: now - 4 * MIN });
  }
  const call = callouts.find((c) => following.has(c.handle)) ?? callouts[0];
  const callCoin = call && coins.find((c) => c.mint === call.mint);
  if (call && callCoin) notes.push({ id: "callout", icon: Megaphone, tone: "copper", title: `@${call.handle} posted a callout on $${callCoin.ticker}`, body: `“${call.text}”`, to: `/coin/${call.mint}`, at: Math.min(call.ts, now - MIN) });
  const king = kingOf(coins);
  if (king) notes.push({ id: "king", icon: Crown, tone: "gold", title: `${king.name} is ${(progressOf(king) * 100).toFixed(1)}% of the way to Raydium`, body: `King of the Bull: ${(Number(king.reserves.realSol) / 1e9).toFixed(2)} of ${GRADUATION_SOL} SOL raised`, to: `/coin/${king.mint}`, at: now - 26 * MIN });
  if (epoch?.you) notes.push({ id: "epoch", icon: Gift, tone: "gold", title: `Epoch ${epoch.epoch} holder reward is ready to claim`, body: `${sol(BigInt(epoch.you.amount), 4)} from $PARABULL fees · claim within ${Math.max(1, Math.ceil((epoch.expiresAt - now) / DAY))} days`, to: "/parabull-token#claim", at: Math.min(epoch.publishedAt, now - HOUR) });
  const lock = coins.filter((c) => c.locks.ticker > now).sort((a, b) => a.locks.ticker - b.locks.ticker)[0];
  if (lock) notes.push({ id: "lock", icon: Lock, tone: "rose", title: `$${lock.ticker} ticker lock ends in ${age(lock.locks.ticker - now)}`, body: "Launch locks last 3 days; then the ticker and name are free to register again", to: `/coin/${lock.mint}`, at: now - 12 * MIN });
  const fresh = [...coins].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (fresh) notes.push({ id: "launch", icon: Sprout, tone: "gold", title: `New launch: ${fresh.name} ($${fresh.ticker})`, body: `by @${fresh.creatorHandle} · ${usdCompact(fresh.mcapUsd)} market cap`, to: `/coin/${fresh.mint}`, at: Math.min(fresh.createdAt, now) });
  notes.sort((a, b) => b.at - a.at);

  return (
    <div>
      <ul className="-mx-2 flex flex-col">
        {notes.map((n) => (
          <li key={n.id}>
            <Link to={n.to} onClick={onPick} className="flex min-h-[60px] items-start gap-3 rounded-xl px-2 py-2.5 transition-colors duration-100 ease-out active:bg-surface-3">
              <span className={cx("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface", TONE[n.tone])} aria-hidden>
                <n.icon className="h-[18px] w-[18px]" strokeWidth={1.9} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold leading-5 text-cream">{n.title}</span>
                <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-[18px] text-muted">{n.body}</span>
              </span>
              <span className="num shrink-0 pt-0.5 text-[11.5px] text-muted">{age(now - n.at)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {/* In both modes: chain mode's lists and positions are still demo data. */}
      <p className="mt-2 text-center text-[11.5px] text-muted">Demo data: notifications come from the simulated market.</p>
    </div>
  );
}

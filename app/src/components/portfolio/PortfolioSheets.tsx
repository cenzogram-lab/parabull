/**
 * The Portfolio page's overlays: trading stats, the balance breakdown, the
 * receive address and the wallet controls. Below md they're bottom sheets;
 * on desktop the same content opens in the centered modal.
 */
import { ArrowLeftRight, Check, Copy, FlaskConical, LogOut, TriangleAlert, Wallet } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { isDemo } from "../../config";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { pct, shortAddr, sol, usd, usdSigned } from "../../lib/format";
import type { Coin } from "../../lib/types";
import { useMarket } from "../../state/Market";
import type { Portfolio } from "../../state/usePortfolio";
import { BottomSheet } from "../mobile/MobileUi";
import { Modal } from "../ui/overlay";
import { ChangePill, cx } from "../ui/primitives";
import { NETWORK_NAME, profileCounts } from "./shared";

function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const isMobile = useIsMobile();
  if (isMobile)
    return (
      <BottomSheet open={open} onClose={onClose} title={title}>
        {children}
      </BottomSheet>
    );
  return (
    <Modal open={open} onClose={onClose} label={title} className="max-w-md" manageFocus>
      <div className="px-6 pb-6 pt-5">
        <h2 className="pr-10 text-[17px] font-semibold leading-7 text-cream">{title}</h2>
        <div className="mt-4">{children}</div>
      </div>
    </Modal>
  );
}

const tone = (n: number) => (n >= 0 ? "text-gold" : "text-ember");

function Tile({ label, value, foot }: { label: string; value: ReactNode; foot?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-3">
      <p className="text-[12px] font-medium leading-4 text-muted">{label}</p>
      <div className="mt-1.5 truncate text-[20px] font-semibold leading-7 tracking-tight text-cream">{value}</div>
      {foot && <p className="mt-0.5 truncate text-[11.5px] leading-4 text-muted">{foot}</p>}
    </div>
  );
}

// The portfolio is seeded in both modes (chain mode has no indexer yet), so its figures always say so.
const DemoNote = ({ children }: { children: string }) => <p className="mt-3 text-center text-[11.5px] leading-4 text-muted">{children}</p>;

/** Win rate, realized and unrealized PnL, open positions, the best coin and the trade count. */
export function StatsSheet({ open, onClose, p }: { open: boolean; onClose: () => void; p: Portfolio }) {
  const { byMint, demoTradeCount } = useMarket();
  const stats = useMemo(() => {
    const wins = p.closed.filter((c) => c.pnlUsd > 0).length;
    const realized = p.closed.reduce((n, c) => n + c.pnlUsd, 0);
    const unrealized = p.holdings.reduce((n, h) => n + h.pnlUsd, 0);
    const candidates: { coin: Coin; pnl: number; pnlPct: number; open: boolean }[] = [
      ...p.closed.flatMap((c) => {
        const coin = byMint.get(c.mint);
        return coin ? [{ coin, pnl: c.pnlUsd, pnlPct: c.pnlPct, open: false }] : [];
      }),
      ...p.holdings.map((h) => ({ coin: h.coin, pnl: h.pnlUsd, pnlPct: h.pnlPct, open: true })),
    ];
    const best = candidates.sort((a, b) => b.pnl - a.pnl)[0];
    return { wins, realized, unrealized, best };
  }, [p.closed, p.holdings, byMint]);
  // A seeded history plus the demo trades you made this visit.
  const trades = profileCounts(p.address).trades + demoTradeCount;
  const closedCount = p.closed.length;
  const best = stats.best;

  return (
    <Sheet open={open} onClose={onClose} title="Trading stats">
      <div className="grid grid-cols-2 gap-2.5">
        <Tile label="Win rate" value={closedCount ? pct(stats.wins / closedCount, 0, false) : "-"} foot={`${stats.wins} of ${closedCount} closed in profit`} />
        <Tile label="Trades" value={trades.toLocaleString("en-US")} foot="Buys and sells" />
        <Tile label="Realized PnL" value={<span className={cx("num", tone(stats.realized))}>{usdSigned(stats.realized)}</span>} foot="Closed positions" />
        <Tile label="Unrealized PnL" value={<span className={cx("num", tone(stats.unrealized))}>{usdSigned(stats.unrealized)}</span>} foot="At live prices" />
      </div>
      <p className="mt-2.5 flex min-h-[52px] items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2">
        <span className="text-[13px] font-medium text-muted">Open positions</span>
        <span className="num min-w-0 truncate text-right text-[14px] text-muted">
          <span className="text-[16px] font-semibold text-cream">{p.holdings.length}</span> · {usd(Math.max(0, p.equityUsd - p.cashUsd))} in coins
        </span>
      </p>
      {best && (
        <Link
          to={`/coin/${best.coin.mint}`}
          aria-label={`Best coin: ${best.coin.name}, ${best.open ? "unrealized" : "realized"} ${usdSigned(best.pnl)}. Open its page`}
          className="mt-2.5 flex min-h-[64px] items-center gap-3 rounded-xl border border-line bg-surface p-3 transition-colors duration-100 ease-out active:bg-surface-2 md:hover:border-line-accent md:hover:bg-surface-2"
        >
          <img src={best.coin.image} alt="" width={40} height={40} className="h-10 w-10 shrink-0 rounded-[10px] border border-line-accent object-cover" />
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-medium leading-4 text-muted">Best coin</span>
            <span className="block truncate text-[15px] font-semibold leading-5 text-cream">
              {best.coin.name} <span className="text-[13px] font-medium text-muted">${best.coin.ticker}</span>
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span className={cx("num block text-[15px] font-semibold leading-5", tone(best.pnl))}>{usdSigned(best.pnl)}</span>
            <span className="mt-0.5 flex justify-end">
              <ChangePill value={best.pnlPct} size="xs" soft />
            </span>
          </span>
        </Link>
      )}
      <DemoNote>{isDemo ? "Demo stats from the simulated market and your demo trades." : "Demo stats: the indexer doesn't serve portfolio history yet."}</DemoNote>
    </Sheet>
  );
}

/** Cash and holdings as a share of equity: 8px, rounded ends, a 2px gap; the rows above are its legend. */
function SplitBar({ holdings, cash }: { holdings: number; cash: number }) {
  const total = holdings + cash;
  const h = total > 0 ? holdings / total : 0;
  return (
    <div role="img" aria-label={`Holdings ${Math.round(h * 100)}%, cash ${Math.round((1 - h) * 100)}%`} className="flex h-2 w-full gap-[2px]">
      {h > 0 && <div className="rounded-l-full bg-gold last:rounded-r-full" style={{ width: `${h * 100}%` }} />}
      {h < 1 && <div className="rounded-r-full bg-bronze first:rounded-l-full" style={{ width: `${(1 - h) * 100}%` }} />}
    </div>
  );
}

function Line({ swatch, label, sub, value, strong = false }: { swatch?: string; label: string; sub?: string; value: string; strong?: boolean }) {
  return (
    <div className="flex min-h-[52px] items-center gap-3 px-3 py-2">
      {swatch ? <span aria-hidden className={cx("h-2.5 w-2.5 shrink-0 rounded-sm", swatch)} /> : <span aria-hidden className="w-2.5 shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className={cx("block text-[14px] leading-5", strong ? "font-semibold text-cream" : "font-medium text-cream")}>{label}</span>
        {sub && <span className="num block truncate text-[12px] leading-4 text-muted">{sub}</span>}
      </span>
      <span className={cx("num shrink-0 text-right leading-5 text-cream", strong ? "text-[16px] font-semibold" : "text-[14px] font-semibold")}>{value}</span>
    </div>
  );
}

/** Where the equity sits: SOL cash and coin holdings. */
export function BalanceSheet({ open, onClose, p }: { open: boolean; onClose: () => void; p: Portfolio }) {
  const { solUsd } = useMarket();
  const holdingsUsd = Math.max(0, p.equityUsd - p.cashUsd);
  return (
    <Sheet open={open} onClose={onClose} title="Balance">
      <div className="divide-y divide-line-soft rounded-xl border border-line bg-surface">
        <Line swatch="bg-bronze" label="Cash" sub={sol(p.cashSol, 3)} value={usd(p.cashUsd)} />
        <Line swatch="bg-gold" label="Holdings" sub={`${p.holdings.length} ${p.holdings.length === 1 ? "coin" : "coins"} at live prices`} value={usd(holdingsUsd)} />
        <Line label="Net equity" value={usd(p.equityUsd)} strong />
      </div>
      <div className="mt-4">
        {/* An overdrawn demo balance (below zero) shows as no cash. */}
        <SplitBar holdings={holdingsUsd} cash={Math.max(0, p.cashUsd)} />
      </div>
      <p className="mt-3 text-[12.5px] leading-[18px] text-muted">
        SOL is valued at <span className="num text-cream">${solUsd.toFixed(2)}</span>.
        {isDemo ? " Demo cash: your demo buys spend it and sells pay into it; a buy bigger than it takes it below zero." : " These are demo figures, not your wallet's balance: the indexer doesn't serve portfolio cash yet."}
      </p>
    </Sheet>
  );
}

/** "Copy address" that confirms in place: toasts sit under the sheet, so it can't rely on one. */
function CopyButton({ onCopy }: { onCopy: () => Promise<boolean> }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      onClick={async () => {
        setState((await onCopy()) ? "copied" : "failed");
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setState("idle"), 2000);
      }}
      className="btn-ghost h-11 w-full rounded-xl text-[14px] active:scale-[0.98]"
    >
      {state === "copied" ? <Check className="h-4 w-4 text-gold" strokeWidth={2.5} aria-hidden /> : <Copy className="h-4 w-4 text-copper" aria-hidden />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy: select the address above" : "Copy address"}</span>
    </button>
  );
}

function DemoWalletWarning() {
  return (
    <div className="mt-3 flex gap-2.5 rounded-xl border border-ember/35 bg-candle-down/20 p-3">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-ember" aria-hidden />
      <p className="text-[12.5px] leading-[18px] text-cream/90">This is the demo wallet: a placeholder address that nobody controls. Don't send anything to it. Connect your wallet to see your own address.</p>
    </div>
  );
}

/** Your address to receive SOL or tokens; no QR code. Without a wallet, a warning and Connect instead. */
export function ReceiveSheet({ open, onClose, address, connected, onCopy, onConnect }: { open: boolean; onClose: () => void; address: string; connected: boolean; onCopy: () => Promise<boolean>; onConnect: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Receive">
      <p className="text-[13px] font-medium leading-5 text-muted">{connected ? "Your Solana address" : "Demo wallet address"}</p>
      <p className={cx("mt-1.5 select-all break-all rounded-xl border border-line bg-canvas-2 px-3 py-3 font-mono text-[14px] leading-[22px]", connected ? "text-cream" : "text-muted")}>{address}</p>
      {connected ? (
        <>
          <div className="mt-3">
            <CopyButton onCopy={onCopy} />
          </div>
          <p className="mt-3 text-[12.5px] leading-[18px] text-muted">Send SOL, or any token on {NETWORK_NAME}, to this address. It arrives in the wallet you connected; tokens sent from another network can't be recovered.</p>
        </>
      ) : (
        <>
          <DemoWalletWarning />
          <button
            type="button"
            onClick={() => {
              onClose();
              // After the sheet has let go of the page's scroll lock: the wallet modal saves the body's overflow as it
              // opens and puts it back when it closes, so opening it in the same commit would restore "hidden".
              window.setTimeout(onConnect, 0);
            }}
            className="btn-gold mt-3 h-11 w-full rounded-xl text-[14.5px]"
          >
            <Wallet className="h-4 w-4" aria-hidden />
            Connect wallet
          </button>
        </>
      )}
    </Sheet>
  );
}

/** The connected wallet, with copy, change and disconnect; or what the demo wallet is, with Connect. */
export function WalletSheet({ open, onClose, address, connected, walletName, walletIcon, onCopy, onConnect, onDisconnect }: { open: boolean; onClose: () => void; address: string; connected: boolean; walletName?: string; walletIcon?: string; onCopy: () => Promise<boolean>; onConnect: () => void; onDisconnect: () => void }) {
  // As in ReceiveSheet: the follow-up (the wallet modal) runs once the sheet has released the scroll lock.
  const then = (f: () => void) => () => {
    onClose();
    window.setTimeout(f, 0);
  };
  return (
    <Sheet open={open} onClose={onClose} title="Wallet">
      <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3">
        <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-canvas-2">
          {connected && walletIcon ? <img src={walletIcon} alt="" width={24} height={24} className="h-6 w-6" /> : connected ? <Wallet className="h-5 w-5 text-copper" /> : <FlaskConical className="h-5 w-5 text-rosebronze" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold leading-5 text-cream">{connected ? (walletName ?? "Connected wallet") : "Demo wallet"}</span>
          <span className="block truncate font-mono text-[12.5px] leading-[18px] text-muted">{shortAddr(address, 6)}</span>
        </span>
      </div>
      {connected ? (
        <div className="mt-3 flex flex-col gap-2">
          <CopyButton onCopy={onCopy} />
          <button type="button" onClick={then(onConnect)} className="btn-ghost h-11 w-full rounded-xl text-[14px] active:scale-[0.98]">
            <ArrowLeftRight className="h-4 w-4 text-copper" aria-hidden />
            Change wallet
          </button>
          <button type="button" onClick={then(onDisconnect)} className="btn-ghost h-11 w-full rounded-xl text-[14px] text-ember active:scale-[0.98]">
            <LogOut className="h-4 w-4" aria-hidden />
            Disconnect
          </button>
        </div>
      ) : (
        <>
          <p className="mt-3 text-[12.5px] leading-[18px] text-muted">Until a wallet connects, this page shows a demo wallet with seeded positions and balances. Its address is a placeholder that nobody controls, so don't send anything to it.</p>
          <button type="button" onClick={then(onConnect)} className="btn-gold mt-4 h-11 w-full rounded-xl text-[14.5px]">
            <Wallet className="h-4 w-4" aria-hidden />
            Connect wallet
          </button>
        </>
      )}
    </Sheet>
  );
}

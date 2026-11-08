/**
 * Trades and holders for the mobile coin terminal (below md). The desktop
 * tables have six or seven columns; here each row keeps the four or five
 * that fit 390px and is one 44px link to the explorer, so nothing scrolls
 * sideways and there is no small icon to aim for.
 */
import { ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { explorer, isDemo } from "../../config";
import { useNow } from "../../hooks/useNow";
import { age, compact, shortAddr, sol, usdCompact, usdSigned } from "../../lib/format";
import type { Coin } from "../../lib/types";
import { holders as holderList } from "../../mock/market";
import { useMarket } from "../../state/Market";
import { cx, Empty } from "../ui/primitives";

const PAGE = 20;
const TRADE_COLS = "grid-cols-[40px_minmax(0,1fr)_58px_54px_28px_12px]";
const HOLDER_COLS = "grid-cols-[20px_minmax(0,1fr)_76px_56px_52px]";
const head = "grid items-end gap-2 border-b border-line px-4 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-wide text-muted";
const row = "grid h-11 items-center gap-2 border-b border-line-soft px-4 text-[12.5px] transition-colors duration-100 ease-out active:bg-surface-2";

/** Latest trades, newest first, 20 at a time. */
export function TradeFeed({ coin }: { coin: Coin }) {
  const { tradesFor } = useMarket();
  const now = useNow();
  const [shown, setShown] = useState(PAGE);
  const all = tradesFor(coin.mint);
  const rows = all.slice(0, shown);
  if (!rows.length) return <Empty>No trades yet.</Empty>;
  return (
    <div>
      <div aria-hidden className={cx(head, TRADE_COLS)}>
        <span>Type</span>
        <span>Trader</span>
        <span className="text-right">SOL</span>
        <span className="truncate text-right">{coin.ticker}</span>
        <span className="text-right">Age</span>
        <span />
      </div>
      <ul>
        {rows.map((t) => {
          const amount = sol(t.sol, 3).replace(" SOL", "");
          return (
            <li key={t.id}>
              <a
                href={explorer("tx", t.sig)}
                target="_blank"
                rel="noreferrer"
                aria-label={`${t.side === "buy" ? "Buy" : "Sell"} by @${t.handle}: ${amount} SOL for ${compact(t.tokens)} ${coin.ticker}, ${age(now - t.ts)} ago. View transaction`}
                className={cx(row, TRADE_COLS, t.id.startsWith("live") && "animate-flash")}
              >
                <span className={cx("justify-self-start rounded px-1.5 py-0.5 text-[10.5px] font-bold uppercase leading-4", t.side === "buy" ? "bg-gold/15 text-gold" : "bg-candle-down/30 text-ember")}>{t.side}</span>
                <span className="truncate font-medium text-cream">@{t.handle}</span>
                <span className="num text-right text-cream">{amount}</span>
                <span className="num text-right text-muted">{compact(t.tokens)}</span>
                <span className="num text-right text-muted">{age(now - t.ts)}</span>
                <ExternalLink className="h-3 w-3 text-muted/70" aria-hidden />
              </a>
            </li>
          );
        })}
      </ul>
      {all.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + PAGE)} className="h-11 w-full text-[13px] font-semibold text-gold transition-opacity duration-100 ease-out active:opacity-70">
          Show {Math.min(PAGE, all.length - shown)} more trades
        </button>
      )}
    </div>
  );
}

/** Top holders: share of supply with a bar, value, and unrealized PnL. */
export function HolderList({ coin }: { coin: Coin }) {
  const { holdersFor } = useMarket();
  const onChain = holdersFor(coin.mint);
  const rows = useMemo(() => onChain ?? (isDemo ? holderList(coin) : []), [onChain, coin]);
  if (!rows.length) return <p className="px-4 py-6 text-center text-[13px] text-muted">{isDemo ? "No holders yet." : "Loading holders…"}</p>;
  return (
    <div>
      <div aria-hidden className={cx(head, HOLDER_COLS)}>
        <span>#</span>
        <span>Holder</span>
        <span>Supply</span>
        <span className="text-right">Value</span>
        <span className="text-right">PnL</span>
      </div>
      <ul>
        {rows.map((h, i) => {
          const share = `${(h.pct * 100).toFixed(2)}%`;
          return (
            <li key={h.address}>
              <a
                href={explorer("account", h.address)}
                target="_blank"
                rel="noreferrer"
                aria-label={`${i + 1}. ${h.label ?? shortAddr(h.address, 5)}: ${share} of supply, ${usdCompact(h.valueUsd)}${h.label || h.pnlUsd === null ? "" : `, ${usdSigned(h.pnlUsd, 0)}`}. View account`}
                className={cx(row, HOLDER_COLS)}
              >
                <span className="num text-muted">{i + 1}</span>
                {h.label ? (
                  <span className="min-w-0 justify-self-start truncate rounded bg-surface-3 px-1.5 py-0.5 text-[11px] font-semibold text-rosebronze">{h.label}</span>
                ) : (
                  <span className="truncate font-mono text-[12px] text-cream">{shortAddr(h.address, 5)}</span>
                )}
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-6 shrink-0 overflow-hidden rounded-full bg-[#2A211B]">
                    <span className="block h-full rounded-full bg-copper" style={{ width: `${Math.min(100, h.pct * 100)}%` }} />
                  </span>
                  <span className="num text-cream">{share}</span>
                </span>
                <span className="num text-right text-cream">{usdCompact(h.valueUsd)}</span>
                <span className={cx("num text-right", h.label || h.pnlUsd === null ? "text-muted" : h.pnlUsd >= 0 ? "text-gold" : "text-ember")}>{h.label || h.pnlUsd === null ? "-" : usdSigned(h.pnlUsd, 0)}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

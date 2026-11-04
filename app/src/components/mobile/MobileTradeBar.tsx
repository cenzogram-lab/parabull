/**
 * Buy / Sell bar for the mobile coin terminal (below md), and the bottom
 * sheet it opens with the trade panel preset to the side that was tapped.
 */
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { price, usdCompact } from "../../lib/format";
import type { Coin } from "../../lib/types";
import { TradePanel } from "../coin/TradePanel";
import { ChangePill } from "../ui/primitives";
import { CoinAvatar } from "../ui/visuals";
import { BottomSheet } from "./MobileUi";

type Side = "buy" | "sell";

/**
 * Render it last on the page. It sticks just above the floating nav while
 * the page scrolls, then settles under the last section, so at rest it
 * covers nothing (the footnote after the page included). Its ::before is a
 * canvas backdrop from just above the buttons down to the nav, so content
 * scrolling underneath doesn't show around them.
 */
export function MobileTradeBar({ coin }: { coin: Coin }) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<Side>("buy");
  // A fresh panel per opening, even if the last one is still sliding out.
  const [opening, setOpening] = useState(0);
  const start = (s: Side) => {
    setSide(s);
    setOpening((n) => n + 1);
    setOpen(true);
  };
  return (
    <>
      {/* On a short screen (a phone in landscape) it stays in place after the page, so the content keeps room between the bars. */}
      <div className="pointer-events-none sticky bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 mx-4 mt-4 grid grid-cols-2 gap-3 max-md:[@media(max-height:480px)]:relative max-md:[@media(max-height:480px)]:bottom-auto before:absolute before:-inset-x-4 before:-bottom-3 before:-top-4 before:-z-10 before:bg-[linear-gradient(to_bottom,transparent,theme(colors.canvas.DEFAULT)_16px)]">
        <button type="button" onClick={() => start("buy")} aria-haspopup="dialog" className="btn-gold pointer-events-auto h-12 rounded-2xl text-[15px] font-bold shadow-[0_10px_28px_-8px_rgba(0,0,0,0.9)]">
          <ArrowUpRight className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />
          Buy
        </button>
        <button
          type="button"
          onClick={() => start("sell")}
          aria-haspopup="dialog"
          className="btn pointer-events-auto h-12 rounded-2xl bg-candle-down text-[15px] font-bold text-cream shadow-[inset_0_0_0_1px_theme(colors.candle.downEdge),0_10px_28px_-8px_rgba(0,0,0,0.9)] active:scale-[0.98]"
        >
          <ArrowDownRight className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />
          Sell
        </button>
      </div>
      {/* A sibling of the bar, at the page root: nothing above it has a transform or backdrop blur to trap the fixed overlay. */}
      <BottomSheet open={open} onClose={() => setOpen(false)} title={`Trade $${coin.ticker}`}>
        <div className="mb-3 flex items-center gap-3 rounded-xl border border-line-soft bg-canvas-2 px-3 py-2.5">
          <CoinAvatar src={coin.image} alt="" size={36} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold text-cream">{coin.name}</div>
            <div className="num truncate text-xs text-muted">
              MC <span className="text-cream">{usdCompact(coin.mcapUsd)}</span> · {price(coin.priceUsd)}
            </div>
          </div>
          <ChangePill value={coin.change24h} size="xs" soft />
        </div>
        <TradePanel key={opening} coin={coin} initialSide={side} framed={false} onPlaced={() => setOpen(false)} />
      </BottomSheet>
    </>
  );
}

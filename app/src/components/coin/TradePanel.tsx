import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { ArrowDownUp, CircleAlert, ExternalLink, Info, Loader2, Megaphone, Settings2, ShieldCheck, Zap } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { explorer, isDemo } from "../../config";
import { liveCurveOf, useLiveCurve } from "../../hooks/useLiveCurve";
import { useParabullProgram } from "../../hooks/useParabullProgram";
import { compact, pct, shortAddr, sol, tokens as fmtTokens, usd, usdCompact } from "../../lib/format";
import { requoteBuy, requoteSell } from "../../lib/quote";
import { referralFor } from "../../lib/referral";
import { TxUnconfirmedError } from "../../lib/txSend";
import { raydiumSwapUrl } from "../../lib/links";
import { bpsLabel } from "../../lib/protocolParams";
import type { Coin } from "../../lib/types";
import { useApp } from "../../state/AppState";
import { raydiumSell, useMarket } from "../../state/Market";
import { useProtocol } from "../../state/Protocol";
import { cx, Popover } from "../ui/primitives";
import { RatioBar } from "../ui/visuals";

const BUY_PRESETS = [0.1, 0.5, 1, 5];
const SELL_PRESETS = [25, 50, 100];

/**
 * Buy / Sell ticket. The mobile trade sheet opens it on the side that was
 * tapped (`initialSide`) without the panel frame (`framed={false}`), and
 * closes when `onPlaced` runs after a trade goes through.
 */
export function TradePanel({ coin, initialSide = "buy", framed = true, onPlaced }: { coin: Coin; initialSide?: "buy" | "sell"; framed?: boolean; onPlaced?: () => void }) {
  const client = useParabullProgram();
  const { setVisible } = useWalletModal();
  const { demoTrade, positions, refreshPositions } = useMarket();
  const { toast, sfx } = useApp();
  // The fee the program charges and the SOL/USD used for dollar amounts: from Global and the live price feed in chain
  // mode, the 1% default and the fixed demo price in demo mode.
  const { params, solUsd: quote } = useProtocol();
  const solUsd = quote.price;
  const feeBps = BigInt(params.platformFeeBps);
  const [side, setSide] = useState<"buy" | "sell">(initialSide);
  const [unit, setUnit] = useState<"SOL" | "USD">("SOL");
  const [amount, setAmount] = useState("0.5");
  const [sellPct, setSellPct] = useState(50);
  const [slippage, setSlippage] = useState(2);
  const [busy, setBusy] = useState(false);
  // Shown inline in the mobile sheet, whose backdrop sits above the toasts.
  const [failed, setFailed] = useState<string | null>(null);
  const held = positions[coin.mint]?.tokens ?? 0n;
  const slippageBps = BigInt(Math.round(slippage * 100));
  // Chain mode: the curve as the chain has it (subscribed), ahead of the indexer's copy, for quoting.
  const [live, setLive] = useLiveCurve(coin.mint, !coin.migrated);
  // The coin on screen now: a curve read that returns after a switch to another coin must not land on it.
  const shownMint = useRef(coin.mint);
  shownMint.current = coin.mint;
  const reserves = live?.reserves ?? coin.reserves;
  // The last token sold: the program refuses buys and sells (CurveComplete) until the crank migrates to Raydium.
  const complete = !coin.migrated && (coin.complete || !!live?.complete);

  const lamports = useMemo(() => {
    const v = Number(amount);
    if (!Number.isFinite(v) || v <= 0) return 0n;
    return BigInt(Math.round((unit === "SOL" ? v : v / solUsd) * 1e9));
  }, [amount, unit, solUsd]);
  const sellTokens = (held * BigInt(sellPct)) / 100n;

  const buyQ = useMemo(() => (side === "buy" && !coin.migrated && !complete ? client.quoteBuyWithSol(reserves, lamports, feeBps, slippageBps) : null), [side, coin.migrated, complete, reserves, lamports, feeBps, slippageBps, client]);
  const sellQ = useMemo(() => (side === "sell" && !coin.migrated && !complete ? client.quoteSellTokens(reserves, sellTokens, feeBps, slippageBps) : null), [side, coin.migrated, complete, reserves, sellTokens, feeBps, slippageBps, client]);
  // Graduated coins trade on Raydium; the estimate uses the pool price, and a sale is quoted as it will book (raydiumSell).
  const poolEstimate = coin.migrated ? (side === "buy" ? (Number(lamports) / 1e9) * solUsd * 0.99 / coin.priceUsd : raydiumSell(coin, Number(sellTokens) / 1e6).usd) : 0;

  const canTrade = !complete && (side === "buy" ? lamports > 0n && (coin.migrated || buyQ !== null) : sellTokens > 0n && (coin.migrated || sellQ !== null));

  const referral = !isDemo && side === "buy" && !coin.migrated ? referralFor(coin.mint, client.publicKey?.toBase58() ?? null) : null;

  async function place() {
    if (!isDemo && !client.connected) return setVisible(true);
    if (!isDemo && coin.migrated) {
      window.open(raydiumSwapUrl(coin.mint), "_blank", "noopener");
      return;
    }
    setBusy(true);
    setFailed(null);
    let placed = false;
    try {
      if (isDemo) {
        const t = demoTrade(coin.mint, side, side === "buy" ? lamports : sellTokens, slippageBps);
        if (!t) throw new Error("Quote no longer fits the curve");
        sfx(side);
        toast({ tone: "good", title: `${side === "buy" ? "Bought" : "Sold"} ${compact(t.tokens)} $${coin.ticker}`, body: `${t.sol.toFixed(3)} SOL · demo trade, nothing was sent on-chain` });
        placed = true;
      } else if ((side === "buy" && buyQ) || (side === "sell" && sellQ)) {
        // Quote again on the curve as the chain has it right now, not the indexer's copy.
        const mint = new PublicKey(coin.mint);
        const account = await client.fetchCurve(mint);
        if (!account) throw new Error("This coin's bonding curve wasn't found on-chain");
        const fresh = liveCurveOf(account as unknown as Parameters<typeof liveCurveOf>[0]);
        if (shownMint.current === coin.mint) setLive(fresh);
        if (fresh.complete) throw new Error("The bonding curve just completed: trading resumes on Raydium once the coin migrates");
        if (side === "buy" && buyQ) {
          const r = requoteBuy(fresh.reserves, lamports, buyQ, feeBps, slippageBps);
          if (!r.ok) throw new Error(r.reason);
          // A followed callout link tags the buy (never the buyer's own callout): see src/lib/referral.ts.
          const sig = await client.buy(mint, r.quote.tokens, r.quote.maxCost, referral?.calloutId ?? null);
          sfx("buy");
          toast({ tone: "good", title: `Bought ${fmtTokens(r.quote.tokens)} $${coin.ticker}`, body: explorer("tx", sig) });
        } else if (sellQ) {
          const r = requoteSell(fresh.reserves, sellTokens, sellQ, feeBps, slippageBps);
          if (!r.ok) throw new Error(r.reason);
          const sig = await client.sell(mint, r.quote.tokens, r.quote.minOut);
          sfx("sell");
          toast({ tone: "good", title: `Sold ${fmtTokens(r.quote.tokens)} $${coin.ticker}`, body: explorer("tx", sig) });
        }
        placed = true;
      }
    } catch (e) {
      if (e instanceof TxUnconfirmedError) {
        // Sent, but no status in time: it may still land, so this isn't a failure to retry.
        toast({ tone: "info", title: "Trade sent, not confirmed yet", body: `${e.message} ${explorer("tx", e.signature)}` });
        setFailed(e.message);
        if (!isDemo) refreshPositions();
      } else {
        toast({ tone: "bad", title: "Trade failed", body: (e as Error).message });
        setFailed(`Trade failed: ${(e as Error).message}`);
      }
    } finally {
      setBusy(false);
    }
    if (placed) {
      // Chain mode: the indexer re-reads the wallet's balances (the trade itself arrives on its stream).
      if (!isDemo) refreshPositions();
      onPlaced?.();
    }
  }

  const receive =
    side === "buy"
      ? coin.migrated
        ? `${compact(poolEstimate)} ${coin.ticker}`
        : buyQ
          ? `${fmtTokens(buyQ.tokens)} ${coin.ticker}`
          : "-"
      : coin.migrated
        ? usd(poolEstimate)
        : sellQ
          ? sol(sellQ.solNet, 4)
          : "-";

  return (
    <div className={framed ? "panel p-4" : undefined}>
      <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-canvas-2 p-1" role="tablist" aria-label="Side">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} role="tab" aria-selected={side === s} onClick={() => setSide(s)} className={cx("h-9 rounded-lg text-sm font-bold capitalize transition-colors max-md:h-11 max-md:text-[15px]", side === s ? (s === "buy" ? "metal-gold text-canvas" : "bg-candle-down text-cream shadow-[inset_0_0_0_1px_#B5503A]") : "text-muted hover:text-cream")}>
            {s}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-muted">
        {side === "buy" ? (
          <button onClick={() => setUnit((u) => (u === "SOL" ? "USD" : "SOL"))} className="inline-flex items-center gap-1 font-semibold text-cream hover:text-gold max-md:h-11 max-md:text-[13px]">
            <ArrowDownUp className="h-3.5 w-3.5" /> Switch to {unit === "SOL" ? "USD" : "SOL"}
          </button>
        ) : (
          <span>
            Balance: <span className="num text-cream">{fmtTokens(held)}</span> {coin.ticker}
          </span>
        )}
        <Popover
          trigger={() => (
            <button className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 font-semibold text-cream hover:border-line-accent max-md:h-11 max-md:rounded-lg max-md:px-3 max-md:text-[13px]">
              <Settings2 className="h-3.5 w-3.5 text-copper" /> Slippage {slippage}%
            </button>
          )}
          className="w-56"
        >
          {(close) => (
            <div>
              <div className="label mb-2">Max slippage</div>
              <div className="grid grid-cols-4 gap-1">
                {[0.5, 1, 2, 5].map((s) => (
                  <button key={s} onClick={() => (setSlippage(s), close())} className={cx("chip justify-center", s === slippage && "chip-active")}>
                    {s}%
                  </button>
                ))}
              </div>
              <label className="mt-3 flex items-center gap-2 text-xs text-muted">
                Custom
                <input type="number" min={0.1} max={50} step={0.1} value={slippage} onChange={(e) => setSlippage(Math.max(0.1, Math.min(50, Number(e.target.value) || 0.1)))} className="input h-8 py-1 text-right" />%
              </label>
              <p className="mt-2 text-[11.5px] leading-4 text-muted">Sent on-chain as {side === "buy" ? "max_sol_cost" : "min_sol_output"}; the program rejects the trade beyond it.</p>
            </div>
          )}
        </Popover>
      </div>

      {side === "buy" ? (
        <label className="input-shell mt-2 h-14 gap-2 rounded-xl px-3">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} className="num w-full bg-transparent text-2xl font-semibold text-cream outline-none max-md:h-full" aria-label={`Amount in ${unit}`} />
          <span className="rounded-md bg-surface-2 px-2 py-1 text-xs font-bold text-cream">{unit}</span>
        </label>
      ) : (
        <div className="mt-2 flex h-14 items-center gap-2 rounded-xl border border-line bg-canvas-2 px-3">
          <span className="num w-full text-2xl font-semibold">{fmtTokens(sellTokens)}</span>
          <span className="rounded-md bg-surface-2 px-2 py-1 text-xs font-bold text-cream">{coin.ticker}</span>
        </div>
      )}

      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {side === "buy"
          ? BUY_PRESETS.map((p) => {
              const v = unit === "SOL" ? p : Math.round(p * solUsd);
              return (
                <button key={p} onClick={() => setAmount(String(v))} className={cx("chip h-8 justify-center", Number(amount) === v && "chip-active")}>
                  {unit === "SOL" ? `${p} SOL` : `$${v}`}
                </button>
              );
            })
          : [...SELL_PRESETS.map((p) => (
              <button key={p} onClick={() => setSellPct(p)} className={cx("chip h-8 justify-center", sellPct === p && "chip-active")}>
                {p}%
              </button>
            )), <span key="pad" />]}
      </div>

      <dl className="mt-4 space-y-1.5 text-[12.5px]">
        <div className="flex justify-between">
          <dt className="text-muted">You receive</dt>
          <dd className="num font-semibold text-cream">{receive}</dd>
        </div>
        {!coin.migrated && (
          <>
            <div className="flex justify-between">
              <dt className="text-muted">Price impact</dt>
              <dd className={cx("num", ((buyQ ?? sellQ)?.priceImpact ?? 0) > 0.05 ? "text-ember" : "text-cream")}>{pct((buyQ ?? sellQ)?.priceImpact ?? 0, 2, false)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">{`Platform fee (${bpsLabel(params.platformFeeBps)}) · creator fee 0%`}</dt>
              <dd className="num text-cream">{sol((buyQ ?? sellQ)?.fee ?? 0n, 4)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">{side === "buy" ? "Max cost" : "Min received"}</dt>
              <dd className="num text-cream">{side === "buy" ? sol(buyQ?.maxCost ?? 0n, 4) : sol(sellQ?.minOut ?? 0n, 4)}</dd>
            </div>
          </>
        )}
      </dl>
      {buyQ?.completesCurve && (
        <p className="mt-3 flex gap-2 rounded-lg border border-gold/30 bg-gold/10 p-2 text-xs text-gold">
          <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0" /> This buy takes the last curve tokens and completes the bonding curve. Migration to Raydium follows.
        </p>
      )}

      {!framed && failed && (
        <p role="alert" className="mt-3 flex gap-2 rounded-lg border border-ember/40 bg-candle-down/20 p-2 text-xs text-ember">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {failed}
        </p>
      )}
      {complete && (
        <p role="status" className="mt-3 flex gap-2 rounded-lg border border-gold/30 bg-gold/10 p-2 text-xs text-gold">
          <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> The bonding curve is complete. Buying and selling pause until the coin migrates to Raydium, where trading resumes.
        </p>
      )}
      <button onClick={place} disabled={busy || !canTrade} className="btn-gold mt-4 h-12 w-full text-[15px]">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {complete ? "Curve complete: migrating" : !isDemo && !client.connected ? "Connect wallet to trade" : !isDemo && coin.migrated ? "Trade on Raydium" : "Place Trade"}
        {!isDemo && coin.migrated && <ExternalLink className="h-4 w-4" />}
      </button>
      {isDemo && (
        <p className="mt-2 flex items-center justify-center gap-1 text-[11.5px] text-muted">
          <Info className="h-3 w-3" /> Demo mode: trades are simulated locally
        </p>
      )}
      {referral && (
        <p className="mt-2 flex items-center justify-center gap-1 text-[11.5px] text-muted">
          <Megaphone className="h-3 w-3 text-copper" aria-hidden /> Tagged with {shortAddr(referral.author, 4)}'s callout: it credits them, at no cost to you
        </p>
      )}
    </div>
  );
}

export function TradeStats({ coin }: { coin: Coin }) {
  const total = coin.buys24h + coin.sells24h;
  return (
    <div className="panel p-4">
      <h3 className="text-[13px] font-semibold">Stats & audit · 24h</h3>
      <div className="mt-3">
        <RatioBar a={coin.buyVolUsd} b={coin.sellVolUsd} aLabel="Buy volume" bLabel="Sell volume" />
        <div className="mt-2 flex justify-between text-xs max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-1">
          <span className="flex items-center gap-1.5 text-muted">
            <span className="h-2 w-2 rounded-full bg-gold" /> Buys <span className="num text-cream">{coin.buys24h.toLocaleString("en-US")}</span> · <span className="num text-cream">{usdCompact(coin.buyVolUsd)}</span>
          </span>
          <span className="flex items-center gap-1.5 text-muted">
            <span className="h-2 w-2 rounded-full bg-ember" /> Sells <span className="num text-cream">{coin.sells24h.toLocaleString("en-US")}</span> · <span className="num text-cream">{usdCompact(coin.sellVolUsd)}</span>
          </span>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
        {[
          ["Trades", total.toLocaleString("en-US")],
          ["Traders", coin.traders24h.toLocaleString("en-US")],
          ["Holders", coin.holders.toLocaleString("en-US")],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-line-soft bg-canvas-2 py-2">
            <dt className="text-[11px] text-muted">{k}</dt>
            <dd className="num text-[14px] font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex gap-2.5 rounded-lg border border-line-soft bg-canvas-2 p-3">
        <ShieldCheck className={cx("mt-0.5 h-4 w-4 shrink-0", coin.migrated ? "text-gold" : "text-muted")} />
        {coin.migrated ? (
          <div className="text-xs leading-5">
            <div className="font-semibold text-cream">Raydium liquidity locked</div>
            <div className="text-muted">LP sits in Raydium Burn & Earn; the protocol holds the fee key, and meme tokens collected from LP fees are burned.</div>
          </div>
        ) : (
          <div className="text-xs leading-5">
            <div className="font-semibold text-cream">No LP yet: trading on the bonding curve</div>
            <div className="text-muted">At 85 SOL the curve migrates to Raydium CPMM and the LP is locked in Burn & Earn automatically.</div>
          </div>
        )}
      </div>
    </div>
  );
}

import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { ArrowDownUp, ExternalLink, Info, Loader2, Settings2, ShieldCheck, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { explorer, isDemo } from "../../config";
import { useParabullProgram } from "../../hooks/useParabullProgram";
import { compact, pct, sol, tokens as fmtTokens, usd, usdCompact } from "../../lib/format";
import { PROTOCOL } from "../../lib/protocol";
import type { Coin } from "../../lib/types";
import { useApp } from "../../state/AppState";
import { useMarket } from "../../state/Market";
import { cx, Popover } from "../ui/primitives";
import { RatioBar } from "../ui/visuals";

const BUY_PRESETS = [0.1, 0.5, 1, 5];
const SELL_PRESETS = [25, 50, 100];
const FEE_BPS = PROTOCOL.platformFeeBps;

export function TradePanel({ coin }: { coin: Coin }) {
  const client = useParabullProgram();
  const { setVisible } = useWalletModal();
  const { demoTrade, positions, solUsd } = useMarket();
  const { toast, sfx } = useApp();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [unit, setUnit] = useState<"SOL" | "USD">("SOL");
  const [amount, setAmount] = useState("0.5");
  const [sellPct, setSellPct] = useState(50);
  const [slippage, setSlippage] = useState(2);
  const [busy, setBusy] = useState(false);
  const held = positions[coin.mint]?.tokens ?? 0n;
  const slippageBps = BigInt(Math.round(slippage * 100));

  const lamports = useMemo(() => {
    const v = Number(amount);
    if (!Number.isFinite(v) || v <= 0) return 0n;
    return BigInt(Math.round((unit === "SOL" ? v : v / solUsd) * 1e9));
  }, [amount, unit, solUsd]);
  const sellTokens = (held * BigInt(sellPct)) / 100n;

  const buyQ = useMemo(() => (side === "buy" && !coin.migrated ? client.quoteBuyWithSol(coin.reserves, lamports, FEE_BPS, slippageBps) : null), [side, coin, lamports, slippageBps, client]);
  const sellQ = useMemo(() => (side === "sell" && !coin.migrated ? client.quoteSellTokens(coin.reserves, sellTokens, FEE_BPS, slippageBps) : null), [side, coin, sellTokens, slippageBps, client]);
  // Graduated coins trade on Raydium; the estimate uses the pool price.
  const poolEstimate = coin.migrated ? (side === "buy" ? (Number(lamports) / 1e9) * solUsd * 0.99 / coin.priceUsd : (Number(sellTokens) / 1e6) * coin.priceUsd * 0.99) : 0;

  const canTrade = side === "buy" ? lamports > 0n && (coin.migrated || buyQ !== null) : sellTokens > 0n && (coin.migrated || sellQ !== null);

  async function place() {
    if (!isDemo && !client.connected) return setVisible(true);
    if (!isDemo && coin.migrated) {
      window.open(`https://raydium.io/swap/?inputMint=sol&outputMint=${coin.mint}`, "_blank", "noopener");
      return;
    }
    setBusy(true);
    try {
      if (isDemo) {
        const t = demoTrade(coin.mint, side, side === "buy" ? lamports : sellTokens, slippageBps);
        if (!t) throw new Error("Quote no longer fits the curve");
        sfx(side);
        toast({ tone: "good", title: `${side === "buy" ? "Bought" : "Sold"} ${compact(t.tokens)} $${coin.ticker}`, body: `${t.sol.toFixed(3)} SOL · demo trade, nothing was sent on-chain` });
      } else if (side === "buy" && buyQ) {
        const sig = await client.buy(new PublicKey(coin.mint), buyQ.tokens, buyQ.maxCost);
        sfx("buy");
        toast({ tone: "good", title: `Bought ${fmtTokens(buyQ.tokens)} $${coin.ticker}`, body: explorer("tx", sig) });
      } else if (side === "sell" && sellQ) {
        const sig = await client.sell(new PublicKey(coin.mint), sellQ.tokens, sellQ.minOut);
        sfx("sell");
        toast({ tone: "good", title: `Sold ${fmtTokens(sellQ.tokens)} $${coin.ticker}`, body: explorer("tx", sig) });
      }
    } catch (e) {
      toast({ tone: "bad", title: "Trade failed", body: (e as Error).message });
    } finally {
      setBusy(false);
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
    <div className="panel p-4">
      <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-canvas-2 p-1" role="tablist" aria-label="Side">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} role="tab" aria-selected={side === s} onClick={() => setSide(s)} className={cx("h-9 rounded-lg text-sm font-bold capitalize transition-colors", side === s ? (s === "buy" ? "metal-gold text-canvas" : "bg-candle-down text-cream shadow-[inset_0_0_0_1px_#B5503A]") : "text-muted hover:text-cream")}>
            {s}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-muted">
        {side === "buy" ? (
          <button onClick={() => setUnit((u) => (u === "SOL" ? "USD" : "SOL"))} className="inline-flex items-center gap-1 font-semibold text-cream hover:text-gold">
            <ArrowDownUp className="h-3.5 w-3.5" /> Switch to {unit === "SOL" ? "USD" : "SOL"}
          </button>
        ) : (
          <span>
            Balance: <span className="num text-cream">{fmtTokens(held)}</span> {coin.ticker}
          </span>
        )}
        <Popover
          trigger={() => (
            <button className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 font-semibold text-cream hover:border-line-accent">
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
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} className="num w-full bg-transparent text-2xl font-semibold text-cream outline-none" aria-label={`Amount in ${unit}`} />
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
              <dt className="text-muted">Platform fee (1%) · creator fee 0%</dt>
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

      <button onClick={place} disabled={busy || !canTrade} className="btn-gold mt-4 h-12 w-full text-[15px]">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {!isDemo && !client.connected ? "Connect wallet to trade" : !isDemo && coin.migrated ? "Trade on Raydium" : "Place Trade"}
        {!isDemo && coin.migrated && <ExternalLink className="h-4 w-4" />}
      </button>
      {isDemo && (
        <p className="mt-2 flex items-center justify-center gap-1 text-[11.5px] text-muted">
          <Info className="h-3 w-3" /> Demo mode: trades are simulated locally
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
        <div className="mt-2 flex justify-between text-xs">
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

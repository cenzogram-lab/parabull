import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ExternalLink, GraduationCap, Loader2, Megaphone } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { explorer, isDemo } from "../../config";
import { useNow } from "../../hooks/useNow";
import { age, compact, price, shortAddr, sol, usd, usdCompact, usdSigned } from "../../lib/format";
import { CALLOUT_MAX_CHARS, CALLOUT_MIN_HOLDING } from "../../lib/callouts";
import { GRADUATION_RAISE_LAMPORTS } from "../../lib/protocol";
import type { Coin } from "../../lib/types";
import { progressOf } from "../../mock/coins";
import { holders as holderList } from "../../mock/market";
import { useApp } from "../../state/AppState";
import { useMarket } from "../../state/Market";
import { useProtocol } from "../../state/Protocol";
import { cx, Empty } from "../ui/primitives";
import { Meter } from "../ui/visuals";
import { CalloutCard } from "./CoinViews";

export function MigrationGauge({ coin }: { coin: Coin }) {
  const p = progressOf(coin);
  const raised = Number(coin.reserves.realSol) / 1e9;
  const target = Number(GRADUATION_RAISE_LAMPORTS) / 1e9;
  return (
    <div className="panel p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
          <GraduationCap className="h-4 w-4 text-copper" /> Bonding curve
        </h3>
        <span className="text-xl font-semibold">{coin.migrated ? "Graduated" : `${(p * 100).toFixed(1)}%`}</span>
      </div>
      <div className="mt-3">
        <Meter value={p} label="Bonding curve progress toward Raydium migration" />
      </div>
      <p className="mt-2.5 text-xs leading-5 text-muted">
        {coin.migrated ? (
          <>Migrated to Raydium CPMM. The LP is locked in Burn & Earn and its trading fees keep feeding the flywheel.</>
        ) : (
          <>
            <span className="num text-cream">{raised.toFixed(2)}</span> of <span className="num text-cream">{target.toFixed(0)} SOL</span> raised.{" "}
            <span className="num text-cream">{Math.max(0, target - raised).toFixed(2)} SOL</span> more and it migrates to Raydium CPMM with locked liquidity.
          </>
        )}
      </p>
    </div>
  );
}

export function EscrowGauge({ coin }: { coin: Coin }) {
  // The on-chain lamport target at today's SOL price in chain mode; the flat $299 in demo mode.
  const target = Math.max(1, Math.round(useProtocol().dexTargetUsd));
  const v = coin.escrowUsd / target;
  return (
    <div className="panel p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Megaphone className="h-4 w-4 text-copper" /> DexScreener listing fund
        </h3>
        <span className="num text-xl font-semibold">
          {usd(Math.min(coin.escrowUsd, target), 0)}
          <span className="text-sm font-medium text-muted"> / ${target}</span>
        </span>
      </div>
      <div className="mt-3">
        <Meter value={v} tone="gold" label="DexScreener escrow funding" />
      </div>
      <p className="mt-2.5 text-xs leading-5 text-muted">
        {coin.escrowReleased
          ? "Funded and released to the treasury to pay for the DexScreener listing."
          : `The first platform fees from this coin fill this escrow. Once it reaches $${target}, anyone can release it to pay for the listing.`}
      </p>
    </div>
  );
}

export function HoldersTable({ coin }: { coin: Coin }) {
  const { holdersFor } = useMarket();
  const onChain = holdersFor(coin.mint);
  // Demo mode: the seeded holders. Chain mode: the indexer's, once loaded.
  const rows = useMemo(() => onChain ?? (isDemo ? holderList(coin) : []), [onChain, coin]);
  if (!rows.length) return <p className="px-3 py-6 text-center text-[13px] text-muted">{isDemo ? "No holders yet." : "Loading holders…"}</p>;
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
          <th className="px-3 py-2 font-semibold">#</th>
          <th className="py-2 font-semibold">Holder</th>
          <th className="py-2 font-semibold">% supply</th>
          <th className="py-2 text-right font-semibold">Amount</th>
          <th className="py-2 text-right font-semibold">Value</th>
          <th className="px-3 py-2 text-right font-semibold">PnL</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h, i) => (
          <tr key={h.address} className="row-hover border-b border-line-soft">
            <td className="num px-3 py-2 text-muted">{i + 1}</td>
            <td className="py-2">
              <a href={explorer("account", h.address)} target="_blank" rel="noreferrer" className="font-mono text-[12px] hover:text-gold">
                {shortAddr(h.address, 5)}
              </a>
              {h.label && <span className="ml-2 rounded bg-surface-3 px-1.5 py-0.5 text-[10.5px] font-semibold text-rosebronze">{h.label}</span>}
            </td>
            <td className="py-2">
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[#2A211B]">
                  <div className="h-full rounded-full bg-copper" style={{ width: `${Math.min(100, h.pct * 100)}%` }} />
                </div>
                <span className="num">{(h.pct * 100).toFixed(2)}%</span>
              </div>
            </td>
            <td className="num py-2 text-right">{compact(h.tokens)}</td>
            <td className="num py-2 text-right">{usdCompact(h.valueUsd)}</td>
            <td className={cx("num px-3 py-2 text-right", h.label || h.pnlUsd === null ? "text-muted" : h.pnlUsd >= 0 ? "text-gold" : "text-ember")}>{h.label || h.pnlUsd === null ? "-" : usdSigned(h.pnlUsd, 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TradesTable({ coin }: { coin: Coin }) {
  const { tradesFor } = useMarket();
  const now = useNow();
  const rows = tradesFor(coin.mint).slice(0, 40);
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
          <th className="px-3 py-2 font-semibold">Age</th>
          <th className="py-2 font-semibold">Trader</th>
          <th className="py-2 font-semibold">Type</th>
          <th className="py-2 text-right font-semibold">SOL</th>
          <th className="py-2 text-right font-semibold">{coin.ticker}</th>
          <th className="py-2 text-right font-semibold">Price</th>
          <th className="px-3 py-2 text-right font-semibold">Tx</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.id} className={cx("border-b border-line-soft", t.id.startsWith("live") && "animate-flash")}>
            <td className="num px-3 py-1.5 text-muted">{age(now - t.ts)}</td>
            <td className="py-1.5 font-medium">@{t.handle}</td>
            <td className="py-1.5">
              <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-bold uppercase", t.side === "buy" ? "bg-gold/15 text-gold" : "bg-candle-down/30 text-ember")}>{t.side}</span>
            </td>
            <td className="num py-1.5 text-right">{sol(t.sol, 3).replace(" SOL", "")}</td>
            <td className="num py-1.5 text-right">{compact(t.tokens)}</td>
            <td className="num py-1.5 text-right">{price(t.priceUsd)}</td>
            <td className="px-3 py-1.5 text-right">
              <a href={explorer("tx", t.sig)} target="_blank" rel="noreferrer" className="inline-flex text-muted hover:text-gold" aria-label="View transaction">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Post a callout on this coin. Chain mode: the connected wallet signs in to the edge Worker once, which checks that it
 * holds at least 1 token and records the market cap now. Demo mode: it stays in this visit.
 */
function CalloutComposer({ coin }: { coin: Coin }) {
  const { postCallout, calloutPosting, positions } = useMarket();
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { toast } = useApp();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  if (calloutPosting === "unconfigured") return <p className="px-3 pt-3 text-xs text-muted">Posting callouts isn't set up on this deployment.</p>;
  const chars = [...text.trim()].length;
  const holds = isDemo || (positions[coin.mint]?.tokens ?? 0n) >= CALLOUT_MIN_HOLDING;
  const needWallet = !isDemo && !publicKey;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (needWallet) return setVisible(true);
    setBusy(true);
    try {
      await postCallout(coin.mint, text);
      setText("");
      toast({ tone: "good", title: "Callout posted", body: isDemo ? "Demo: it stays in this visit" : "Share its link from the callout's menu: buys through it count toward caller rewards" });
    } catch (err) {
      toast({ tone: "bad", title: "Couldn't post the callout", body: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="border-b border-line-soft py-3 max-md:px-2">
      <label htmlFor={`callout-${coin.mint}`} className="text-xs font-semibold text-muted">
        Your callout on ${coin.ticker}
      </label>
      <textarea
        id={`callout-${coin.mint}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={CALLOUT_MAX_CHARS * 2}
        placeholder={holds ? `Why $${coin.ticker}, why now?` : `Hold at least 1 $${coin.ticker} to call it out`}
        disabled={busy || (!needWallet && !holds)}
        className="mt-1.5 w-full resize-none rounded-lg border border-line bg-canvas-2 px-3 py-2 text-[14px] leading-5 text-cream placeholder:text-muted focus:border-line-accent focus:outline-none disabled:opacity-60"
      />
      <div className="mt-1.5 flex items-center gap-3">
        <span className={cx("num text-[11.5px]", chars > CALLOUT_MAX_CHARS ? "text-ember" : "text-muted")} aria-live="polite">
          {chars}/{CALLOUT_MAX_CHARS}
        </span>
        {!isDemo && !needWallet && !holds && <span className="min-w-0 truncate text-[11.5px] text-muted">Only holders can post</span>}
        <button type="submit" disabled={busy || (!needWallet && (!holds || !chars || chars > CALLOUT_MAX_CHARS))} className="btn-gold ml-auto h-9 shrink-0 px-4 text-[13px] max-md:h-11">
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {needWallet ? "Connect to post" : "Post callout"}
        </button>
      </div>
    </form>
  );
}

export function CoinCallouts({ coin }: { coin: Coin }) {
  const { callouts, traders, byMint, loadCalloutsFor } = useMarket();
  useEffect(() => loadCalloutsFor(coin.mint), [coin.mint, loadCalloutsFor]);
  const mine = callouts.filter((c) => c.mint === coin.mint);
  const list = mine.length ? mine : callouts.slice(0, 3);
  return (
    <div className="px-3 max-md:px-1">
      <CalloutComposer coin={coin} />
      {!list.length && <Empty>No callouts yet. Be the first to call ${coin.ticker}.</Empty>}
      {!mine.length && list.length > 0 && <p className="pt-3 text-xs text-muted max-md:px-3">No callouts on ${coin.ticker} yet. Recent callouts across Parabull:</p>}
      {list.map((c) => (
        <CalloutCard key={c.id} callout={c} trader={traders.find((t) => t.handle === c.handle)} coin={byMint.get(c.mint)} dense />
      ))}
    </div>
  );
}

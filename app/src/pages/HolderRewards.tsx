import { CircleDollarSign, Coins, HandCoins, Info, Users } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ParabullCoin } from "../components/brand/Wordmark";
import { cx } from "../components/ui/primitives";
import { CoinAvatar, StatTile } from "../components/ui/visuals";
import { useIsMobile } from "../hooks/useMediaQuery";
import { BPS, bpsLabel, durationLabel, splitLabel } from "../lib/protocolParams";
import { compact, pct, usdCompact } from "../lib/format";
import { SOL_USD } from "../mock/coins";
import { DEMO_WALLET, walletEpochs } from "../mock/protocol";
import { useMarket } from "../state/Market";
import { useProtocol } from "../state/Protocol";

const DAY = 86_400_000;

export function HolderRewards() {
  const { coins } = useMarket();
  const isMobile = useIsMobile();
  // The fee, split, listing target and claim window in force: from Global in chain mode, the defaults in demo mode.
  const { params, dexTargetUsd } = useProtocol();
  const target = Math.round(dexTargetUsd);
  const INTRO = `${bpsLabel(params.holderBps)} of every platform fee, once a coin's DexScreener listing fund is full, goes to $PARABULL holders. It's paid in SOL through weekly snapshot epochs you claim with a Merkle proof.`;
  const epochs = walletEpochs(DEMO_WALLET);
  const totalSol = epochs.reduce((n, e) => n + Number(e.totalLamports) / 1e9, 0);
  const usdThen = epochs.reduce((n, e) => n + (Number(e.totalLamports) / 1e9) * e.solPriceAtPublish, 0);
  const wallets = epochs.reduce((n, e) => n + e.numLeaves, 0);
  const share = params.holderBps / BPS;
  const feeRate = params.platformFeeBps / BPS;

  // Coins whose platform fees funded the most holder rewards (after their DexScreener escrow filled).
  const payers = useMemo(() => {
    const rows = coins
      .map((c) => {
        const days = Math.min(30, Math.max(1, (Date.now() - c.createdAt) / DAY));
        const feesUsd = c.vol24hUsd * days * 0.6 * feeRate;
        const toHolders = Math.max(0, feesUsd - target) * share;
        return { c, toHolders, trades: Math.round((c.buys24h + c.sells24h) * days * 0.6) };
      })
      .filter((r) => r.toHolders > 0)
      .sort((a, b) => b.toHolders - a.toHolders);
    const sum = rows.reduce((n, r) => n + r.toHolders, 0);
    return rows.slice(0, 20).map((r) => ({ ...r, share: r.toHolders / sum }));
  }, [coins, share, feeRate, target]);

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-6 max-md:px-4 max-md:py-4">
      {isMobile ? (
        <div>
          <div className="flex items-center gap-3">
            <ParabullCoin size={44} />
            <h1 className="text-[24px] font-semibold tracking-tight">Holder rewards</h1>
          </div>
          <p className="mt-2.5 text-[13.5px] leading-[21px] text-muted">{INTRO}</p>
          <Link to="/parabull-token#claim" className="btn-gold mt-4 h-12 w-full text-[15px]">
            Claim rewards
          </Link>
        </div>
      ) : (
        <div className="flex items-start gap-4">
          <ParabullCoin size={56} />
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight">Holder rewards</h1>
            <p className="mt-1 max-w-3xl text-[14px] text-muted">{INTRO}</p>
          </div>
          <Link to="/parabull-token#claim" className="btn-gold ml-auto h-10 shrink-0 px-5">
            Claim rewards
          </Link>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3 max-md:mt-5 max-md:gap-3">
        <StatTile icon={HandCoins} label="Total holder rewards distributed" value={`${compact(totalSol)} SOL`} foot={<span>{usdCompact(usdThen)} when paid · {epochs.length} epochs</span>} />
        <StatTile icon={CircleDollarSign} label="Value at today's prices" value={usdCompact(totalSol * SOL_USD)} delta={<span className={cx("num font-semibold", totalSol * SOL_USD >= usdThen ? "text-gold" : "text-ember")}>{pct(totalSol * SOL_USD / usdThen - 1)}</span>} foot={<span>vs. value when paid, at SOL ${SOL_USD.toFixed(2)}</span>} />
        <StatTile icon={Users} label="Total wallets rewarded" value={wallets.toLocaleString("en-US")} foot={<span>allocations across all epochs</span>} />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px] max-md:mt-6 max-md:gap-4">
        <section className="panel overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3 max-md:flex-wrap max-md:gap-y-1">
            <Coins className="h-4 w-4 text-copper" />
            <h2 className="text-[15px] font-semibold">Top paying coins</h2>
            <span className="ml-2 text-xs text-muted max-md:ml-0 max-md:w-full max-md:leading-[18px]">Coins whose trading fees funded the most holder rewards, last 30 days</span>
          </div>
          {isMobile ? (
            // One link per coin: its share of all holder rewards under the name, what it paid (USD, then SOL) on the right.
            <ul>
              {payers.map(({ c, toHolders, share: s }, i) => (
                <li key={c.mint}>
                  <Link to={`/coin/${c.mint}`} className="flex min-h-[60px] items-center gap-3 border-b border-line-soft px-4 py-2.5 transition-colors duration-100 ease-out active:bg-surface-2">
                    <span className="num w-5 shrink-0 text-[12.5px] text-muted">{i + 1}</span>
                    <CoinAvatar src={c.image} alt="" size={36} graduated={c.migrated} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-semibold leading-5 text-cream">{c.name}</span>
                      <span className="num block truncate text-xs text-muted">
                        ${c.ticker} · {(s * 100).toFixed(1)}% share
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="num block text-[14px] font-semibold leading-5 text-cream">{usdCompact(toHolders)}</span>
                      <span className="num block text-xs text-muted">{(toHolders / SOL_USD).toFixed(2)} SOL</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-2.5 font-semibold">#</th>
                  <th className="py-2.5 font-semibold">Coin</th>
                  <th className="py-2.5 text-right font-semibold">Paid to holders</th>
                  <th className="py-2.5 text-right font-semibold">In SOL</th>
                  <th className="py-2.5 text-right font-semibold">Share</th>
                  <th className="py-2.5 text-right font-semibold">Trades</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Quote</th>
                </tr>
              </thead>
              <tbody>
                {payers.map(({ c, toHolders, share: s, trades }, i) => (
                  <tr key={c.mint} className="row-hover border-b border-line-soft">
                    <td className="num px-4 py-2.5 text-muted">{i + 1}</td>
                    <td className="py-2.5">
                      <Link to={`/coin/${c.mint}`} className="flex items-center gap-3 hover:text-gold">
                        <CoinAvatar src={c.image} alt={c.name} size={32} graduated={c.migrated} />
                        <span>
                          <span className="block font-semibold">{c.name}</span>
                          <span className="text-xs text-muted">${c.ticker}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="num py-2.5 text-right font-semibold">{usdCompact(toHolders)}</td>
                    <td className="num py-2.5 text-right">{(toHolders / SOL_USD).toFixed(2)}</td>
                    <td className="py-2.5 text-right">
                      <span className="inline-flex items-center gap-2">
                        <span className="h-1.5 w-14 overflow-hidden rounded-full bg-[#2A211B]">
                          <span className="block h-full rounded-full bg-copper" style={{ width: `${Math.min(100, s * 100 * 3)}%` }} />
                        </span>
                        <span className="num w-12 text-right">{(s * 100).toFixed(1)}%</span>
                      </span>
                    </td>
                    <td className="num py-2.5 text-right">{trades.toLocaleString("en-US")}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span className="rounded-md bg-surface-3 px-2 py-0.5 text-[11.5px] font-semibold">SOL</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <aside className="panel h-fit p-5 max-md:p-4">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold">
            <Info className="h-4 w-4 text-copper" /> How the split works
          </h3>
          <ol className="mt-4 space-y-4 text-[13px]">
            {[
              [`${bpsLabel(params.platformFeeBps)} platform fee`, "On every bonding-curve trade. Creators pay and earn 0%."],
              [`$${target} listing fund first`, "Each coin's first fees fill its DexScreener escrow, released to the treasury to pay for the listing."],
              [
                `Then ${splitLabel(params)}`,
                `${bpsLabel(params.buybackBps)} buys back and burns $PARABULL, ${bpsLabel(params.holderBps)} goes to $PARABULL holders, ${bpsLabel(BPS - params.buybackBps - params.holderBps)} to the treasury.`,
              ],
              [
                "Weekly epochs",
                `A snapshot of $PARABULL balances becomes a Merkle root on-chain. The crank pushes payouts, or you claim yourself, within ${durationLabel(params.rewardClaimWindowSeconds)}; unclaimed rewards then fund later epochs.`,
              ],
            ].map(([t, b], i) => (
              <li key={t} className="flex gap-3">
                <span className="metal-copper flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-canvas">{i + 1}</span>
                <span>
                  <span className="block font-semibold">{t}</span>
                  <span className="text-muted">{b}</span>
                </span>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}

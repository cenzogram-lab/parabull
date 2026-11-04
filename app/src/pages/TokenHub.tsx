import { PublicKey } from "@solana/web3.js";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ArrowRight, Calculator, CheckCircle2, Clock, Flame, Gift, Loader2, PieChart, Share2, ShieldCheck, TrendingUp, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { BullMark } from "../components/brand/BullMark";
import { ParabullCoin } from "../components/brand/Wordmark";
import { cx } from "../components/ui/primitives";
import { StatTile } from "../components/ui/visuals";
import { CONFIG, explorer, isDemo } from "../config";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useParabullProgram } from "../hooks/useParabullProgram";
import { compact, countdown, sol, usd, usdCompact } from "../lib/format";
import { leafHash, verifyProof } from "../lib/merkle";
import { PROTOCOL } from "../lib/protocol";
import { fromHex } from "../lib/sha256";
import { SOL_USD } from "../mock/coins";
import { buybackLedger, DEMO_WALLET, PARABULL_PRICE, PARABULL_SUPPLY, walletEpochs, type DemoEpoch } from "../mock/protocol";
import { useApp } from "../state/AppState";

function ClaimPanel() {
  const client = useParabullProgram();
  const { setVisible } = useWalletModal();
  const { toast, sfx } = useApp();
  const isMobile = useIsMobile();
  const me = client.publicKey ?? DEMO_WALLET;
  const epochs = useMemo(() => [...walletEpochs(me)].reverse(), [me.toBase58()]); // eslint-disable-line react-hooks/exhaustive-deps
  const [claimed, setClaimed] = useState<Set<number>>(() => new Set([4, 5]));
  const [busy, setBusy] = useState<number | null>(null);
  const now = Date.now();

  const verified = (e: DemoEpoch) => !!e.you && verifyProof(e.you.proof.map(fromHex), fromHex(e.root), leafHash(e.you.index, me.toBytes(), BigInt(e.you.amount)));
  const claimable = epochs.filter((e) => e.you && !e.expired && !claimed.has(e.epoch));
  const pending = claimable.reduce((n, e) => n + Number(e.you!.amount) / 1e9, 0);

  async function claim(e: DemoEpoch) {
    if (!e.you) return;
    if (!isDemo && !client.connected) return setVisible(true);
    setBusy(e.epoch);
    try {
      if (isDemo) {
        await new Promise((r) => setTimeout(r, 700));
      } else {
        if (!CONFIG.rewardsBaseUrl) throw new Error("No snapshot host configured (VITE_REWARDS_BASE_URL)");
        const art = (await (await fetch(`${CONFIG.rewardsBaseUrl}/epoch-${e.epoch}.json`)).json()) as { root: string; leaves: { index: number; claimant: string; amount: string; proof: string[] }[] };
        const leaf = art.leaves.find((l) => l.claimant === me.toBase58());
        if (!leaf) throw new Error("No allocation for this wallet in the published snapshot");
        const proof = leaf.proof.map(fromHex);
        if (!verifyProof(proof, fromHex(art.root), leafHash(leaf.index, new PublicKey(leaf.claimant).toBytes(), BigInt(leaf.amount)))) throw new Error("Proof does not match the published root");
        const sig = await client.claimHolderReward(e.epoch, leaf.index, BigInt(leaf.amount), proof);
        toast({ tone: "info", title: "Claim sent", body: explorer("tx", sig) });
      }
      setClaimed((s) => new Set(s).add(e.epoch));
      sfx("buy");
      toast({ tone: "good", title: `Claimed ${sol(BigInt(e.you.amount), 4)}`, body: `Epoch ${e.epoch}${isDemo ? " · demo claim, nothing sent on-chain" : ""}` });
    } catch (err) {
      toast({ tone: "bad", title: "Claim failed", body: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const note = `${client.publicKey ? "Your wallet's allocations" : isDemo ? "Demo wallet allocations (connect to see your own)" : "Connect a wallet to see your allocations"} · each proof is verified in your browser against the on-chain root before you claim`;

  if (isMobile)
    return (
      <section id="claim" className="panel overflow-hidden">
        <div className="brushed-dark border-b border-line px-4 py-3.5">
          <div className="flex items-center gap-3">
            <Gift className="h-5 w-5 shrink-0 text-gold" aria-hidden />
            <h2 className="min-w-0 flex-1 text-[16px] font-semibold leading-6">Claim holder rewards</h2>
            <div className="shrink-0 text-right">
              <div className="text-[11px] leading-4 text-muted">Unclaimed</div>
              <div className="num text-[17px] font-semibold leading-6 text-gold">{sol(pending, 3)}</div>
            </div>
          </div>
          <p className="mt-2 text-xs leading-[18px] text-muted">{note}</p>
        </div>
        {/* One row per epoch instead of the seven-column table: allocation and proof on the left, Claim on the right. */}
        <ul>
          {epochs.slice(0, 8).map((e) => {
            const ok = verified(e);
            const done = claimed.has(e.epoch);
            return (
              <li key={e.epoch} className="flex items-center gap-3 border-b border-line-soft px-4 py-3 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="num text-[14px] font-semibold text-cream">Epoch #{e.epoch}</span>
                    <span className="num inline-flex min-w-0 items-center gap-1 truncate text-[11.5px] text-muted">
                      {e.expired ? (
                        "Expired"
                      ) : (
                        <>
                          <Clock className="h-3 w-3 shrink-0" aria-hidden /> {countdown(e.expiresAt - now)} left
                        </>
                      )}
                    </span>
                  </div>
                  <div className="num mt-0.5 truncate text-[13px] text-muted">
                    {e.you ? (
                      <>
                        <span className="font-semibold text-cream">{sol(BigInt(e.you.amount), 4)}</span> of {sol(BigInt(e.totalLamports), 1)}
                      </>
                    ) : (
                      `Not in snapshot · ${sol(BigInt(e.totalLamports), 1)} epoch`
                    )}
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px]">
                    {e.you &&
                      (ok ? (
                        <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-gold">
                          <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Verified ({e.you.proof.length} hashes)
                        </span>
                      ) : (
                        <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-ember">
                          <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> Invalid
                        </span>
                      ))}
                    <span className="min-w-0 truncate font-mono text-muted">
                      {e.you ? "· " : ""}root {e.root.slice(0, 6)}…
                    </span>
                  </div>
                </div>
                {e.you && !e.expired && (
                  <button disabled={done || busy !== null || !ok} onClick={() => claim(e)} className={cx("h-11 shrink-0 rounded-xl px-4 text-[13.5px]", done ? "btn-ghost" : "btn-gold")}>
                    {busy === e.epoch ? <Loader2 className="h-4 w-4 animate-spin" /> : done ? <CheckCircle2 className="h-4 w-4 text-gold" /> : null}
                    {done ? "Claimed" : "Claim"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    );

  return (
    <section id="claim" className="panel overflow-hidden">
      <div className="brushed-dark flex flex-wrap items-center gap-4 border-b border-line px-5 py-4">
        <Gift className="h-5 w-5 text-gold" />
        <div>
          <h2 className="text-[16px] font-semibold">Claim holder rewards</h2>
          <p className="text-xs text-muted">{note}</p>
        </div>
        <div className="ml-auto text-right">
          <div className="text-xs text-muted">Unclaimed</div>
          <div className="text-xl font-semibold text-gold">{sol(pending, 3)}</div>
        </div>
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-wider text-muted">
            <th className="px-5 py-2.5 font-semibold">Epoch</th>
            <th className="py-2.5 font-semibold">Root</th>
            <th className="py-2.5 text-right font-semibold">Epoch total</th>
            <th className="py-2.5 text-right font-semibold">Your allocation</th>
            <th className="py-2.5 pl-8 font-semibold">Proof</th>
            <th className="py-2.5 font-semibold">Window</th>
            <th className="px-5 py-2.5 text-right font-semibold" />
          </tr>
        </thead>
        <tbody>
          {epochs.slice(0, 8).map((e) => {
            const ok = verified(e);
            const done = claimed.has(e.epoch);
            return (
              <tr key={e.epoch} className="border-b border-line-soft">
                <td className="num px-5 py-3 font-semibold">#{e.epoch}</td>
                <td className="py-3 font-mono text-[12px] text-muted">{e.root.slice(0, 10)}…</td>
                <td className="num py-3 text-right">{sol(BigInt(e.totalLamports), 1)}</td>
                <td className="num py-3 text-right font-semibold">{e.you ? sol(BigInt(e.you.amount), 4) : <span className="text-muted">-</span>}</td>
                <td className="py-3 pl-8">
                  {e.you ? (
                    ok ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-gold">
                        <ShieldCheck className="h-3.5 w-3.5" /> Verified ({e.you.proof.length} hashes)
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-ember">
                        <TriangleAlert className="h-3.5 w-3.5" /> Invalid
                      </span>
                    )
                  ) : (
                    <span className="text-xs text-muted">Not in snapshot</span>
                  )}
                </td>
                <td className="py-3 text-xs text-muted">
                  {e.expired ? (
                    "Expired"
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {countdown(e.expiresAt - now)}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 text-right">
                  {e.you && !e.expired && (
                    <button disabled={done || busy !== null || !ok} onClick={() => claim(e)} className={cx("h-8 px-3 text-xs", done ? "btn-ghost" : "btn-gold")}>
                      {busy === e.epoch ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : done ? <CheckCircle2 className="h-3.5 w-3.5 text-gold" /> : null}
                      {done ? "Claimed" : "Claim"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function ValuationCalculator() {
  const [volume, setVolume] = useState(4_500_000);
  const [multiple, setMultiple] = useState(20);
  const feeRate = Number(PROTOCOL.platformFeeBps) / 10_000;
  const fees = volume * feeRate * 365;
  const buyback = fees * (PROTOCOL.buybackBps / 10_000);
  const holders = fees * (PROTOCOL.holderBps / 10_000);
  const valuation = (buyback + holders) * multiple;
  const implied = valuation / PARABULL_SUPPLY;
  return (
    <section className="panel p-5 max-md:p-4">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold">
        <Calculator className="h-4 w-4 text-copper" /> Earnings to valuation
      </h2>
      <p className="mt-1 text-xs text-muted">What daily platform volume implies for $PARABULL at a chosen earnings multiple. Illustrative only.</p>
      <label className="mt-4 block">
        <span className="flex justify-between text-[13px]">
          <span className="text-muted">Daily platform volume</span>
          <span className="num font-semibold">{usdCompact(volume)}</span>
        </span>
        <input type="range" min={250_000} max={50_000_000} step={250_000} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="mt-2 w-full accent-[#E5A967] max-md:mt-0 max-md:h-11" />
      </label>
      <label className="mt-3 block">
        <span className="flex justify-between text-[13px]">
          <span className="text-muted">Earnings multiple</span>
          <span className="num font-semibold">{multiple}x</span>
        </span>
        <input type="range" min={2} max={60} value={multiple} onChange={(e) => setMultiple(Number(e.target.value))} className="mt-2 w-full accent-[#E5A967] max-md:mt-0 max-md:h-11" />
      </label>
      <dl className="mt-4 space-y-1.5 text-[13px]">
        {[
          ["Annual platform fees (1%)", usdCompact(fees)],
          ["Bought back & burned (50%)", usdCompact(buyback)],
          ["Paid to holders (40%)", usdCompact(holders)],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between">
            <dt className="text-muted">{k}</dt>
            <dd className="num">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 rounded-xl border border-line-accent/60 bg-canvas-2 p-4">
        <div className="text-xs text-muted">Implied valuation</div>
        <div className="text-[26px] font-semibold">{usdCompact(valuation)}</div>
        <div className="mt-1 flex items-center justify-between text-xs">
          <span className="text-muted">Implied price</span>
          <span className="num font-semibold">
            ${implied.toFixed(4)} <span className={implied >= PARABULL_PRICE ? "text-gold" : "text-ember"}>({((implied / PARABULL_PRICE - 1) * 100).toFixed(0)}% vs now)</span>
          </span>
        </div>
      </div>
    </section>
  );
}

export function TokenHub() {
  const client = useParabullProgram();
  const { toast } = useApp();
  const isMobile = useIsMobile();
  const { hash, key } = useLocation();
  const [parabullMint, setParabullMint] = useState<string | null>(null);
  const [allDays, setAllDays] = useState(false);
  // Router navigation doesn't scroll to a hash, so do it for links to #claim (Holder rewards, notifications), clear of the sticky header.
  useEffect(() => {
    if (hash !== "#claim") return;
    const id = requestAnimationFrame(() => {
      const el = document.getElementById("claim");
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 72 });
    });
    return () => cancelAnimationFrame(id);
  }, [hash, key]);
  useEffect(() => {
    if (isDemo) return;
    client
      .fetchGlobal()
      .then((g) => g && setParabullMint(g.parabullMint.toBase58()))
      .catch(() => undefined);
  }, [client]);
  const ledger = useMemo(() => buybackLedger(), []);
  const totalUsd = ledger.reduce((n, d) => n + d.usd, 0);
  const totalBurned = ledger.reduce((n, d) => n + d.burned, 0);
  const totalSol = ledger.reduce((n, d) => n + d.solSpent, 0);
  // Phones show the last week of the ledger, with the full 30 days a tap away.
  const days = [...ledger].reverse().slice(0, isMobile && !allDays ? 7 : undefined);
  const share = async () => {
    const url = window.location.origin + window.location.pathname;
    try {
      if (navigator.share) return await navigator.share({ title: "$PARABULL", text: "$PARABULL turns every trade into buy pressure", url });
      await navigator.clipboard.writeText(url);
      toast({ tone: "good", title: "Link copied", body: url });
    } catch (e) {
      // Closing the share sheet rejects with AbortError: nothing to report.
      if ((e as Error).name !== "AbortError") toast({ tone: "info", title: "Share this page", body: url });
    }
  };
  return (
    <div>
      <section className="relative overflow-hidden border-b border-line">
        <div className="brushed-dark absolute inset-0" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_30%,rgba(200,125,85,0.28),transparent_60%)]" />
        <div className="pointer-events-none absolute -left-24 top-6 opacity-[0.07]">
          <BullMark size={420} ring={false} title="" />
        </div>
        <div className="pointer-events-none absolute -right-24 top-6 -scale-x-100 opacity-[0.07]">
          <BullMark size={420} ring={false} title="" />
        </div>
        <div className="relative mx-auto flex max-w-4xl flex-col items-center px-8 py-16 text-center max-md:px-4 max-md:pb-10 max-md:pt-9">
          <div className="rounded-full p-2 shadow-glow">
            <ParabullCoin size={isMobile ? 88 : 112} />
          </div>
          <h1 className="mt-8 text-[52px] font-semibold leading-[1.08] tracking-tight max-md:mt-6 max-md:text-[34px] max-md:leading-[1.12]">
            <span className="metal-text">$PARABULL</span> turns every trade into buy pressure
          </h1>
          <p className="mt-5 max-w-2xl text-[17px] leading-7 text-muted max-md:mt-4 max-md:text-[15px] max-md:leading-6">
            The native token of the Parabull launchpad. Half of every platform fee buys $PARABULL on the open market and burns it, and 40% is paid to holders in SOL.
          </p>
          <div className="mt-8 flex gap-3 max-md:mt-6 max-md:w-full">
            <a href={parabullMint ? `https://raydium.io/swap/?inputMint=sol&outputMint=${parabullMint}` : "https://raydium.io/swap/"} target="_blank" rel="noreferrer" className="btn-gold h-12 px-7 text-[15px] max-md:flex-1 max-md:px-4">
              Trade $PARABULL <ArrowRight className="h-4 w-4" />
            </a>
            <button onClick={share} className="btn-ghost h-12 px-6 text-[15px] max-md:px-5">
              Share <Share2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-[1400px] space-y-8 px-8 py-10 max-md:space-y-6 max-md:px-4 max-md:py-6">
        <div>
          <h2 className="text-[24px] font-semibold max-md:text-[20px] max-md:leading-7">Every buyback, burned forever</h2>
          <p className="mt-1 text-[14px] text-muted max-md:text-[13.5px]">Half of every platform fee, after each coin's $299 listing fund, buys $PARABULL from the Raydium pool and burns it in the same transaction.</p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3 max-md:gap-3">
          <StatTile icon={TrendingUp} label="Total USD deployed" value={usdCompact(totalUsd)} foot={<span>{compact(totalSol)} SOL spent · last 30 days</span>} hero />
          <StatTile icon={Flame} label="Total $PARABULL burned" value={compact(totalBurned)} foot={<span>sent to the burn instruction, not a dead wallet</span>} />
          <StatTile icon={PieChart} label="Total supply offset" value={`${((totalBurned / PARABULL_SUPPLY) * 100).toFixed(2)}%`} foot={<span>of 1B $PARABULL</span>} />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px] max-md:gap-4">
          <section className="panel overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-5 py-3 max-md:px-4">
              <Flame className="h-4 w-4 text-copper" />
              <h3 className="text-[15px] font-semibold">Daily buyback & burn</h3>
              <span className="ml-auto text-xs text-muted">{isDemo ? "Demo ledger" : "From BuybackBurned events"}</span>
            </div>
            {/* Below md the page scrolls instead of a nested 440px scroller, and the columns get short labels to fit 390px. */}
            <div className="max-h-[440px] overflow-y-auto max-md:max-h-none max-md:overflow-visible">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-surface max-md:static">
                  <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-wider text-muted max-md:tracking-wide">
                    <th className="px-5 py-2.5 font-semibold max-md:px-4">Date</th>
                    <th className="py-2.5 text-right font-semibold">{isMobile ? "Burned" : "$PARABULL burned"}</th>
                    <th className="py-2.5 text-right font-semibold">{isMobile ? "SOL" : "SOL spent"}</th>
                    <th className="px-5 py-2.5 text-right font-semibold max-md:px-4">{isMobile ? "USD" : "USD value"}</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.date} className="row-hover border-b border-line-soft">
                      <td className="px-5 py-2.5 max-md:whitespace-nowrap max-md:px-4">{new Date(d.date).toLocaleDateString("en-US", isMobile ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" })}</td>
                      <td className="num py-2.5 text-right font-semibold">{Math.round(d.burned).toLocaleString("en-US")}</td>
                      <td className="num py-2.5 text-right">{d.solSpent.toFixed(2)}</td>
                      <td className="num px-5 py-2.5 text-right max-md:px-4">{usd(d.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {isMobile && (
              <button type="button" onClick={() => setAllDays((a) => !a)} aria-expanded={allDays} className="h-11 w-full text-[13px] font-semibold text-gold transition-opacity duration-100 ease-out active:opacity-70">
                {allDays ? "Show the last 7 days" : `Show all ${ledger.length} days`}
              </button>
            )}
          </section>
          <ValuationCalculator />
        </div>

        <ClaimPanel />
        <p className="text-center text-xs text-muted">SOL ${SOL_USD.toFixed(2)} · $PARABULL ${PARABULL_PRICE}</p>
      </div>
    </div>
  );
}

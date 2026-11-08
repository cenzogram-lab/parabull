import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ArrowRight, Calculator, CheckCircle2, Clock, Flame, Gift, Loader2, PieChart, Share2, ShieldCheck, TrendingUp, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { BullMark } from "../components/brand/BullMark";
import { ParabullCoin } from "../components/brand/Wordmark";
import { cx } from "../components/ui/primitives";
import { StatTile } from "../components/ui/visuals";
import { explorer, isDemo } from "../config";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useParabullProgram } from "../hooks/useParabullProgram";
import { useWalletRewards } from "../hooks/useRewards";
import { compact, countdown, sol, usd, usdCompact } from "../lib/format";
import { leafHash, verifyProof } from "../lib/merkle";
import { BPS, bpsLabel } from "../lib/protocolParams";
import { checkBeforeClaim, claimRows, hexToBytes, proofMatches, type RewardKind } from "../lib/rewardsClaim";
import { fromHex } from "../lib/sha256";
import { buybackLedger, DEMO_WALLET, PARABULL_PRICE, PARABULL_SUPPLY, walletEpochs } from "../mock/protocol";
import { useApp } from "../state/AppState";
import { useProtocol } from "../state/Protocol";

type LedgerSource = "demo" | "events";
const LEDGER_CAPTION: Record<LedgerSource, string> = { demo: "Simulated burn history · demo data", events: "From BuybackBurned events" };

/** "Half" for the default 50% buyback share, else the percentage. */
const shareOfFee = (bps: number) => (bps === BPS / 2 ? "Half" : bpsLabel(bps));

/** One claimable allocation as both layouts show it. */
interface ClaimRow {
  epoch: number;
  kind: RewardKind | null;
  root: string;
  totalLamports: bigint;
  amount: bigint | null;
  /** The proof checked in the browser (against the root shown); null: not in this epoch. */
  proof: { ok: boolean; hashes: number } | null;
  expired: boolean;
  expiresAt: number;
  claimed: boolean;
}

function ClaimPanel() {
  return isDemo ? <DemoClaimPanel /> : <ChainClaimPanel />;
}

/** Demo mode: the simulated epochs (real Merkle trees over simulated holders); a claim sends nothing. */
function DemoClaimPanel() {
  const client = useParabullProgram();
  const { toast, sfx, claimedFor, markClaimed } = useApp();
  const me = client.publicKey ?? DEMO_WALLET;
  const claimed = claimedFor(me.toBase58());
  const epochs = useMemo(() => [...walletEpochs(me)].reverse(), [me.toBase58()]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState<number | null>(null);
  const rows: ClaimRow[] = epochs.slice(0, 8).map((e) => ({
    epoch: e.epoch,
    kind: null,
    root: e.root,
    totalLamports: BigInt(e.totalLamports),
    amount: e.you ? BigInt(e.you.amount) : null,
    proof: e.you ? { ok: verifyProof(e.you.proof.map(fromHex), fromHex(e.root), leafHash(e.you.index, me.toBytes(), BigInt(e.you.amount))), hashes: e.you.proof.length } : null,
    expired: e.expired,
    expiresAt: e.expiresAt,
    claimed: claimed.has(e.epoch),
  }));
  const pending = rows.filter((r) => r.amount !== null && r.proof?.ok && !r.expired && !r.claimed).reduce((n, r) => n + Number(r.amount) / 1e9, 0);
  async function claim(r: ClaimRow) {
    setBusy(r.epoch);
    await new Promise((res) => setTimeout(res, 700));
    markClaimed(me.toBase58(), r.epoch);
    sfx("buy");
    toast({ tone: "good", title: `Claimed ${sol(r.amount!, 4)}`, body: `Epoch ${r.epoch} · demo claim, nothing sent on-chain` });
    setBusy(null);
  }
  const note = `${client.publicKey ? "Your wallet's demo allocations" : "Demo wallet allocations (connect to see your own)"} · each proof is verified in your browser against the epoch's root`;
  return <ClaimView title="Claim holder rewards" note={note} pending={pending} rows={rows} busy={busy} onClaim={claim} demo />;
}

/**
 * Chain mode: the connected wallet's allocations from the indexer (holder and caller epochs). Before a claim is sent,
 * the epoch's account is read from the chain and the proof checked against its root and bitmap (src/lib/rewardsClaim.ts).
 */
function ChainClaimPanel() {
  const client = useParabullProgram();
  const { setVisible } = useWalletModal();
  const { toast, sfx } = useApp();
  const wallet = client.publicKey;
  const rewards = useWalletRewards(wallet?.toBase58() ?? null);
  const [busy, setBusy] = useState<number | null>(null);
  const allocations = rewards.data?.allocations ?? [];
  const bytes = wallet?.toBytes();
  // What can still be claimed comes first and is never cut off; then the newest of the rest, up to 12 rows in all.
  const rows: ClaimRow[] = claimRows(allocations).map((a) => ({
    epoch: a.epoch,
    kind: a.kind,
    root: a.root,
    totalLamports: BigInt(a.totalLamports),
    amount: BigInt(a.amount),
    proof: a.proof && bytes ? { ok: proofMatches(a, bytes), hashes: a.proof.length } : null,
    expired: a.expired,
    expiresAt: a.expiresAt * 1000,
    claimed: a.claimed,
  }));
  const pending = Number(BigInt(rewards.data?.unclaimedLamports ?? "0")) / 1e9;

  async function claim(r: ClaimRow) {
    const a = allocations.find((x) => x.epoch === r.epoch);
    if (!a || !wallet) return setVisible(true);
    setBusy(r.epoch);
    try {
      const onChain = await client.program.account.rewardEpoch.fetchNullable(client.pdas.rewardEpoch(BigInt(a.epoch)));
      const problem = checkBeforeClaim(onChain, wallet.toBytes(), a);
      if (problem) throw new Error(problem);
      const sig = await client.claimHolderReward(a.epoch, a.index, BigInt(a.amount), a.proof!.map(hexToBytes));
      sfx("buy");
      toast({ tone: "good", title: `Claimed ${sol(BigInt(a.amount), 4)}`, body: `Epoch ${a.epoch} ${a.kind === "caller" ? "caller" : "holder"} reward · ${explorer("tx", sig)}` });
    } catch (err) {
      toast({ tone: "bad", title: "Claim failed", body: (err as Error).message });
    } finally {
      setBusy(null);
      rewards.refresh();
    }
  }

  const unverified = rewards.data?.unverifiedEpochs.length ?? 0;
  const note = !rewards.available
    ? "Rewards are read from the indexer, which isn't configured here (VITE_INDEXER_URL)"
    : !wallet
      ? "Connect a wallet to see your allocations"
      : rewards.error
        ? `The indexer didn't answer: ${rewards.error}`
        : `Your wallet's allocations · each proof is checked in your browser against the epoch's on-chain root before you claim${unverified ? ` · ${unverified} ${unverified === 1 ? "epoch is" : "epochs are"} still being verified` : ""}`;
  return (
    <ClaimView
      title="Claim rewards"
      note={note}
      pending={pending}
      rows={rows}
      busy={busy}
      onClaim={claim}
      empty={!wallet ? (
        <button type="button" onClick={() => setVisible(true)} className="btn-gold h-10 px-5">
          Connect wallet
        </button>
      ) : rewards.loading ? (
        <Loader2 className="h-5 w-5 animate-spin text-copper" aria-label="Loading allocations" />
      ) : (
        "No reward allocations for this wallet yet."
      )}
    />
  );
}

function KindTag({ kind }: { kind: RewardKind | null }) {
  if (kind !== "caller") return null;
  return <span className="rounded border border-line px-1 text-[10px] font-semibold uppercase leading-4 tracking-wide text-copper">Caller</span>;
}

function ClaimView({ title, note, pending, rows, busy, onClaim, empty, demo = false }: { title: string; note: string; pending: number; rows: ClaimRow[]; busy: number | null; onClaim: (r: ClaimRow) => void; empty?: ReactNode; demo?: boolean }) {
  const isMobile = useIsMobile();
  const now = Date.now();
  const canClaim = (r: ClaimRow) => r.amount !== null && !r.expired && !r.claimed && !!r.proof?.ok;
  const button = (r: ClaimRow, mobile: boolean) =>
    r.amount !== null &&
    !r.expired && (
      <button disabled={r.claimed || busy !== null || !canClaim(r)} onClick={() => onClaim(r)} className={cx(mobile ? "h-11 shrink-0 rounded-xl px-4 text-[13.5px]" : "h-8 px-3 text-xs", r.claimed ? "btn-ghost" : "btn-gold")}>
        {busy === r.epoch ? <Loader2 className={mobile ? "h-4 w-4 animate-spin" : "h-3.5 w-3.5 animate-spin"} /> : r.claimed ? <CheckCircle2 className={cx(mobile ? "h-4 w-4" : "h-3.5 w-3.5", "text-gold")} /> : null}
        {r.claimed ? "Claimed" : "Claim"}
      </button>
    );
  const proofBadge = (r: ClaimRow, small: boolean) =>
    r.proof === null ? null : r.proof.ok ? (
      <span className={cx("inline-flex items-center gap-1 font-semibold text-gold", small ? "shrink-0" : "text-xs")}>
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Verified ({r.proof.hashes} hashes)
      </span>
    ) : (
      <span className={cx("inline-flex items-center gap-1 font-semibold text-ember", small ? "shrink-0" : "text-xs")}>
        <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> Invalid
      </span>
    );
  const pendingTag = demo && <span className="ml-1.5 rounded border border-line px-1 align-middle text-[9px] font-bold uppercase leading-[13px] tracking-wide text-rosebronze">Demo</span>;
  const emptyState = !rows.length && empty && <div className="flex justify-center px-4 py-8 text-center text-[13px] text-muted">{empty}</div>;

  if (isMobile)
    return (
      <section id="claim" className="panel overflow-hidden">
        <div className="brushed-dark border-b border-line px-4 py-3.5">
          <div className="flex items-center gap-3">
            <Gift className="h-5 w-5 shrink-0 text-gold" aria-hidden />
            <h2 className="min-w-0 flex-1 text-[16px] font-semibold leading-6">{title}</h2>
            <div className="shrink-0 text-right">
              <div className="text-[11px] leading-4 text-muted">Unclaimed{pendingTag}</div>
              <div className="num text-[17px] font-semibold leading-6 text-gold">{sol(pending, 3)}</div>
            </div>
          </div>
          <p className="mt-2 text-xs leading-[18px] text-muted">{note}</p>
        </div>
        {emptyState}
        {/* One row per epoch instead of the seven-column table: allocation and proof on the left, Claim on the right. */}
        <ul>
          {rows.map((r) => (
            <li key={r.epoch} className="flex items-center gap-3 border-b border-line-soft px-4 py-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="num text-[14px] font-semibold text-cream">Epoch #{r.epoch}</span>
                  <KindTag kind={r.kind} />
                  <span className="num inline-flex min-w-0 items-center gap-1 truncate text-[11.5px] text-muted">
                    {r.expired ? (
                      "Expired"
                    ) : (
                      <>
                        <Clock className="h-3 w-3 shrink-0" aria-hidden /> {countdown(r.expiresAt - now)} left
                      </>
                    )}
                  </span>
                </div>
                <div className="num mt-0.5 truncate text-[13px] text-muted">
                  {r.amount !== null ? (
                    <>
                      <span className="font-semibold text-cream">{sol(r.amount, 4)}</span> of {sol(r.totalLamports, 1)}
                    </>
                  ) : (
                    `Not in snapshot · ${sol(r.totalLamports, 1)} epoch`
                  )}
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px]">
                  {proofBadge(r, true)}
                  <span className="min-w-0 truncate font-mono text-muted">
                    {r.proof ? "· " : ""}root {r.root.slice(0, 6)}…
                  </span>
                </div>
              </div>
              {button(r, true)}
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <section id="claim" className="panel overflow-hidden">
      <div className="brushed-dark flex flex-wrap items-center gap-4 border-b border-line px-5 py-4">
        <Gift className="h-5 w-5 text-gold" />
        <div>
          <h2 className="text-[16px] font-semibold">{title}</h2>
          <p className="text-xs text-muted">{note}</p>
        </div>
        <div className="ml-auto text-right">
          <div className="text-xs text-muted">Unclaimed{pendingTag}</div>
          <div className="text-xl font-semibold text-gold">{sol(pending, 3)}</div>
        </div>
      </div>
      {emptyState}
      {rows.length > 0 && (
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
            {rows.map((r) => (
              <tr key={r.epoch} className="border-b border-line-soft">
                <td className="num px-5 py-3 font-semibold">
                  <span className="inline-flex items-center gap-1.5">
                    #{r.epoch} <KindTag kind={r.kind} />
                  </span>
                </td>
                <td className="py-3 font-mono text-[12px] text-muted">{r.root.slice(0, 10)}…</td>
                <td className="num py-3 text-right">{sol(r.totalLamports, 1)}</td>
                <td className="num py-3 text-right font-semibold">{r.amount !== null ? sol(r.amount, 4) : <span className="text-muted">-</span>}</td>
                <td className="py-3 pl-8">{proofBadge(r, false) ?? <span className="text-xs text-muted">Not in snapshot</span>}</td>
                <td className="py-3 text-xs text-muted">
                  {r.expired ? (
                    "Expired"
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {countdown(r.expiresAt - now)}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 text-right">{button(r, false)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ValuationCalculator() {
  const [volume, setVolume] = useState(4_500_000);
  const [multiple, setMultiple] = useState(20);
  const { params } = useProtocol();
  const feeRate = params.platformFeeBps / BPS;
  const fees = volume * feeRate * 365;
  const buyback = fees * (params.buybackBps / BPS);
  const holders = fees * (params.holderBps / BPS);
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
          [`Annual platform fees (${bpsLabel(params.platformFeeBps)})`, usdCompact(fees)],
          [`Bought back & burned (${bpsLabel(params.buybackBps)})`, usdCompact(buyback)],
          [`Paid to holders (${bpsLabel(params.holderBps)})`, usdCompact(holders)],
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
  const { toast } = useApp();
  const isMobile = useIsMobile();
  const { hash, key } = useLocation();
  // Chain mode: the $PARABULL mint and the fee split come from Global (state/Protocol.tsx).
  const { global, params, dexTargetUsd, solUsd } = useProtocol();
  const parabullMint = global?.parabullMint ?? null;
  const [allDays, setAllDays] = useState(false);
  // Router navigation doesn't scroll to a hash, so on a phone do it for links to #claim (Holder rewards, notifications,
  // Portfolio), clear of the sticky header. Desktop keeps the behavior it had.
  useEffect(() => {
    if (!isMobile || hash !== "#claim") return;
    const id = requestAnimationFrame(() => {
      const el = document.getElementById("claim");
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 72 });
    });
    return () => cancelAnimationFrame(id);
  }, [hash, key, isMobile]);
  const ledger = useMemo(() => buybackLedger(), []);
  // The ledger is seeded in every mode: nothing reads BuybackBurned events yet. Set "events" only once it's built from them.
  const ledgerSource: LedgerSource = "demo";
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
            {`The native token of the Parabull launchpad. ${shareOfFee(params.buybackBps)} of every platform fee buys $PARABULL on the open market and burns it, and ${bpsLabel(params.holderBps)} is paid to holders in SOL.`}
          </p>
          <div className="mt-8 flex gap-3 max-md:mt-6 max-md:w-full">
            <a href={parabullMint ? `https://raydium.io/swap/?inputMint=sol&outputMint=${parabullMint}` : "https://raydium.io/swap/"} target="_blank" rel="noreferrer" className="btn-gold h-12 px-7 text-[15px] max-md:flex-1 max-md:px-4">
              Trade $PARABULL <ArrowRight className="h-4 w-4" />
            </a>
            {/* The system share sheet where there is one (phones, most desktop browsers), otherwise the link is copied. */}
            <button type="button" onClick={share} className="btn-ghost h-12 px-6 text-[15px] max-md:px-5">
              Share <Share2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-[1400px] space-y-8 px-8 py-10 max-md:space-y-6 max-md:px-4 max-md:py-6">
        <div>
          <h2 className="text-[24px] font-semibold max-md:text-[20px] max-md:leading-7">Every buyback, burned forever</h2>
          <p className="mt-1 text-[14px] text-muted max-md:text-[13.5px]">{`${shareOfFee(params.buybackBps)} of every platform fee, after each coin's $${Math.round(dexTargetUsd)} listing fund, buys $PARABULL from the Raydium pool and burns it in the same transaction.`}</p>
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
              <span className="ml-auto text-xs text-muted">{LEDGER_CAPTION[ledgerSource]}</span>
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
        <p className="text-center text-xs text-muted">SOL ${solUsd.price.toFixed(2)} · $PARABULL ${PARABULL_PRICE}</p>
      </div>
    </div>
  );
}

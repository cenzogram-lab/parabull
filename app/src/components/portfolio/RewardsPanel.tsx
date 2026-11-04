import { ArrowRight, Clock, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { isDemo } from "../../config";
import { sol, usd } from "../../lib/format";
import { ParabullCoin } from "../brand/Wordmark";
import { cx } from "../ui/primitives";
import { EmptyNote } from "./PortfolioPanels";
import { daysLeft, shortDate, type RewardEpoch, type RewardSummary } from "./shared";

function EpochRow({ e, now }: { e: RewardEpoch; now: number }) {
  const open = !e.expired;
  return (
    <li className={cx("flex min-h-[60px] items-center gap-3 px-3 py-2.5", !open && "opacity-60")}>
      <span aria-hidden className="num flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-canvas-2 text-[12.5px] font-semibold text-cream">
        #{e.epoch}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold leading-5 text-cream">
          <span className="sr-only">Epoch {e.epoch}, </span>Published {shortDate.format(e.publishedAt)}
        </span>
        {e.verified ? (
          <span className="flex items-center gap-1 text-[11.5px] font-medium leading-4 text-gold">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">Proof verified · {e.you.proof.length} hashes</span>
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[11.5px] font-medium leading-4 text-ember">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Proof doesn't match the root
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span className="num block text-[13.5px] font-semibold leading-5 text-cream">{sol(BigInt(e.you.amount), 4)}</span>
        <span className="num flex items-center justify-end gap-1 text-[11.5px] leading-4 text-muted">
          {!open ? (
            "Expired"
          ) : e.claimed ? (
            "Claimed"
          ) : (
            <>
              <Clock className="h-3 w-3" aria-hidden />
              {daysLeft(e.expiresAt, now)}d left
            </>
          )}
        </span>
      </span>
    </li>
  );
}

/**
 * Holder rewards for the wallet: what it can still claim, and every epoch
 * with an allocation for it, each Merkle proof checked in the browser.
 * Claiming happens on the $PARABULL page.
 */
export function RewardsPanel({ summary, solUsd }: { summary: RewardSummary | undefined; solUsd: number }) {
  const [now] = useState(() => Date.now());
  if (!summary)
    return (
      <div aria-busy="true" aria-label="Loading holder rewards" className="flex flex-col gap-2.5">
        <div className="h-[178px] animate-pulse rounded-xl border border-line bg-surface" />
        <div className="h-[240px] animate-pulse rounded-xl border border-line bg-surface" />
      </div>
    );
  const unclaimed = Number(summary.unclaimedLamports) / 1e9;
  const first = summary.closesFirst;
  const left = first ? daysLeft(first.expiresAt, now) : 0;
  return (
    <div>
      <section aria-label="Unclaimed holder rewards" className="brushed-dark relative overflow-hidden rounded-xl border border-line-accent/70 p-4 shadow-panel">
        <div aria-hidden className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-gold/60 to-transparent" />
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium leading-5 text-muted">Unclaimed holder rewards</p>
            {/*
              Chain mode still builds these epochs from simulated holders (there's no indexer yet), even for a connected
              wallet: say so by the figure, as the header does. Where the two don't fit side by side (a 320px phone),
              the tag drops below the figure rather than cutting it.
            */}
            <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2">
              <span className="min-w-0 truncate text-[28px] font-semibold leading-8 tracking-tight text-gold">{sol(unclaimed, 4)}</span>
              {!isDemo && <span className="shrink-0 rounded border border-line px-1 text-[9px] font-bold uppercase leading-[13px] tracking-wide text-rosebronze">Demo</span>}
            </p>
            <p className="num mt-1 text-[12.5px] leading-[18px] text-muted">
              ≈ {usd(unclaimed * solUsd)} · {summary.openEpochs} open {summary.openEpochs === 1 ? "epoch" : "epochs"}
            </p>
          </div>
          <span aria-hidden className="shrink-0">
            <ParabullCoin size={44} />
          </span>
        </div>
        <Link to="/parabull-token#claim" className="btn-gold mt-4 h-11 w-full rounded-xl text-[14.5px]">
          {/* In chain mode the figure is demo data, so the button doesn't offer to claim it. */}
          {unclaimed > 0 && isDemo ? "Claim on the $PARABULL page" : "Open the $PARABULL page"}
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
        </Link>
        {first && (
          <p className="mt-2.5 text-center text-[11.5px] leading-4 text-muted">
            Epoch {first.epoch}'s claim window closes in {left} {left === 1 ? "day" : "days"}
          </p>
        )}
      </section>

      <h2 className="mb-1 mt-4 flex min-h-11 items-center text-[15px] font-semibold text-cream">Your epochs</h2>
      {summary.epochs.length ? (
        <ul className="panel divide-y divide-line-soft overflow-hidden">
          {summary.epochs.map((e) => (
            <EpochRow key={e.epoch} e={e} now={now} />
          ))}
        </ul>
      ) : (
        <EmptyNote>This wallet wasn't in any holder snapshot yet. Hold $PARABULL through a weekly snapshot to earn a share of the fees.</EmptyNote>
      )}
      <p className="mt-3 text-[11.5px] leading-4 text-muted">
        {isDemo ? "Demo epochs: real Merkle trees over simulated $PARABULL holders. " : "Demo epochs until the indexer API is connected. "}Each proof is checked in your browser against the epoch's root before you claim.
      </p>
    </div>
  );
}

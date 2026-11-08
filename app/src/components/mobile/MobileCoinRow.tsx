/**
 * Compact coin card for the mobile board and screener (spec 2A): one link
 * per coin, a 44px framed thumbnail, name and meta on the left, the money
 * figures right-aligned. "Detailed" rows add the lock badges, volume, the
 * bonding-curve pill and the trade count; "compact" rows keep one meta line,
 * market cap and the 24h change.
 */
import { Globe, Lock } from "lucide-react";
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { useNow } from "../../hooks/useNow";
import { age, changeWords } from "../../lib/format";
import { GRADUATION_RAISE_LAMPORTS } from "../../lib/protocol";
import type { Coin } from "../../lib/types";
import { progressOf } from "../../mock/coins";
import { XLogo } from "../brand/Wordmark";
import { ChangePill, StageBadge } from "../ui/primitives";
import { AgeLabel } from "./MobileUi";

/** The curve's graduation raise, about 85 SOL. */
const GRADUATION_SOL = Math.round(Number(GRADUATION_RAISE_LAMPORTS) / 1e9);

/** Dense-row figures with two or three significant digits: 950, 9.8K, 210K, 1.2M (never "1000K"). */
export function shortNum(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a < 999.5) return `${sign}${Math.round(a)}`;
  const [unit, suffix] = a < 999_500 ? ([1e3, "K"] as const) : a < 999_500_000 ? ([1e6, "M"] as const) : ([1e9, "B"] as const);
  const v = a / unit;
  return `${sign}${v < 9.95 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)}${suffix}`;
}

/** $210K / $1.2M / $9.8K */
export const shortUsd = (n: number) => `${n < 0 ? "-" : ""}$${shortNum(Math.abs(n))}`;

export type LockKind = "Ticker" | "Name" | "Tweet";

/** The launch locks (3 days each) still in force at `now`. */
export function activeLocks(coin: Coin, now: number): LockKind[] {
  const out: LockKind[] = [];
  if (coin.locks.ticker > now) out.push("Ticker");
  if (coin.locks.name > now) out.push("Name");
  if (coin.locks.tweet !== null && coin.locks.tweet > now) out.push("Tweet");
  return out;
}

export type RowDensity = "detailed" | "compact";

const DENSITY_KEY = "parabull:mobileRows";
/** Fallback for when storage is blocked, so the choice still lasts the visit. */
let densityMemo: RowDensity | undefined;

function loadDensity(): RowDensity {
  if (densityMemo) return densityMemo;
  try {
    return JSON.parse(localStorage.getItem(DENSITY_KEY) ?? "null") === "compact" ? "compact" : "detailed";
  } catch {
    return "detailed";
  }
}

/** The board and screener share one row-density choice, persisted per browser. */
export function useRowDensity() {
  const [density, setDensityState] = useState<RowDensity>(loadDensity);
  const setDensity = useCallback((next: RowDensity) => {
    densityMemo = next;
    setDensityState(next);
    try {
      localStorage.setItem(DENSITY_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked (private window, preview): densityMemo keeps it for this visit.
    }
  }, []);
  return [density, setDensity] as const;
}

/** Rose-bronze lock chip: the launch lock is held on-chain for 3 days. */
function LockChip({ kind }: { kind: LockKind }) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-line/30 px-[3px] text-[10px] font-semibold leading-4 text-rosebronze">
      <Lock className="h-2.5 w-2.5" strokeWidth={2.75} aria-hidden />
      {kind}
    </span>
  );
}

/** "F 19.70" (SOL raised so far) with a mini bar toward the graduation raise; graduated coins get the Raydium badge. */
function CurvePill({ coin }: { coin: Coin }) {
  if (coin.migrated)
    return (
      // 16px tall, like the "F" pill it replaces, so graduated rows match the others.
      <span className="flex leading-[14px]">
        <StageBadge stage="graduated" />
      </span>
    );
  const raised = (Number(coin.reserves.realSol) / 1e9).toFixed(2);
  const p = progressOf(coin);
  return (
    <span className="inline-flex items-center gap-1">
      <span className="num text-xs text-muted">F {raised}</span>
      <span
        role="meter"
        aria-label={`${raised} of ${GRADUATION_SOL} SOL raised`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(p * 100)}
        className="relative h-1.5 w-5 overflow-hidden rounded-full bg-[#2A211B] shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)]"
      >
        <span className="metal-copper absolute inset-y-0 left-0 rounded-full" style={{ width: `${p * 100}%` }} />
      </span>
    </span>
  );
}

const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

export function MobileCoinRow({ coin, density = "detailed" }: { coin: Coin; density?: RowDensity }) {
  const now = useNow();
  const detailed = density === "detailed";
  const locks = activeLocks(coin, now);
  const trades = coin.buys24h + coin.sells24h;
  const ago = `${age(now - coin.createdAt)} ago`;
  // The arrows and abbreviations (V, MC, F, TX) don't read aloud well, so the link spells the row out.
  const label = [
    `${coin.name} ($${coin.ticker})`,
    `market cap ${shortUsd(coin.mcapUsd)}`,
    changeWords(coin.change24h, "24 hours"),
    detailed && `volume ${shortUsd(coin.vol24hUsd)}`,
    detailed && (coin.migrated ? "graduated to Raydium" : `${(Number(coin.reserves.realSol) / 1e9).toFixed(2)} of ${GRADUATION_SOL} SOL raised`),
    detailed && `${shortNum(trades)} trades`,
    `launched ${ago}`,
    detailed && locks.length > 0 && `${list(locks.map((l) => l.toLowerCase()))} locked`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Link to={`/coin/${coin.mint}`} aria-label={label} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 transition-colors duration-100 ease-out active:bg-surface-2">
      <img src={coin.image} alt="" width={44} height={44} loading="lazy" decoding="async" className="h-11 w-11 shrink-0 rounded-[10px] border border-line-accent bg-canvas-2 object-cover" />
      {/* Each line pairs a left meta item with a right-aligned figure, so every line gets the width it needs. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-cream">{coin.name}</span>
          <span className="flex shrink-0 items-baseline gap-1.5">
            {detailed && <span className="num text-xs text-muted">V {shortUsd(coin.vol24hUsd)}</span>}
            <span className="font-mono text-sm font-bold text-gold">MC {shortUsd(coin.mcapUsd)}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Under 375px the age drops its " ago", and under 340px the social icons go, so the ticker keeps its room. */}
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted">
            <span className="min-w-0 truncate font-medium">${coin.ticker}</span>
            <span className="flex shrink-0 leading-4">
              <AgeLabel ms={now - coin.createdAt} />
            </span>
            {coin.socials.x && (
              <span aria-hidden className="shrink-0 max-[339px]:hidden">
                <XLogo className="h-3 w-3" />
              </span>
            )}
            {coin.socials.website && <Globe className="h-3 w-3 shrink-0 max-[339px]:hidden" aria-hidden />}
          </span>
          <span className="flex shrink-0 leading-4">
            <ChangePill value={coin.change24h} size="xs" soft />
          </span>
        </div>
        {detailed && (
          <div className="flex items-center gap-1.5">
            <span className="flex min-w-0 flex-1 flex-wrap gap-[3px]">
              {locks.length > 0 ? locks.map((k) => <LockChip key={k} kind={k} />) : <span className="truncate text-xs leading-4 text-muted">by @{coin.creatorHandle}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <CurvePill coin={coin} />
              <span className="num text-xs text-muted">TX {shortNum(trades)}</span>
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}

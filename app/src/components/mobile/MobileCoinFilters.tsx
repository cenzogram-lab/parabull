/**
 * Quick filters shared by the mobile board and screener: market-cap range,
 * minimum 24h volume and "verified locks only", edited in a bottom sheet.
 */
import { Lock, SlidersHorizontal } from "lucide-react";
import { useId, useState, type ChangeEvent } from "react";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { fullyLocked } from "../../lib/launchRules";
import type { Coin } from "../../lib/types";
import { cx } from "../ui/primitives";
import { BottomSheet, IconButton } from "./MobileUi";

/** Amounts are typed in thousands of USD, as on the desktop screener; "" means no bound. */
export interface CoinFilters {
  minMcap: string;
  maxMcap: string;
  minVol: string;
  lockedOnly: boolean;
}

export const NO_FILTERS: CoinFilters = { minMcap: "", maxMcap: "", minVol: "", lockedOnly: false };

const thousands = (s: string) => {
  const v = Number(s);
  return s.trim() === "" || !Number.isFinite(v) ? null : v * 1e3;
};

export const filterCount = (f: CoinFilters) => [f.minMcap, f.maxMcap, f.minVol].filter((v) => thousands(v) !== null).length + (f.lockedOnly ? 1 : 0);

/** Ticker, name and announcement tweet all still locked on-chain. */

export function passesFilters(c: Coin, f: CoinFilters, now: number): boolean {
  const [lo, hi, vol] = [thousands(f.minMcap), thousands(f.maxMcap), thousands(f.minVol)];
  if (lo !== null && c.mcapUsd < lo) return false;
  if (hi !== null && c.mcapUsd > hi) return false;
  if (vol !== null && c.vol24hUsd < vol) return false;
  return !f.lockedOnly || fullyLocked(c.locks, now);
}

/** Digits and a single decimal point. */
const cleanAmount = (s: string) => s.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");

/** Filters icon for a tab row's trailing controls, with a count badge while any filter is on. */
export function CoinFilterButton({ active, onClick }: { active: number; onClick: () => void }) {
  return (
    <IconButton label={active ? `Filters, ${active} active` : "Filters"} aria-haspopup="dialog" onClick={onClick}>
      <SlidersHorizontal className={cx("h-5 w-5", active > 0 && "text-gold")} strokeWidth={1.9} aria-hidden />
      {active > 0 && (
        <span aria-hidden className="num absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[10px] font-bold leading-none text-canvas ring-2 ring-canvas">
          {active}
        </span>
      )}
    </IconButton>
  );
}

/** "Verified locks only" as a switch row. */
function LockSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={`${id}t`}
      aria-describedby={`${id}d`}
      onClick={() => onChange(!on)}
      className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-line-soft bg-canvas-2 px-3 py-2.5 text-left transition-colors duration-100 ease-out active:bg-surface"
    >
      <span className="min-w-0 flex-1">
        <span id={`${id}t`} className="flex items-center gap-1.5 text-[14px] font-semibold leading-5 text-cream">
          <Lock className="h-3.5 w-3.5 text-rosebronze" strokeWidth={2.5} aria-hidden />
          Verified locks only
        </span>
        <span id={`${id}d`} className="mt-0.5 block text-[12.5px] leading-[18px] text-muted">
          Ticker, name and announcement tweet all locked on-chain
        </span>
      </span>
      <span aria-hidden className={cx("relative h-7 w-12 shrink-0 rounded-full border transition-colors duration-100 ease-out", on ? "border-gold bg-gold" : "border-line bg-surface-3")}>
        <span className={cx("absolute left-0.5 top-0.5 h-[22px] w-[22px] rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.55)] transition-[transform,background-color] duration-100 ease-out", on ? "translate-x-5 bg-canvas" : "bg-muted")} />
      </span>
    </button>
  );
}

/** Mounted fresh each time the sheet opens, so the draft starts from the applied filters. */
function FilterForm({ initial, matches, onApply, onReset }: { initial: CoinFilters; matches: (f: CoinFilters) => number; onApply: (f: CoinFilters) => void; onReset: () => void }) {
  const [d, setD] = useState(initial);
  const id = useId();
  // Room to scroll the buttons above the on-screen keyboard while a field is focused.
  const keyboard = useKeyboardInset();
  const field = (k: "minMcap" | "maxMcap" | "minVol") => ({
    value: d[k],
    inputMode: "decimal" as const,
    enterKeyHint: "done" as const,
    autoComplete: "off",
    onChange: (e: ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: cleanAmount(e.target.value) }),
    className: "input h-11 min-w-0 text-base",
  });
  const [lo, hi] = [thousands(d.minMcap), thousands(d.maxMcap)];
  const n = matches(d);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onApply(d);
      }}
      className="flex flex-col gap-4 pt-1"
      style={keyboard ? { paddingBottom: keyboard } : undefined}
    >
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-medium text-muted">Market cap ($K)</legend>
        <div className="flex items-center gap-2">
          <input {...field("minMcap")} placeholder="Min" aria-label="Minimum market cap, thousands of US dollars" />
          <span className="shrink-0 text-[13px] text-muted">to</span>
          <input {...field("maxMcap")} placeholder="Max" aria-label="Maximum market cap, thousands of US dollars" />
        </div>
        {lo !== null && hi !== null && lo > hi && <p className="mt-1.5 text-[12.5px] text-ember">Min is above max, so no coin can match.</p>}
      </fieldset>
      <div>
        <label htmlFor={`${id}vol`} className="mb-1.5 block text-[13px] font-medium text-muted">
          Min 24h volume ($K)
        </label>
        <input id={`${id}vol`} {...field("minVol")} placeholder="Any" />
      </div>
      <LockSwitch on={d.lockedOnly} onChange={(lockedOnly) => setD({ ...d, lockedOnly })} />
      <div className="flex flex-col gap-2 pt-1">
        <p className="text-center text-[12.5px] text-muted" aria-live="polite">
          <span className="num font-semibold text-cream">{n}</span> {n === 1 ? "coin matches" : "coins match"}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => {
              setD(NO_FILTERS);
              onReset();
            }}
            className="btn-ghost h-11 flex-1 text-[14px]"
          >
            Reset
          </button>
          <button type="submit" className="btn-gold h-11 flex-[2] text-[14px]">
            Apply
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * The quick-filter sheet. Reset clears the applied filters straight away
 * (as on desktop); Apply commits the draft and closes. `matches` counts the
 * coins a draft would leave, for the live hint above the buttons.
 */
export function MobileCoinFilterSheet({ open, onClose, value, onChange, matches }: { open: boolean; onClose: () => void; value: CoinFilters; onChange: (f: CoinFilters) => void; matches: (f: CoinFilters) => number }) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Filters">
      <FilterForm
        initial={value}
        matches={matches}
        onReset={() => onChange(NO_FILTERS)}
        onApply={(f) => {
          onChange(f);
          onClose();
        }}
      />
    </BottomSheet>
  );
}

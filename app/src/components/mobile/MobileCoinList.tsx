/** The coin list under the mobile board's and screener's tab rows, and the controls around it. */
import { LayoutList, List } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Coin } from "../../lib/types";
import { MobileCoinRow, type RowDensity } from "./MobileCoinRow";
import { IconButton } from "./MobileUi";

const memory = new Map<string, unknown>();

/**
 * useState that outlives the page for the rest of the visit, so tabs,
 * filters and sort are still as you left them after opening a coin and
 * coming back.
 */
export function useRemembered<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => (memory.has(key) ? (memory.get(key) as T) : initial));
  const set = useCallback(
    (next: T) => {
      memory.set(key, next);
      setValue(next);
    },
    [key],
  );
  return [value, set] as const;
}

/** Height of the sticky mobile header (h-14), which the pinned tab row sits under. */
const HEADER_PX = 56;

/**
 * For a list under a sticky tab row: put `ref` on an empty element right
 * above the tab row, and call `toTop` when the tab, sort or filters change.
 * If the list was scrolled past its start, it jumps back so the new list
 * begins just under the pinned tabs instead of somewhere in the middle.
 */
export function useListTop() {
  const ref = useRef<HTMLDivElement>(null);
  const toTop = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.getBoundingClientRect().bottom + window.scrollY - HEADER_PX;
    if (window.scrollY > top) window.scrollTo({ top });
  }, []);
  return [ref, toTop] as const;
}

/** Toggles between detailed and compact rows; the icon shows the current density. */
export function RowDensityButton({ density, onChange }: { density: RowDensity; onChange: (d: RowDensity) => void }) {
  const compact = density === "compact";
  const Icon = compact ? List : LayoutList;
  return (
    <IconButton label="Compact rows" aria-pressed={compact} onClick={() => onChange(compact ? "detailed" : "compact")}>
      <Icon className="h-5 w-5" strokeWidth={1.9} aria-hidden />
    </IconButton>
  );
}

/** "12 of 35 coins" while filters hide some, with a way to clear them. */
export function FilterSummary({ shown, total, onClear }: { shown: number; total: number; onClear: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4">
      <p className="min-w-0 flex-1 truncate text-[12.5px] text-muted">
        <span className="num font-semibold text-cream">{shown}</span> of {total} coins match your filters
      </p>
      <button type="button" onClick={onClear} className="h-11 shrink-0 pl-3 text-[13px] font-semibold text-gold transition-opacity duration-100 ease-out active:opacity-70">
        Clear
      </button>
    </div>
  );
}

/** True while a finger is down or the page is scrolling, and for `settleMs` after. */
function useTouchBusy(settleMs: number): boolean {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let timer = 0;
    let down = false;
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => !down && setBusy(false), settleMs);
    };
    const press = () => {
      down = true;
      window.clearTimeout(timer);
      setBusy(true);
    };
    // A finger that starts scrolling ends its pointer with pointercancel; the scroll events then keep the list busy.
    const release = () => {
      down = false;
      settle();
    };
    const scroll = () => {
      setBusy(true);
      settle();
    };
    const opts = { passive: true } as const;
    window.addEventListener("pointerdown", press, opts);
    window.addEventListener("pointerup", release, opts);
    window.addEventListener("pointercancel", release, opts);
    window.addEventListener("scroll", scroll, opts);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("scroll", scroll);
    };
  }, [settleMs]);
  return busy;
}

/**
 * The live demo keeps re-ranking the lists (Movers by 1h change, New as coins
 * launch). While you touch or scroll, rows keep their places (their figures
 * still update) so a row never slides out from under a tap; the new order
 * lands once the list is still. A new `orderKey` (tab, sort or filters
 * changed) takes the new order at once.
 */
function useSteadyOrder(coins: Coin[], orderKey: string): Coin[] {
  const busy = useTouchBusy(1200);
  const held = useRef<{ key: string; mints: string[] } | null>(null);
  if (!busy || held.current?.key !== orderKey) {
    held.current = { key: orderKey, mints: coins.map((c) => c.mint) };
    return coins;
  }
  // Coins that newly qualify wait until the list settles.
  const live = new Map(coins.map((c) => [c.mint, c]));
  return held.current.mints.flatMap((m) => live.get(m) ?? []);
}

/** The panel for the selected tab (`label`, such as "Movers coins"): the cards, or an empty state. `orderKey` names the list (see useSteadyOrder). */
export function MobileCoinList({ label, coins: ranked, orderKey, density, filtered, onClearFilters, empty }: { label: string; coins: Coin[]; orderKey: string; density: RowDensity; filtered: boolean; onClearFilters: () => void; empty: string }) {
  const coins = useSteadyOrder(ranked, orderKey);
  return (
    <section role="tabpanel" aria-label={label}>
      {coins.length ? (
        <ul className="flex flex-col gap-2 px-4 pt-3">
          {coins.map((c) => (
            <li key={c.mint}>
              <MobileCoinRow coin={c} density={density} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="mx-4 mt-3 rounded-xl border border-dashed border-line px-6 py-10 text-center">
          <p className="text-[14px] text-muted">{filtered ? "No coins match these filters." : empty}</p>
          {filtered && (
            <button type="button" onClick={onClearFilters} className="btn-ghost mt-4 h-11 px-5 text-[14px]">
              Clear filters
            </button>
          )}
        </div>
      )}
    </section>
  );
}

import type { KeyboardEvent, ReactNode } from "react";
import { cx } from "../ui/primitives";

export type SegmentOption<T extends string> = T | { value: T; label: ReactNode; ariaLabel?: string };
const valueOf = <T extends string>(o: SegmentOption<T>): T => (typeof o === "string" ? o : o.value);

/**
 * Compact pill group for picking one value (chart period, sort order): a
 * 42px track with 36px pills, each at least 44px wide, whose hit areas grow
 * to 44px tall on touch screens (`touch-target`). The selected pill takes the
 * gold-on-bronze `tab-active` look. It's a radio group: arrow keys move the
 * selection.
 */
export function Segment<T extends string>({ options, value, onChange, label, className }: { options: readonly SegmentOption<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = options.findIndex((o) => valueOf(o) === value);
    const moves: Record<string, number | undefined> = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: options.length - 1 };
    const next = moves[e.key];
    if (next === undefined || !options.length) return;
    e.preventDefault();
    const v = valueOf(options[(next + options.length) % options.length]);
    onChange(v);
    const group = e.currentTarget;
    requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-value="${CSS.escape(v)}"]`)?.focus());
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className={cx("flex shrink-0 items-center rounded-full border border-line bg-surface p-0.5", className)}>
      {options.map((o) => {
        const v = valueOf(o);
        const on = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            data-value={v}
            aria-checked={on}
            aria-label={typeof o === "string" ? undefined : o.ariaLabel}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(v)}
            className={cx(
              "touch-target flex h-9 min-w-11 items-center justify-center gap-1 whitespace-nowrap rounded-full border px-2 text-[13px] font-semibold transition-colors duration-100 ease-out",
              on ? "border-line-accent bg-surface-4 text-gold shadow-sm" : "border-transparent text-muted hover:text-cream active:text-cream",
            )}
          >
            {typeof o === "string" ? o : o.label}
          </button>
        );
      })}
    </div>
  );
}

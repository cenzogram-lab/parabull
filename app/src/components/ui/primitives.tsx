import { ArrowDown, ArrowUp, BadgeCheck, ChevronDown, Flame, GraduationCap, GripVertical, Lock, Sprout, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { dialogClass, usePresence } from "../../hooks/usePresence";
import { pct } from "../../lib/format";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Board / page panel with an optional brushed header. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("panel flex min-h-0 flex-col overflow-hidden", className)}>{children}</section>;
}

export function PanelHeader({ icon: Icon, title, actions, menu = true }: { icon: LucideIcon; title: string; actions?: ReactNode; menu?: boolean }) {
  return (
    <header className="brushed-dark flex h-11 shrink-0 items-center gap-2 border-b border-line px-2.5">
      <GripVertical className="h-4 w-4 cursor-grab text-muted/60" aria-hidden />
      <Icon className="h-4 w-4 text-copper" aria-hidden />
      <h2 className="text-[13.5px] font-semibold tracking-tight">{title}</h2>
      {menu && <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden />}
      <div className="ml-auto flex items-center gap-0.5">{actions}</div>
    </header>
  );
}

/** Segmented control (1h / 4h / 12h / 24h, Buy / Sell...). */
export function Segmented<T extends string>({ options, value, onChange, size = "sm", className, label }: { options: readonly (T | { value: T; label: ReactNode })[]; value: T; onChange: (v: T) => void; size?: "xs" | "sm"; className?: string; label?: string }) {
  return (
    <div role="tablist" aria-label={label} className={cx("inline-flex rounded-lg border border-line bg-canvas-2 p-0.5", className)}>
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        const on = v === value;
        return (
          <button
            key={v}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(v)}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-md font-semibold",
              size === "xs" ? "h-6 px-2 text-[11.5px]" : "h-7 px-2.5 text-xs",
              on ? "tab-active" : "tab",
            )}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

/** Primary category tabs: the active one is filled amber-gold. */
export function CategoryTabs<T extends string>({ options, value, onChange }: { options: readonly { value: T; label: string; icon: LucideIcon }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="inline-flex rounded-xl border border-line bg-surface p-1">
      {options.map(({ value: v, label, icon: Icon }) => (
        <button
          key={v}
          role="tab"
          aria-selected={v === value}
          onClick={() => onChange(v)}
          className={cx("inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-[13.5px] font-semibold", v === value ? "tab-active" : "tab hover:bg-surface-2")}
        >
          <Icon className="h-4 w-4" />
          {label}
        </button>
      ))}
    </div>
  );
}

/** Text tabs with a gold underline (Leaderboard, For you / Following). */
export function UnderlineTabs<T extends string>({ options, value, onChange, size = "md" }: { options: readonly T[]; value: T; onChange: (v: T) => void; size?: "md" | "lg" }) {
  return (
    <div role="tablist" className="flex gap-6 border-b border-line">
      {options.map((o) => (
        <button
          key={o}
          role="tab"
          aria-selected={o === value}
          onClick={() => onChange(o)}
          className={cx("-mb-px border-b-2 pb-2.5 font-semibold transition-colors duration-100 ease-out", size === "lg" ? "text-xl" : "text-[15px]", o === value ? "border-gold text-cream" : "border-transparent text-muted hover:text-cream")}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

/** Signed change with an arrow, so direction never relies on color alone. */
export function ChangePill({ value, size = "sm" }: { value: number; size?: "xs" | "sm" }) {
  const up = value >= 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span className={cx("num inline-flex items-center gap-0.5 rounded-md font-semibold", size === "xs" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-0.5 text-xs", up ? "bg-gold/10 text-gold" : "bg-candle-down/30 text-ember")}>
      <Icon className="h-3 w-3" strokeWidth={2.5} aria-hidden />
      {pct(Math.abs(value), 1, false)}
    </span>
  );
}

export function Delta({ value, className }: { value: number; className?: string }) {
  return <span className={cx("num font-semibold", value >= 0 ? "text-gold" : "text-ember", className)}>{pct(value)}</span>;
}

export function LockBadge({ kind, compact = false }: { kind: "Ticker" | "Name" | "Tweet"; compact?: boolean }) {
  const label = kind === "Tweet" ? "Verified Tweet" : `${kind} Lock`;
  return (
    <span title={`${label}: locked on-chain for 3 days`} className="inline-flex items-center gap-1 rounded border border-rosebronze/30 bg-rosebronze/10 px-1.5 py-[1px] text-[10.5px] font-semibold text-rosebronze">
      <Lock className="h-2.5 w-2.5" strokeWidth={2.75} aria-hidden />
      {compact ? kind : label}
    </span>
  );
}

export function StageBadge({ stage }: { stage: "new" | "live" | "soon" | "graduated" }) {
  if (stage === "graduated")
    return (
      <span className="inline-flex items-center gap-1 rounded bg-gold/15 px-1.5 py-[1px] text-[10.5px] font-bold uppercase tracking-wide text-gold">
        <GraduationCap className="h-3 w-3" aria-hidden />
        Raydium
      </span>
    );
  if (stage === "soon")
    return (
      <span className="inline-flex items-center gap-1 rounded bg-copper/15 px-1.5 py-[1px] text-[10.5px] font-bold uppercase tracking-wide text-copper">
        <Flame className="h-3 w-3" aria-hidden />
        Soon
      </span>
    );
  return null;
}

export function HotBadge() {
  return <span className="rounded border border-ember/40 bg-candle-down/25 px-1.5 text-[10.5px] font-bold uppercase leading-4 text-ember">Hot</span>;
}

export function Verified({ className }: { className?: string }) {
  return <BadgeCheck className={cx("h-3.5 w-3.5 text-gold", className)} aria-label="Verified" />;
}

export function AgeTag({ ms }: { ms: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-[12px] font-medium text-gold/90">
      <Sprout className="h-3 w-3" aria-hidden />
      {ms}
    </span>
  );
}

/** Lightweight click-outside popover. */
export function Popover({ trigger, children, align = "right", className }: { trigger: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; className?: string }) {
  const [open, setOpen] = useState(false);
  const { mounted, shown } = usePresence(open);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger(open)}</div>
      {mounted && (
        <div className={cx("panel-raised absolute top-full z-40 mt-2 p-3", align === "right" ? "right-0 origin-top-right" : "left-0 origin-top-left", dialogClass(shown), className)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-muted">{children}</div>;
}

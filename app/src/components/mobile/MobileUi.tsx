/**
 * Building blocks for the mobile views (below Tailwind's `md`): tab rows,
 * 44px icon buttons, the Follow toggle, section headers and the bottom sheet. Everything here
 * keeps touch targets at 44x44px or larger.
 */
import { Check, ChevronRight, Plus, Sprout, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { backdropClass, usePresence } from "../../hooks/usePresence";
import { age } from "../../lib/format";
import { cx } from "../ui/primitives";

/** A tab is its value, or a value with a custom label (icon + text); icon-only labels need `ariaLabel`. */
export type TabOption<T extends string> = T | { value: T; label: ReactNode; ariaLabel?: string };
const valueOf = <T extends string>(o: TabOption<T>): T => (typeof o === "string" ? o : o.value);

/** Left/Right/Home/End move the selection, as in the ARIA tabs pattern. */
function onTabKeys<T extends string>(e: KeyboardEvent<HTMLElement>, options: readonly TabOption<T>[], value: T, onChange: (v: T) => void) {
  const i = options.findIndex((o) => valueOf(o) === value);
  const moves: Record<string, number | undefined> = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: options.length - 1 };
  const next = moves[e.key];
  if (next === undefined || !options.length) return;
  e.preventDefault();
  const v = valueOf(options[(next + options.length) % options.length]);
  onChange(v);
  // Focus follows the selection once React has re-rendered.
  const list = e.currentTarget;
  requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-tab="${CSS.escape(v)}"]`)?.focus());
}

/**
 * Underline tab row (Movers / New / Soon / Graduated, Open / Closed ...).
 * Inactive tabs are muted, the active one cream over a 2px gold bar; every
 * tab is at least 44x44. The row scrolls sideways without a scrollbar.
 * `sticky` pins it under the mobile header (`top-14`) with its own px-4, so
 * render it outside the page's horizontal padding to span the full width.
 * `right` holds trailing controls (for example IconButtons).
 */
export function MobileTabs<T extends string>({ options, value, onChange, label, sticky = false, right, className }: { options: readonly TabOption<T>[]; value: T; onChange: (v: T) => void; label: string; sticky?: boolean; right?: ReactNode; className?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  // Fade whichever edge has more tabs past it.
  const [fade, setFade] = useState<readonly [boolean, boolean]>([false, false]);
  const measure = useCallback(() => {
    const s = scroller.current;
    if (!s) return;
    const l = s.scrollLeft > 1;
    const r = s.scrollLeft + s.clientWidth < s.scrollWidth - 1;
    setFade((f) => (f[0] === l && f[1] === r ? f : [l, r]));
  }, []);
  useEffect(() => {
    const s = scroller.current;
    if (!s) return;
    s.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(s);
    return () => {
      s.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [measure]);
  useEffect(measure, [measure, options.length]);
  // Bring the selected tab into view when the selection changes.
  useEffect(() => {
    const s = scroller.current;
    const el = s?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!s || !el) return;
    const sr = s.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (er.left < sr.left) s.scrollLeft -= sr.left - er.left + 24;
    else if (er.right > sr.right) s.scrollLeft += er.right - sr.right + 24;
  }, [value]);
  const mask = fade[0] || fade[1] ? `linear-gradient(90deg, ${fade[0] ? "transparent, #000 24px" : "#000"}, ${fade[1] ? "#000 calc(100% - 24px), transparent" : "#000"})` : undefined;
  return (
    // On a phone in landscape (under 480px tall) the row stays in the page, so the header and nav leave room for content.
    <div className={cx("flex items-center gap-1 border-b border-line", sticky && "sticky top-14 z-30 bg-canvas/95 px-4 backdrop-blur-md max-md:[@media(max-height:480px)_and_(orientation:landscape)]:static", className)}>
      <div
        ref={scroller}
        role="tablist"
        aria-label={label}
        onKeyDown={(e) => onTabKeys(e, options, value, onChange)}
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        className="scrollbar-none flex min-w-0 flex-1 items-center gap-5 overflow-x-auto"
      >
        {options.map((o) => {
          const v = valueOf(o);
          const on = v === value;
          return (
            <button
              key={v}
              type="button"
              role="tab"
              data-tab={v}
              aria-selected={on}
              aria-label={typeof o === "string" ? undefined : o.ariaLabel}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(v)}
              className={cx(
                "flex h-11 min-w-11 shrink-0 items-center justify-center whitespace-nowrap text-[15px] font-semibold transition-colors duration-100 ease-out focus-visible:outline-offset-[-2px]",
                on ? "text-cream" : "text-muted active:text-cream",
              )}
            >
              {/* The bar spans the label, at the bottom edge of the 44px tab. */}
              <span className="relative flex h-full items-center gap-1.5">
                {typeof o === "string" ? o : o.label}
                <span aria-hidden className={cx("absolute inset-x-0 bottom-0 h-0.5 rounded-full transition-colors duration-100 ease-out", on ? "bg-gold" : "bg-transparent")} />
              </span>
            </button>
          );
        })}
      </div>
      {right && <div className={cx("flex shrink-0 items-center", sticky && "-mr-2.5")}>{right}</div>}
    </div>
  );
}

/**
 * Segmented pill tabs (Traders / Squads / Rewards, 1D / 1W / 1M): a surface
 * track with 44px items; the active one gets the gold-on-bronze `tab-active`
 * fill. Items share the width evenly; pass `className="w-fit"` for a compact group.
 */
export function PillTabs<T extends string>({ options, value, onChange, label, className }: { options: readonly TabOption<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string }) {
  return (
    <div role="tablist" aria-label={label} onKeyDown={(e) => onTabKeys(e, options, value, onChange)} className={cx("flex gap-1 rounded-xl border border-line bg-surface p-1", className)}>
      {options.map((o) => {
        const v = valueOf(o);
        const on = v === value;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            data-tab={v}
            aria-selected={on}
            aria-label={typeof o === "string" ? undefined : o.ariaLabel}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(v)}
            className={cx("flex h-11 min-w-11 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[14px] font-semibold", on ? "tab-active" : "tab hover:bg-surface-2 active:text-cream")}
          >
            {typeof o === "string" ? o : o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Round 44x44 icon-only button; `label` becomes its aria-label. */
export function IconButton({ label, onClick, children, className, type = "button", ...rest }: { label: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label">) {
  return (
    <button
      type={type}
      aria-label={label}
      onClick={onClick}
      className={cx("relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-100 ease-out active:bg-surface-2 active:text-cream disabled:opacity-50", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Follow toggle. `sm`: a 32px gold outline pill with a 44px hit area
 * (`touch-target`) that turns into a quiet "Following". `lg`: a full-width
 * 44px button for sheets, solid gold until followed. `narrow` (sm only):
 * below 380px the pill shrinks to its icon (a plus, or a check once
 * followed), so a ranking row's name keeps its room.
 */
export function FollowButton({ name, on, onToggle, size = "sm", narrow = false, className }: { name: string; on: boolean; onToggle: () => void; size?: "sm" | "lg"; narrow?: boolean; className?: string }) {
  const compact = size === "sm" && narrow;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`Follow ${name}`}
      onClick={onToggle}
      className={cx(
        size === "sm"
          ? cx(
              "touch-target relative inline-flex h-8 w-16 shrink-0 items-center justify-center gap-0.5 rounded-full border text-[12px] font-semibold transition-[color,background-color,border-color,transform] duration-100 ease-out active:scale-[0.98]",
              compact && "max-[379px]:w-8",
              on ? "border-line bg-surface-2 text-muted" : "border-gold/55 bg-gold/10 text-gold active:bg-gold/20",
            )
          : cx("h-11 w-full rounded-xl text-[14px]", on ? "btn-ghost" : "btn-gold"),
        className,
      )}
    >
      {size === "lg" && on && <Check className="h-4 w-4 text-gold" strokeWidth={2.5} aria-hidden />}
      {compact && on && <Check className="h-3.5 w-3.5 min-[380px]:hidden" strokeWidth={2.5} aria-hidden />}
      {!on && <Plus className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} strokeWidth={2.5} aria-hidden />}
      {/* The aria-label names the button, so the narrow icon-only pill reads the same. */}
      {compact ? <span className="max-[379px]:hidden">{on ? "Following" : "Follow"}</span> : on ? "Following" : "Follow"}
    </button>
  );
}

/** AgeTag's sprout and "6h ago", except that phones under 375px drop the " ago" so the ticker beside it keeps its room. */
export function AgeLabel({ ms }: { ms: number }) {
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-[12px] font-medium text-gold/90">
      <Sprout className="h-3 w-3" aria-hidden />
      {/* One flex item, so the gap after the sprout doesn't also widen the space before "ago". */}
      <span>
        {age(ms)}
        <span className="max-[374px]:hidden"> ago</span>
      </span>
    </span>
  );
}

/**
 * Section title row. `action` renders a gold text button such as
 * "Clear All" (44px tall; `ariaLabel` names what it acts on, such as "Clear
 * all recent searches"); `note` puts quiet, non-interactive text in its
 * place; `chevronTo` adds a chevron link to the full list.
 */
export function SectionHeader({ title, action, note, chevronTo, className }: { title: string; action?: { label: string; onClick: () => void; ariaLabel?: string }; note?: ReactNode; chevronTo?: string; className?: string }) {
  return (
    <div className={cx("flex min-h-11 items-center gap-1", className)}>
      <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-cream">{title}</h2>
      {note && <span className="flex shrink-0 items-center gap-1 pl-3 text-[13px] font-medium text-muted">{note}</span>}
      {action && (
        <button type="button" onClick={action.onClick} aria-label={action.ariaLabel} className="h-11 min-w-11 shrink-0 pl-3 text-right text-[13px] font-semibold text-gold transition-opacity duration-100 ease-out active:opacity-70">
          {action.label}
        </button>
      )}
      {chevronTo && (
        <Link to={chevronTo} aria-label={`See all: ${title}`} className="flex h-11 w-11 shrink-0 items-center justify-end text-muted transition-colors duration-100 ease-out active:text-cream">
          <ChevronRight className="h-5 w-5" aria-hidden />
        </Link>
      )}
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Pixels the sheet has to be dragged down before letting go closes it. */
const DISMISS_PX = 80;

/**
 * Bottom sheet: slides up over a blurred backdrop (150ms, usePresence), up
 * to 85% of the viewport tall with a scrolling body, clear of the home
 * indicator. Closes on Esc, a backdrop tap, the close button, or dragging
 * the handle down. Focus moves into the sheet and back to the trigger, and
 * Tab stays inside it (or in the wallet picker over it).
 *
 * It renders in place (no portal), so keep it out of any element with a
 * transform, filter or backdrop-filter, which would become the containing
 * block of its fixed overlay: not inside the sticky MobileTabs (its `right`
 * slot included) or the mobile header. A sibling at the page root is safe.
 */
export function BottomSheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const { mounted, shown } = usePresence(open);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const [drag, setDrag] = useState(0);
  const dragFrom = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        // Esc closes the top layer first: a popover open in the sheet (Slippage) or the wallet picker over it closes on its own.
        if (panel.current?.querySelector("[data-popover-open]") || document.querySelector(".wallet-adapter-modal")) return;
        return closeRef.current();
      }
      // Keep Tab inside the sheet.
      const p = panel.current;
      if (e.key !== "Tab" || !p) return;
      // The wallet picker over the sheet keeps Tab inside itself; it never takes focus on its own, so hand it over.
      const picker = document.querySelector<HTMLElement>(".wallet-adapter-modal");
      if (picker) {
        if (!picker.contains(document.activeElement)) {
          e.preventDefault();
          picker.querySelector<HTMLElement>("button")?.focus();
        }
        return;
      }
      const items = [...p.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      // Focus that fell out of the sheet (the picker closed) comes back in.
      if (!p.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (document.activeElement === first || document.activeElement === p)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const raf = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      // Only if focus is still ours: something that took it meanwhile (search's autofocused field after ⌘K) keeps it.
      const active = document.activeElement;
      if (active === document.body || (active && panel.current?.contains(active))) trigger?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!mounted) return null;

  const grab = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("button, a")) return;
      dragFrom.current = e.clientY;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => dragFrom.current !== null && setDrag(Math.max(0, e.clientY - dragFrom.current)),
    onPointerUp: () => {
      if (dragFrom.current !== null && drag > DISMISS_PX) onClose();
      dragFrom.current = null;
      setDrag(0);
    },
    onPointerCancel: () => {
      dragFrom.current = null;
      setDrag(0);
    },
  };

  return (
    <div className="fixed inset-0 z-[70]">
      <div className={backdropClass(shown)} onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={drag ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
        className={cx(
          "panel-raised absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-b-none rounded-t-2xl supports-[height:100dvh]:max-h-[85dvh] border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)] outline-none transition-transform duration-150 ease-out",
          shown ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div {...grab} className="shrink-0 touch-none select-none">
          <div className="flex justify-center pt-2.5" aria-hidden>
            <span className="h-1 w-10 rounded-full bg-line-accent" />
          </div>
          <div className="flex items-center gap-2 pl-4 pr-1.5">
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-[16px] font-semibold text-cream">
              {title}
            </h2>
            <IconButton label="Close" onClick={onClose}>
              <X className="h-5 w-5" aria-hidden />
            </IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">{children}</div>
      </div>
    </div>
  );
}

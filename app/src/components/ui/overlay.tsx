import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { backdropClass, dialogClass, usePresence } from "../../hooks/usePresence";
import { useApp } from "../../state/AppState";
import { cx } from "./primitives";

/** What Tab can land on inside a dialog (as in BottomSheet). */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Centered dialog; below md a full-screen sheet. With `manageFocus`, focus moves into the dialog as it opens, Tab stays
 * inside it (or in the wallet picker over it, which Esc closes first), and focus goes back to the trigger when it
 * closes, as in BottomSheet. It's opt-in (the phone launch modal and the Portfolio dialogs), so the desktop launch modal
 * keeps the behavior it had.
 */
export function Modal({ open, onClose, children, label, className, manageFocus = false }: { open: boolean; onClose: () => void; children: ReactNode; label: string; className?: string; manageFocus?: boolean }) {
  const { mounted, shown } = usePresence(open);
  const dialog = useRef<HTMLDivElement>(null);
  const managed = useRef(manageFocus);
  useEffect(() => {
    managed.current = manageFocus;
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !(managed.current && document.querySelector(".wallet-adapter-modal")) && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  useEffect(() => {
    if (!open || !manageFocus) return;
    const inside = (el: Element | null) => !!el && !!dialog.current?.contains(el);
    // Focus already inside (the layout switched to the phone's while the dialog was open) stays where it is, and there's no trigger to return to.
    const trigger = document.activeElement instanceof HTMLElement && !inside(document.activeElement) ? document.activeElement : null;
    const onTab = (e: KeyboardEvent) => {
      const d = dialog.current;
      if (e.key !== "Tab" || !d) return;
      // The wallet picker over the dialog keeps Tab inside itself; it never takes focus on its own, so hand it over.
      const picker = document.querySelector<HTMLElement>(".wallet-adapter-modal");
      if (picker) {
        if (!picker.contains(document.activeElement)) {
          e.preventDefault();
          picker.querySelector<HTMLElement>("button")?.focus();
        }
        return;
      }
      const items = [...d.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      // Focus that fell out of the dialog (the pressed Launch button gave way to the progress view, the picker closed) comes back in.
      if (!inside(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (document.activeElement === first || document.activeElement === d)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onTab);
    const raf = requestAnimationFrame(() => !inside(document.activeElement) && dialog.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onTab);
      // Only if focus is still ours: something that took it meanwhile (a page's autofocused field) keeps it.
      const active = document.activeElement;
      if (trigger && (active === document.body || (active && dialog.current?.contains(active)))) trigger.focus({ preventScroll: true });
    };
  }, [open, manageFocus]);
  if (!mounted) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className={backdropClass(shown)} aria-hidden />
      <div
        className="absolute inset-0 flex items-start justify-center overflow-y-auto p-6 max-md:overscroll-contain max-md:p-0"
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          // A press outside closes it; with managed focus it doesn't also blur the trigger the close just focused.
          if (manageFocus) e.preventDefault();
          onClose();
        }}
      >
      {/* Below md the dialog is a full-screen sheet: no frame or margin, at least the viewport tall, clear of the notch. */}
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={manageFocus ? -1 : undefined}
        className={cx("panel-raised relative my-6 w-full max-md:my-0 max-md:min-h-full max-md:rounded-none max-md:border-0 max-md:pb-[env(safe-area-inset-bottom)] max-md:pt-[env(safe-area-inset-top)]", dialogClass(shown), manageFocus && "outline-none", className)}
      >
        <button onClick={onClose} className="btn-icon absolute right-3 top-3 z-10 max-md:right-2 max-md:top-[calc(0.5rem+env(safe-area-inset-top))]" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
        {children}
      </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    // Below md the stack spans the width (inset-x-4) just under the header, clear of every bar pinned above the nav
    // (search field, Buy / Sell, Deposit / Receive, the create button), and above bottom sheets (z-[70]). From md up
    // it keeps clear of a notch on the right (env() is 0 in desktop browsers).
    <div className="pointer-events-none fixed bottom-14 right-[calc(1.25rem+env(safe-area-inset-right))] z-[60] flex w-80 flex-col gap-2 max-md:inset-x-4 max-md:bottom-auto max-md:top-[calc(4rem+env(safe-area-inset-top))] max-md:z-[80] max-md:w-auto" aria-live="polite">
      {toasts.map((t) => {
        const Icon = t.tone === "good" ? CheckCircle2 : t.tone === "bad" ? XCircle : Info;
        return (
          <div key={t.id} className="panel-raised pointer-events-auto flex gap-3 p-3">
            <Icon className={cx("mt-0.5 h-4 w-4 shrink-0", t.tone === "good" ? "text-gold" : t.tone === "bad" ? "text-ember" : "text-rosebronze")} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold">{t.title}</div>
              {t.body && <div className="mt-0.5 break-words text-xs text-muted">{t.body}</div>}
            </div>
            <button onClick={() => dismissToast(t.id)} className="touch-target text-muted hover:text-cream" aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

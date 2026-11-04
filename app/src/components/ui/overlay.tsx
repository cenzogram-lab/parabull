import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { backdropClass, dialogClass, usePresence } from "../../hooks/usePresence";
import { useApp } from "../../state/AppState";
import { cx } from "./primitives";

export function Modal({ open, onClose, children, label, className }: { open: boolean; onClose: () => void; children: ReactNode; label: string; className?: string }) {
  const { mounted, shown } = usePresence(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!mounted) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className={backdropClass(shown)} aria-hidden />
      <div className="absolute inset-0 flex items-start justify-center overflow-y-auto p-6 max-md:overscroll-contain max-md:p-0" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* Below md the dialog is a full-screen sheet: no frame or margin, at least the viewport tall, clear of the notch. */}
      <div role="dialog" aria-modal="true" aria-label={label} className={cx("panel-raised relative my-6 w-full max-md:my-0 max-md:min-h-full max-md:rounded-none max-md:border-0 max-md:pb-[env(safe-area-inset-bottom)] max-md:pt-[env(safe-area-inset-top)]", dialogClass(shown), className)}>
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
    // (search field, Buy / Sell, Deposit / Receive, the create button), and above bottom sheets (z-[70]).
    <div className="pointer-events-none fixed bottom-14 right-5 z-[60] flex w-80 flex-col gap-2 max-md:inset-x-4 max-md:bottom-auto max-md:top-[calc(4rem+env(safe-area-inset-top))] max-md:z-[80] max-md:w-auto" aria-live="polite">
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

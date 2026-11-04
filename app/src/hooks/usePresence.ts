import { useEffect, useState } from "react";

export const OVERLAY_MS = 150;

/**
 * Keeps an overlay mounted for its exit transition. `shown` flips one frame
 * after mount (so the enter transition runs from the hidden state) and
 * immediately on close; `mounted` drops after `ms`.
 */
export function usePresence(open: boolean, ms = OVERLAY_MS) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open, ms]);
  return { mounted, shown };
}

/** Backdrop: black/80 + blur, fading over 150ms. */
export const backdropClass = (shown: boolean) => `fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity duration-150 ${shown ? "opacity-100" : "opacity-0"}`;

/** Dialog surface: scales 95% -> 100% and fades in over 150ms, ease-out. */
export const dialogClass = (shown: boolean) => `transform transition-all duration-150 ease-out ${shown ? "scale-100 opacity-100" : "scale-95 opacity-0"}`;

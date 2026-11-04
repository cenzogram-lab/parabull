import { useCallback, useSyncExternalStore } from "react";

/** One MediaQueryList per query string, shared by every subscriber. */
const lists = new Map<string, MediaQueryList>();
function list(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  let mql = lists.get(query);
  if (!mql) {
    mql = window.matchMedia(query);
    lists.set(query, mql);
  }
  return mql;
}

/**
 * Live result of a CSS media query. The first render already reads the real
 * value (no mobile/desktop flash), and the hook re-renders when it changes.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = list(query);
      if (!mql) return () => undefined;
      // Safari < 14 only has the deprecated addListener.
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      }
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => list(query)?.matches ?? false,
    () => false,
  );
}

/** True below Tailwind's `md` breakpoint (768px): the mobile layout. */
export function useIsMobile(): boolean {
  return !useMediaQuery("(min-width: 768px)");
}

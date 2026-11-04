import { useEffect, useState } from "react";

/**
 * Pixels at the bottom of the layout viewport hidden by the on-screen
 * keyboard, from `window.visualViewport` (0 when closed or unsupported).
 * A fixed bar at `bottom: inset` sits right above the keyboard.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const hidden = window.innerHeight - vv.height - vv.offsetTop;
      // Ignore sub-pixel rounding.
      setInset(hidden > 1 ? Math.round(hidden) : 0);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

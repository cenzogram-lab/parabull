import { Plus } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { showsCreateFab } from "./routes";

/** Round gold "+" just above the bottom nav (below md, board and screener only); opens the launch modal over the current page. */
export function MobileCreateFab() {
  const location = useLocation();
  const navigate = useNavigate();
  if (!showsCreateFab(location.pathname)) return null;
  return (
    <button
      type="button"
      onClick={() => navigate("/create", { state: { background: location } })}
      aria-label="Start a coin"
      className="btn-gold fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-40 h-[52px] w-[52px] rounded-full shadow-[0_10px_28px_-6px_rgba(0,0,0,0.85),0_0_0_1px_rgba(229,169,103,0.35),inset_0_1px_0_rgba(255,240,216,0.45)] md:hidden"
    >
      <Plus className="h-6 w-6" strokeWidth={2.5} aria-hidden />
    </button>
  );
}

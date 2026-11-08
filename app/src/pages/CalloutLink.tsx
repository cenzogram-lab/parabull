/**
 * /c/:id, a callout's share link. It looks the callout up (the loaded feed, else the edge Worker), remembers it as the
 * referral for its coin (src/lib/referral.ts; a buy of that coin then credits the caller) and opens the coin's page.
 */
import { Loader2, Megaphone } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { rememberReferral } from "../lib/referral";
import { useMarket } from "../state/Market";

export function CalloutLink() {
  const { id = "" } = useParams();
  const { findCallout } = useMarket();
  const navigate = useNavigate();
  const [state, setState] = useState<"loading" | "missing" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stop = false;
    setState("loading");
    findCallout(id).then(
      (c) => {
        if (stop) return;
        if (!c) return setState("missing");
        // Demo callouts have no wallet to credit.
        if (c.wallet) rememberReferral({ calloutId: c.id, mint: c.mint, author: c.wallet, at: Date.now() });
        navigate(`/coin/${c.mint}`, { replace: true });
      },
      () => !stop && setState("error"),
    );
    return () => {
      stop = true;
    };
  }, [id, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-32 text-center max-md:px-4 max-md:py-16" aria-live="polite">
      {state === "loading" ? (
        <>
          <Loader2 className="h-6 w-6 animate-spin text-copper" aria-hidden />
          <p className="text-[14px] text-muted">Opening the callout…</p>
        </>
      ) : (
        <>
          <Megaphone className="h-8 w-8 text-copper" aria-hidden />
          <h1 className="text-xl font-semibold">{state === "missing" ? "This callout doesn't exist" : "Couldn't load this callout"}</h1>
          <div className="flex gap-2">
            {state === "error" && (
              <button type="button" onClick={() => setAttempt((n) => n + 1)} className="btn-ghost h-10 px-5">
                Try again
              </button>
            )}
            <Link to="/" className="btn-gold h-10 px-5">
              Back to the board
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

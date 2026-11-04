import { isDemo } from "../../config";
import { useMarket } from "../../state/Market";

/** The desktop footer's data notice, as a quiet note at the end of mobile pages. */
export function MobileFootnote() {
  const { solUsd } = useMarket();
  return (
    // Full muted (6:1 on the canvas): the desktop footer's muted/80 is under 4.5:1 at this size.
    <div className="px-4 pb-1 pt-8 text-center text-[11.5px] leading-4 text-muted md:hidden">
      <p>{isDemo ? "Demo data: prices, trades and traders are simulated" : "Lists, charts and the portfolio use demo data until the indexer API is connected"}</p>
      <p className="num mt-0.5">SOL ${solUsd.toFixed(2)}</p>
    </div>
  );
}

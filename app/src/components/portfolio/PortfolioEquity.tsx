import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { pct, usd, usdSigned } from "../../lib/format";
import type { PortfolioPeriod } from "../../mock/portfolio";
import type { Portfolio } from "../../state/usePortfolio";
import { ChangePill, cx } from "../ui/primitives";
import { EquityChart } from "./EquityChart";
import { Segment } from "./Segment";
import { PERIOD_LABEL, PERIODS, pointTime } from "./shared";

/**
 * Net equity: the big figure, its change over the chosen period (1D / 1W /
 * 1M / ALL) and the equity curve. Scrubbing the curve shows that point's
 * value and its change since the period began; letting go returns to now.
 * The change for every period is read off the curve, whose 1D series starts
 * exactly 24h of change below today's equity.
 */
export function PortfolioEquity({ history, className }: { history: Portfolio["history"]; className?: string }) {
  const [period, setPeriod] = useState<PortfolioPeriod>("1D");
  const [index, setIndex] = useState<number | null>(null);
  const [now] = useState(() => Date.now());
  const isMobile = useIsMobile();
  const data = useMemo(() => history(period), [history, period]);

  const first = data[0];
  const last = data[data.length - 1];
  const at = index !== null && index < data.length ? data[index] : null;
  const point = at ?? last;
  const change = point.v - first.v;
  const changePct = first.v > 0 ? point.v / first.v - 1 : 0;
  const total = last.v - first.v;
  const summary = `Equity over the ${PERIOD_LABEL[period]}: ${usd(first.v)} to ${usd(last.v)}, ${total >= 0 ? "up" : "down"} ${usd(Math.abs(total))} (${pct(Math.abs(first.v > 0 ? last.v / first.v - 1 : 0), 1, false)})`;

  // While scrubbing, the change keeps the width it had at rest, so the row
  // never re-wraps and moves the chart under the finger.
  const changeRef = useRef<HTMLParagraphElement>(null);
  const [restWidth, setRestWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = changeRef.current;
    if (at || !el) return;
    const w = el.offsetWidth;
    setRestWidth((x) => (x === w ? x : w));
  });

  return (
    <section aria-label="Net equity" className={className}>
      <p className="text-[13px] font-medium leading-5 text-muted">Net equity</p>
      {/* Proportional figures: tabular digits look loose at this size. */}
      <p className="mt-0.5 truncate text-[40px] font-semibold leading-[46px] tracking-tight text-cream md:text-[44px] md:leading-[52px]">{usd(point.v)}</p>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
        <p ref={changeRef} style={at && restWidth ? { width: restWidth } : undefined} className="flex min-w-0 items-center gap-1.5">
          <span className={cx("num min-w-0 truncate text-[14px] font-semibold", change >= 0 ? "text-gold" : "text-ember")}>{usdSigned(change)}</span>
          <span className="flex shrink-0">
            <ChangePill value={changePct} />
          </span>
          <span className="sr-only">{at ? `since the start of the period, at ${pointTime(at.t, period, now)}` : `over the ${PERIOD_LABEL[period]}`}</span>
        </p>
        <Segment
          label="Chart period"
          options={PERIODS}
          value={period}
          onChange={(p) => {
            setPeriod(p);
            setIndex(null);
          }}
        />
      </div>
      <EquityChart className="mt-1" height={isMobile ? 180 : 220} data={data} index={index} onIndex={setIndex} label={summary} readout={at ? { value: usd(at.v), time: pointTime(at.t, period, now) } : null} />
    </section>
  );
}

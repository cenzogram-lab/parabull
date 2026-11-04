/**
 * The Portfolio equity curve: a 2px gold line over a gold wash that fades out
 * toward the bottom, and a dot on the latest value. No axes or grid; the big
 * number above it carries the value.
 *
 * Scrubbing: dragging sideways (or resting a finger) on the chart, or moving
 * a mouse over it, snaps a hairline to the nearest point and reports its
 * index through `onIndex`, so the page can show that point's value; letting
 * go reports null. Vertical swipes still scroll the page.
 */
import { useId, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { hex } from "../../theme/tokens";
import { cx } from "../ui/primitives";

export interface EquityPoint {
  t: number;
  v: number;
}

/** Room above the plot for the scrub time label. */
const BAND = 24;
const PAD_BOTTOM = 6;
/** A touch must travel this far sideways, or rest this long, before it scrubs (until then it may be a scroll). */
const SLOP_PX = 6;
const HOLD_MS = 180;

function Dot({ x, y, dim = false }: { x: number; y: number; dim?: boolean }) {
  return (
    <g opacity={dim ? 0.45 : 1}>
      {/* A 2px canvas ring keeps the dot legible where it sits on the line. */}
      <circle cx={x} cy={y} r={6} fill={hex.canvas} />
      <circle cx={x} cy={y} r={4} fill={hex.gold} />
    </g>
  );
}

export function EquityChart({ data, index, onIndex, label, readout, height = 180, className }: { data: EquityPoint[]; index: number | null; onIndex: (i: number | null) => void; label: string; readout: { value: string; time: string } | null; height?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const touch = useRef<{ id: number; x0: number; y0: number; live: boolean; timer: number } | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = data.length;
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of data) {
    lo = Math.min(lo, d.v);
    hi = Math.max(hi, d.v);
  }
  // A flat series draws a level line through the middle.
  if (!(hi - lo > Math.abs(hi) * 1e-6)) {
    lo -= 1;
    hi += 1;
  }
  // The end dot (r 4 plus its 2px ring) stays inside the right edge.
  const left = 1;
  const right = Math.max(left + 1, width - 7);
  const top = BAND + 6;
  const bottom = height - PAD_BOTTOM;
  const x = (i: number) => left + (n > 1 ? (i / (n - 1)) * (right - left) : 0);
  const y = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const line = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(d.v).toFixed(1)}`).join("");
  const area = `${line}L${x(n - 1).toFixed(1)} ${height}L${x(0).toFixed(1)} ${height}Z`;
  const at = index !== null && index < n ? index : null;
  const sx = at === null ? null : x(at);

  const indexAt = (clientX: number) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r || n < 2) return 0;
    return Math.max(0, Math.min(n - 1, Math.round(((clientX - r.left - left) / (right - left)) * (n - 1))));
  };
  const release = () => {
    if (touch.current) window.clearTimeout(touch.current.timer);
    touch.current = null;
    onIndex(null);
  };
  const handlers = {
    onPointerDown: (e: PointerEvent<SVGSVGElement>) => {
      if (e.pointerType === "mouse" || n < 2) return;
      const x0 = e.clientX;
      const timer = window.setTimeout(() => {
        if (!touch.current) return;
        touch.current.live = true;
        onIndex(indexAt(x0));
      }, HOLD_MS);
      touch.current = { id: e.pointerId, x0, y0: e.clientY, live: false, timer };
    },
    onPointerMove: (e: PointerEvent<SVGSVGElement>) => {
      if (n < 2) return;
      if (e.pointerType === "mouse") return onIndex(indexAt(e.clientX));
      const t = touch.current;
      if (!t || t.id !== e.pointerId) return;
      if (!t.live) {
        const dx = Math.abs(e.clientX - t.x0);
        const dy = Math.abs(e.clientY - t.y0);
        // Mostly vertical: a scroll, which the browser takes over (touch-action: pan-y).
        if (dy > SLOP_PX && dy > dx) return release();
        if (dx < SLOP_PX) return;
        t.live = true;
        window.clearTimeout(t.timer);
      }
      onIndex(indexAt(e.clientX));
    },
    onPointerUp: release,
    onPointerCancel: release,
    onPointerLeave: (e: PointerEvent<SVGSVGElement>) => e.pointerType === "mouse" && onIndex(null),
  };

  // The readout slides along with the hairline and never leaves the box: its
  // anchor moves from its left edge (at the chart's left) to its right edge.
  const share = sx === null || width <= 0 ? 0 : Math.max(0, Math.min(1, sx / width));

  return (
    <div ref={box} className={cx("relative select-none", className)} style={{ height }}>
      {sx !== null && readout && (
        // Value first, then when.
        <span aria-hidden className="num pointer-events-none absolute top-0 whitespace-nowrap rounded-md border border-line bg-surface-2 px-2 text-[11.5px] leading-[18px] shadow-sm" style={{ left: sx, transform: `translateX(${-share * 100}%)` }}>
          <span className="font-semibold text-cream">{readout.value}</span>
          <span className="text-muted"> · {readout.time}</span>
        </span>
      )}
      {width > 0 && n > 0 && (
        <svg ref={svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="block touch-pan-y" {...handlers}>
          <defs>
            <linearGradient id={`eq-wash-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={hex.gold} stopOpacity="0.22" />
              <stop offset="1" stopColor={hex.gold} stopOpacity="0" />
            </linearGradient>
            <clipPath id={`eq-past-${id}`}>
              <rect x={-8} y={0} width={(sx ?? width) + 8} height={height} />
            </clipPath>
          </defs>
          {/* While scrubbing, the stretch after the hairline fades back. */}
          {sx !== null && <path d={line} fill="none" stroke={hex.gold} strokeOpacity={0.3} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          <g clipPath={`url(#eq-past-${id})`}>
            <path d={area} fill={`url(#eq-wash-${id})`} />
            <path d={line} fill="none" stroke={hex.gold} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </g>
          {sx !== null && <line x1={Math.round(sx) + 0.5} x2={Math.round(sx) + 0.5} y1={BAND} y2={height} stroke={hex.cream} strokeOpacity={0.35} strokeWidth={1} />}
          <Dot x={x(n - 1)} y={y(data[n - 1].v)} dim={sx !== null && at !== n - 1} />
          {at !== null && at !== n - 1 && <Dot x={x(at)} y={y(data[at].v)} />}
        </svg>
      )}
    </div>
  );
}

import { BadgeCheck, GraduationCap, type LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";
import { hex } from "../../theme/tokens";
import { cx } from "./primitives";

/**
 * Inline trend line: 2px stroke, ~10% area wash, single series (no legend).
 * Up = amber-gold, down = ember. The value it summarizes is always printed
 * next to it, so the line is never the only way to read the number.
 */
export function Sparkline({ data, width = 80, height = 28, label, className }: { data: number[]; width?: number; height?: number; label?: string; className?: string }) {
  const id = useId().replace(/:/g, "");
  if (data.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * (width - 2) + 1, height - 2 - ((v - min) / span) * (height - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  const up = data[data.length - 1] >= data[0];
  const color = up ? hex.gold : hex.ember;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} role="img" aria-label={label ?? (up ? "Trending up" : "Trending down")}>
      <defs>
        <linearGradient id={`s${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L${width - 1} ${height}L1 ${height}Z`} fill={`url(#s${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Coin logo with an optional bonding-curve progress ring and a graduated badge. */
export function CoinAvatar({ src, alt, size = 40, progress, graduated, rounded = "xl" }: { src: string; alt: string; size?: number; progress?: number; graduated?: boolean; rounded?: "xl" | "full" | "2xl" }) {
  const ring = progress !== undefined && !graduated;
  const r = size / 2 + 3;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <img src={src} alt={alt} width={size} height={size} className={cx("h-full w-full object-cover", rounded === "full" ? "rounded-full" : rounded === "2xl" ? "rounded-2xl" : "rounded-xl")} loading="lazy" />
      {ring && (
        <svg className="pointer-events-none absolute -inset-[5px]" width={size + 10} height={size + 10} aria-hidden>
          <circle cx={size / 2 + 5} cy={size / 2 + 5} r={r} fill="none" stroke={hex.lineSoft} strokeWidth="2" />
          <circle
            cx={size / 2 + 5}
            cy={size / 2 + 5}
            r={r}
            fill="none"
            stroke={hex.gold}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${(progress ?? 0) * c} ${c}`}
            transform={`rotate(-90 ${size / 2 + 5} ${size / 2 + 5})`}
          />
        </svg>
      )}
      {graduated && (
        <span className="absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-surface bg-gold text-canvas" title="Graduated to Raydium">
          <GraduationCap className="h-2.5 w-2.5" strokeWidth={2.5} />
        </span>
      )}
    </div>
  );
}

export function TraderAvatar({ src, size = 32, verified, ring }: { src: string; size?: number; verified?: boolean; ring?: "gold" | "rose" | "copper" | "bronze" }) {
  const ringColor = ring ? { gold: hex.gold, rose: hex.rosebronze, copper: hex.copper, bronze: hex.bronze }[ring] : undefined;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <img src={src} alt="" width={size} height={size} className="h-full w-full rounded-full" style={ringColor ? { boxShadow: `0 0 0 2px ${hex.surface}, 0 0 0 3.5px ${ringColor}` } : undefined} />
      {verified && (
        <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-surface">
          <BadgeCheck className="h-3.5 w-3.5 text-gold" aria-label="Verified" />
        </span>
      )}
    </div>
  );
}

/** Meter: metallic fill on a darker step of the bronze ramp. */
export function Meter({ value, tone = "copper", height = 10, label }: { value: number; tone?: "copper" | "gold"; height?: number; label: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} className="relative w-full overflow-hidden rounded-full bg-[#2A211B] shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)]" style={{ height }}>
      <div className={cx("h-full rounded-full", tone === "gold" ? "metal-gold" : "metal-copper")} style={{ width: `${v * 100}%` }} />
      {v > 0 && v < 1 && <div className="absolute inset-y-0 w-px bg-cream/70" style={{ left: `calc(${v * 100}% - 1px)` }} />}
    </div>
  );
}

/** Stat tile: label, proportional-figure value, optional delta and footnote. */
export function StatTile({ icon: Icon, label, value, delta, foot, hero = false }: { icon: LucideIcon; label: string; value: ReactNode; delta?: ReactNode; foot?: ReactNode; hero?: boolean }) {
  return (
    <div className="panel relative overflow-hidden p-5">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-copper/50 to-transparent" />
      <div className="flex items-center gap-2 text-[13px] font-medium text-muted">
        <Icon className="h-4 w-4 text-copper" aria-hidden />
        {label}
      </div>
      <div className={cx("mt-3 font-semibold tracking-tight text-cream", hero ? "text-5xl" : "text-[28px] leading-9")}>{value}</div>
      {(delta || foot) && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          {delta}
          {foot}
        </div>
      )}
    </div>
  );
}

/** Two-part ratio bar (buys vs sells): 8px, rounded ends, 2px surface gap. */
export function RatioBar({ a, b, aLabel, bLabel }: { a: number; b: number; aLabel: string; bLabel: string }) {
  const total = a + b || 1;
  return (
    <div role="img" aria-label={`${aLabel} ${Math.round((a / total) * 100)}%, ${bLabel} ${Math.round((b / total) * 100)}%`} className="flex h-2 w-full gap-[2px]">
      <div className="rounded-l-full bg-gold" style={{ width: `${(a / total) * 100}%` }} />
      <div className="rounded-r-full bg-ember" style={{ width: `${(b / total) * 100}%` }} />
    </div>
  );
}

import { BullMark } from "./BullMark";

export function Wordmark({ size = 34 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <BullMark size={size} />
      <span className="metal-text font-display text-[19px] font-bold tracking-[0.12em]">PARABULL</span>
    </span>
  );
}

/** Simple X (formerly Twitter) glyph for social links. */
export function XLogo({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-label="X" fill="currentColor">
      <path d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.3-8.3L1.9 3h6.4l4.4 5.8L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z" />
    </svg>
  );
}

/** $PARABULL token emblem: the bull mark struck on a bronze coin. */
export function ParabullCoin({ size = 40 }: { size?: number }) {
  return (
    <span className="relative inline-flex items-center justify-center rounded-full" style={{ width: size, height: size, background: "radial-gradient(circle at 35% 30%, #F2CBA8, #B87333 55%, #5A3219 100%)", boxShadow: "inset 0 0 0 2px rgba(255,236,214,.35), inset 0 -3px 6px rgba(0,0,0,.45)" }}>
      <span className="absolute inset-[3px] rounded-full border border-[#FFE6C8]/30" />
      <BullMark size={size * 0.72} ring={false} />
    </span>
  );
}

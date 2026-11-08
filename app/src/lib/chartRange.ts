import type { AutoscaleInfo } from "lightweight-charts";

/**
 * Keeps a series' visible range from collapsing: lightweight-charts steps its axis labels down from the top value by a
 * step derived from the range, and a range that is tiny next to the values (a flat bar, one trade, a quiet coin)
 * makes that step vanish in floating point, so the label loop never ends and the tab hangs. At least `share` of the
 * level (or 1 for a zero level) is always shown.
 */
export function minRange(info: AutoscaleInfo | null, share: number): AutoscaleInfo | null {
  if (!info?.priceRange) return info;
  const { minValue, maxValue } = info.priceRange;
  const mid = (minValue + maxValue) / 2;
  const span = Math.abs(mid) * share || 1;
  if (maxValue - minValue >= span) return info;
  return { ...info, priceRange: { minValue: mid - span / 2, maxValue: mid + span / 2 } };
}

/** Number, time and address formatting shared by every view. */

const SUBSCRIPT = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
const subscript = (n: number) =>
  String(n)
    .split("")
    .map((d) => SUBSCRIPT[Number(d)])
    .join("");
const trimZeros = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

/** 1,284 / 12.9K / 4.2M / 1.3B */
export function compact(n: number, digits = 1): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${trimZeros((n / 1e9).toFixed(digits + 1))}B`;
  if (a >= 1e6) return `${trimZeros((n / 1e6).toFixed(digits + 1))}M`;
  if (a >= 1e4) return `${trimZeros((n / 1e3).toFixed(digits))}K`;
  return Math.round(n).toLocaleString("en-US");
}

/** $412.3K style for market caps and volumes. */
export function usdCompact(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e5 ? 1 : 2)}K`;
  return `${sign}$${a.toFixed(2)}`;
}

/** $58,087.00 */
export const usd = (n: number, digits = 2) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

/** +$58,087.00 / -$1,204.11 */
export const usdSigned = (n: number, digits = 2) => `${n >= 0 ? "+" : "-"}${usd(Math.abs(n), digits)}`;

/** Token prices; tiny values use a subscript zero count: $0.0₄5123. */
export function price(n: number, prefix = "$"): string {
  if (!Number.isFinite(n) || n <= 0) return `${prefix}0`;
  if (n >= 1) return `${prefix}${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  if (n >= 0.001) return `${prefix}${trimZeros(n.toFixed(6))}`;
  // Subscript = zeros after the decimal point: 0.0000912 -> 0.0₄912.
  const zeros = Math.ceil(-Math.log10(n)) - 1;
  const digits = String(Math.min(9999, Math.round(n * 10 ** (zeros + 4)))).replace(/0+$/, "");
  return `${prefix}0.0${subscript(zeros)}${digits || "0"}`;
}

/** +12.3% / -4.1%; large moves keep separators: +4,067.5% */
export function pct(fraction: number, digits = 1, signed = true): string {
  const v = fraction * 100;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = signed ? (v >= 0 ? "+" : "-") : v < 0 ? "-" : "";
  return `${sign}${s}%`;
}

/** Lamports (bigint) or SOL (number) -> "61.52 SOL" */
export const sol = (lamportsOrSol: bigint | number, digits = 2) => {
  const v = typeof lamportsOrSol === "bigint" ? Number(lamportsOrSol) / 1e9 : lamportsOrSol;
  return `${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} SOL`;
};

/** Token base units (6 decimals) -> 12.4M */
export const tokens = (baseUnits: bigint | number) => compact(Number(baseUnits) / 1e6, 2);

/** 12s / 4m / 3h / 2d / 3mo */
export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}

/** 2d 13:04:22 or 13:04:22 */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return d > 0 ? `${d}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

export const shortAddr = (a: string, n = 4) => (a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-n)}`);

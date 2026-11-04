import { useId } from "react";
import { BULL } from "./bullPaths";

/** Cast-bronze bull mark. `ring` adds the nose ring (skip it below ~28px). */
export function BullMark({ size = 32, ring = true, className = "", title = "Parabull" }: { size?: number; ring?: boolean; className?: string; title?: string }) {
  const id = useId().replace(/:/g, "");
  const g = (n: string) => `${n}-${id}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id={g("body")} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#F6D2AC" />
          <stop offset="0.28" stopColor="#D9925F" />
          <stop offset="0.55" stopColor="#B87333" />
          <stop offset="0.8" stopColor="#7E4626" />
          <stop offset="1" stopColor="#4A2816" />
        </linearGradient>
        <linearGradient id={g("horn")} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#FFF0D8" />
          <stop offset="0.3" stopColor="#E5A967" />
          <stop offset="0.7" stopColor="#B87333" />
          <stop offset="1" stopColor="#6A3A1E" />
        </linearGradient>
        <linearGradient id={g("lit")} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFE6C8" stopOpacity="0.55" />
          <stop offset="1" stopColor="#FFE6C8" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={g("muzzle")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#E9B488" />
          <stop offset="1" stopColor="#9A5631" />
        </linearGradient>
      </defs>
      <path d={BULL.hornL} fill={`url(#${g("horn")})`} />
      <path d={BULL.hornR} fill={`url(#${g("horn")})`} />
      <path d={BULL.hornShineL} fill="none" stroke="#FFF3E0" strokeOpacity="0.55" strokeWidth="0.9" strokeLinecap="round" />
      <path d={BULL.hornShineR} fill="none" stroke="#FFF3E0" strokeOpacity="0.3" strokeWidth="0.9" strokeLinecap="round" />
      <path d={BULL.earL} fill="#8E5130" />
      <path d={BULL.earR} fill="#6E3C22" />
      <path d={BULL.head} fill={`url(#${g("body")})`} />
      <path d={BULL.facetL} fill={`url(#${g("lit")})`} />
      <path d={BULL.facetR} fill="#1A0C05" opacity="0.28" />
      <path d={BULL.ridge} fill="#FFE9CF" opacity="0.2" />
      <path d={BULL.muzzle} fill={`url(#${g("muzzle")})`} />
      <path d={BULL.browL} fill="#3B2112" opacity="0.85" />
      <path d={BULL.browR} fill="#2A160B" opacity="0.85" />
      <path d={BULL.eyeL} fill="#2A160B" />
      <path d={BULL.eyeR} fill="#2A160B" />
      <ellipse {...BULL.nostrilL} fill="#3A1E10" />
      <ellipse {...BULL.nostrilR} fill="#3A1E10" />
      {ring && <circle {...BULL.ring} fill="none" stroke="#F2C58C" strokeWidth="1.5" />}
    </svg>
  );
}

// Regenerates public/favicon.svg from the same paths as <BullMark />.
// Run: npx tsx scripts/gen-favicon.ts
import { writeFileSync } from "node:fs";
import { BULL } from "../src/components/brand/bullPaths.ts";

const e = (o: { cx: number; cy: number; rx: number; ry: number }, fill: string) => `<ellipse cx="${o.cx}" cy="${o.cy}" rx="${o.rx}" ry="${o.ry}" fill="${fill}"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs>
<linearGradient id="b" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="#F6D2AC"/><stop offset="0.28" stop-color="#D9925F"/><stop offset="0.55" stop-color="#B87333"/><stop offset="0.8" stop-color="#7E4626"/><stop offset="1" stop-color="#4A2816"/></linearGradient>
<linearGradient id="h" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#FFF0D8"/><stop offset="0.3" stop-color="#E5A967"/><stop offset="0.7" stop-color="#B87333"/><stop offset="1" stop-color="#6A3A1E"/></linearGradient>
<linearGradient id="l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE6C8" stop-opacity="0.55"/><stop offset="1" stop-color="#FFE6C8" stop-opacity="0"/></linearGradient>
<linearGradient id="m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E9B488"/><stop offset="1" stop-color="#9A5631"/></linearGradient>
</defs>
<rect width="64" height="64" rx="14" fill="#0D0C0B"/>
<path d="${BULL.hornL}" fill="url(#h)"/><path d="${BULL.hornR}" fill="url(#h)"/>
<path d="${BULL.earL}" fill="#8E5130"/><path d="${BULL.earR}" fill="#6E3C22"/>
<path d="${BULL.head}" fill="url(#b)"/><path d="${BULL.facetL}" fill="url(#l)"/><path d="${BULL.facetR}" fill="#1A0C05" opacity="0.28"/>
<path d="${BULL.ridge}" fill="#FFE9CF" opacity="0.2"/><path d="${BULL.muzzle}" fill="url(#m)"/>
<path d="${BULL.browL}" fill="#3B2112" opacity="0.85"/><path d="${BULL.browR}" fill="#2A160B" opacity="0.85"/>
<path d="${BULL.eyeL}" fill="#2A160B"/><path d="${BULL.eyeR}" fill="#2A160B"/>
${e(BULL.nostrilL, "#3A1E10")}${e(BULL.nostrilR, "#3A1E10")}
</svg>
`;
writeFileSync(new URL("../public/favicon.svg", import.meta.url), svg);
console.log("wrote public/favicon.svg");

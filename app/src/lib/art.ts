/**
 * Generated artwork for demo data: coin logos, trader identicons and stream
 * frames. Everything is drawn locally as SVG (no remote images).
 */
import { hashSeed, Rng } from "./rng";

const svgUri = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

/** Dark -> light pairs. Mostly warm to sit with the bronze UI, a few cool for variety. */
const PAIRS: readonly [string, string][] = [
  ["#2B1A10", "#E5A967"],
  ["#1C2433", "#6F9FD8"],
  ["#2A1530", "#B784E0"],
  ["#10291F", "#4CC79A"],
  ["#3A1712", "#F0806A"],
  ["#2E2A10", "#E8D06A"],
  ["#0F2A2E", "#4FC3D1"],
  ["#331D12", "#D49B7E"],
  ["#26211D", "#CFC3B8"],
  ["#36122A", "#E07AB5"],
  ["#1A2A12", "#9CCB59"],
  ["#2C1A0C", "#F2B45C"],
];

/** 24x24 emblems. */
const EMBLEMS: Record<string, string> = {
  horns: "M2.5 4.5c1.6 4.2 4.4 6.4 9.5 6.4s7.9-2.2 9.5-6.4c-.4 5.6-3.2 8.6-6.3 9.6v5.4H8.8v-5.4C5.7 13.1 2.9 10.1 2.5 4.5Z",
  bolt: "M13.5 2 4.5 14h7l-1.5 8 9.5-12.5h-7.2L13.5 2Z",
  star: "M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9L12 2.5Z",
  moon: "M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a7 7 0 0 0 11.1 11.1Z",
  diamond: "M12 2.5 21 12l-9 9.5L3 12l9-9.5Zm0 3.6L6.4 12 12 17.9 17.6 12 12 6.1Z",
  flame: "M12.3 2c.9 3.6 5.7 5.7 5.7 10.6a6 6 0 1 1-12 0c0-2.8 1.6-4.2 2.1-6.6 1.9 1 2.9 2.9 3 4.8 1.6-1.9 1.4-5.4 1.2-8.8Z",
  bell: "M12 3a6 6 0 0 0-6 6v4.2L4 16.5h16L18 13.2V9a6 6 0 0 0-6-6Zm-2.2 15a2.2 2.2 0 0 0 4.4 0h-4.4Z",
  candles: "M7 3h1v3h2v10H8v5H7v-5H5V6h2V3Zm9 4h1v3h2v7h-2v4h-1v-4h-2v-7h2V7Z",
  anvil: "M3 7h13c0 2.2 2.2 3.3 5 3.3V12c-3 0-5 1.5-5 3.4l2 3.6H6l2-3.6C8 13.5 6.2 12 3 12V7Z",
  coin: "M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19Zm0 3a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z",
};
const EMBLEM_KEYS = Object.keys(EMBLEMS);

function pattern(kind: number, c: string, rng: Rng): string {
  switch (kind) {
    case 0:
      return [0, 1, 2, 3, 4].map((i) => `<circle cx="48" cy="48" r="${18 + i * 12}" fill="none" stroke="${c}" stroke-width="5" opacity="${0.16 - i * 0.02}"/>`).join("");
    case 1:
      return Array.from({ length: 9 }, (_, i) => `<rect x="${i * 14 - 20}" y="-10" width="6" height="130" fill="${c}" opacity="0.12" transform="rotate(30 48 48)"/>`).join("");
    case 2:
      return Array.from({ length: 36 }, (_, i) => `<circle cx="${(i % 6) * 18 + 3}" cy="${Math.floor(i / 6) * 18 + 3}" r="2.6" fill="${c}" opacity="0.18"/>`).join("");
    case 3:
      return Array.from({ length: 12 }, (_, i) => `<path d="M48 48 L${48 + 80 * Math.cos((i * Math.PI) / 6)} ${48 + 80 * Math.sin((i * Math.PI) / 6)} L${48 + 80 * Math.cos((i * Math.PI) / 6 + 0.22)} ${48 + 80 * Math.sin((i * Math.PI) / 6 + 0.22)}Z" fill="${c}" opacity="0.1"/>`).join("");
    case 4:
      return Array.from({ length: 6 }, (_, i) => `<path d="M-4 ${i * 18 + 6} l18 -10 18 10 18 -10 18 10 18 -10 18 10" fill="none" stroke="${c}" stroke-width="4" opacity="0.13"/>`).join("");
    default: {
      const blobs = Array.from({ length: 4 }, () => `<circle cx="${rng.int(0, 96)}" cy="${rng.int(0, 96)}" r="${rng.int(14, 34)}" fill="${c}" opacity="0.14"/>`);
      return blobs.join("");
    }
  }
}

/** Square coin logo (CSS rounds the corners). */
export function coinArt(seed: string, ticker: string): string {
  const rng = new Rng(`art:${seed}`);
  const [dark, light] = PAIRS[hashSeed(seed) % PAIRS.length];
  const useText = rng.bool(0.3);
  const emblem = EMBLEMS[EMBLEM_KEYS[rng.int(0, EMBLEM_KEYS.length - 1)]];
  const angle = rng.int(0, 3) * 45;
  const fg = rng.bool(0.5) ? "#FFF6EC" : "#1A1210";
  const glyph = useText
    ? `<text x="48" y="61" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="800" font-size="${ticker.length > 3 ? 30 : 38}" fill="${fg}" letter-spacing="-1">${ticker.slice(0, 3).replace(/[<&>]/g, "")}</text>`
    : `<g transform="translate(22 22) scale(2.15)"><path d="${emblem}" fill="${fg}" fill-rule="evenodd"/></g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
<defs><linearGradient id="g" gradientTransform="rotate(${angle} .5 .5)"><stop offset="0" stop-color="${dark}"/><stop offset="1" stop-color="${light}"/></linearGradient>
<radialGradient id="s" cx=".3" cy=".25" r=".9"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>
<filter id="d" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity=".35"/></filter></defs>
<rect width="96" height="96" fill="url(#g)"/>${pattern(rng.int(0, 5), light === fg ? dark : "#FFF6EC", rng)}
<rect width="96" height="96" fill="url(#s)"/><g filter="url(#d)">${glyph}</g></svg>`;
  return svgUri(svg);
}

/** Circular 5x5 mirrored identicon for traders. */
export function avatarArt(seed: string): string {
  const rng = new Rng(`avatar:${seed}`);
  const [dark, light] = PAIRS[hashSeed(`a${seed}`) % PAIRS.length];
  const cells: string[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (!rng.bool(0.52)) continue;
      for (const xx of x === 2 ? [2] : [x, 4 - x]) cells.push(`<rect x="${12 + xx * 14}" y="${12 + y * 14}" width="14" height="14" fill="${light}"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 94 94" width="94" height="94"><rect width="94" height="94" fill="${dark}"/>${cells.join("")}<rect width="94" height="94" fill="url(#v)" opacity=".5"/><defs><radialGradient id="v" cx=".5" cy=".35" r=".75"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".6"/></radialGradient></defs></svg>`;
  return svgUri(svg);
}

/** 16:9 stream frame: a warm stage light, bokeh and the coin's palette. */
export function streamArt(seed: string): string {
  const rng = new Rng(`stream:${seed}`);
  const [dark, light] = PAIRS[hashSeed(seed) % PAIRS.length];
  const bokeh = Array.from(
    { length: 14 },
    () => `<circle cx="${rng.int(0, 320)}" cy="${rng.int(0, 180)}" r="${rng.int(6, 30)}" fill="${rng.bool(0.5) ? light : "#E5A967"}" opacity="${rng.range(0.06, 0.22).toFixed(2)}"/>`,
  ).join("");
  const desk = `<rect x="0" y="138" width="320" height="42" fill="#0D0C0B" opacity=".55"/><rect x="40" y="96" width="92" height="56" rx="4" fill="#141210" stroke="${light}" stroke-opacity=".35"/><polyline points="48,140 62,128 74,132 88,112 100,118 112,104 124,108" fill="none" stroke="#E5A967" stroke-width="2.5"/>`;
  const person = `<circle cx="214" cy="78" r="26" fill="${light}" opacity=".85"/><path d="M168 168c4-34 22-52 46-52s42 18 46 52Z" fill="${light}" opacity=".7"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180"><defs><radialGradient id="l" cx=".65" cy=".3" r=".9"><stop offset="0" stop-color="${light}" stop-opacity=".55"/><stop offset=".7" stop-color="${dark}" stop-opacity=".2"/><stop offset="1" stop-color="#0D0C0B"/></radialGradient></defs><rect width="320" height="180" fill="${dark}"/><rect width="320" height="180" fill="url(#l)"/>${bokeh}${person}${desk}</svg>`;
  return svgUri(svg);
}

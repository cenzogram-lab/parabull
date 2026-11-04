import { useId } from "react";
import { BULL } from "./bullPaths";

/** Horns, ears and head: the silhouette both styles are cut from. */
const SILHOUETTE = [BULL.hornL, BULL.hornR, BULL.earL, BULL.earR, BULL.head];
/** Line weight in viewBox units (about 1.6px at 24px, close to the lucide icons beside it). */
const W = 4.5;
/** The viewBox leaves room for the weight added outside the silhouette. */
const BOX = { x: -2, y: -2, width: 68, height: 68 };

/**
 * Monochrome (currentColor) bull head for icon slots such as the mobile nav,
 * drawn from the brand mark's paths. `filled` draws the solid silhouette with
 * the eyes and nostrils cut out; otherwise an outline of the same footprint
 * with the eyes and a muzzle line, so switching styles never shifts its size.
 */
export function BullGlyph({ size = 24, filled = false, className }: { size?: number; filled?: boolean; className?: string }) {
  const id = `bull-glyph-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const shapes = SILHOUETTE.map((d) => <path key={d} d={d} />);
  return (
    <svg width={size} height={size} viewBox={`${BOX.x} ${BOX.y} ${BOX.width} ${BOX.height}`} fill="none" className={className} aria-hidden focusable="false">
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" {...BOX}>
          <rect {...BOX} fill="#fff" />
          {filled ? (
            <g fill="#000">
              <path d={BULL.eyeL} />
              <path d={BULL.eyeR} />
              <ellipse {...BULL.nostrilL} />
              <ellipse {...BULL.nostrilR} />
            </g>
          ) : (
            // Hide the inner half of every stroke, and the lines where shapes overlap.
            <g fill="#000">{shapes}</g>
          )}
        </mask>
      </defs>
      <g mask={`url(#${id})`} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2 * W} strokeLinejoin="round">
        {shapes}
      </g>
      {!filled && (
        <>
          <g fill="currentColor">
            <path d={BULL.eyeL} />
            <path d={BULL.eyeR} />
          </g>
          <path d="M26.2 45.6C28.6 43.6 35.4 43.6 37.8 45.6" stroke="currentColor" strokeWidth={W * 0.8} strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

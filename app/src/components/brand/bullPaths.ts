/**
 * Original Parabull mark: a front-facing bull head with sweeping horns,
 * shaded as faceted cast bronze. Drawn for Parabull (not traced from any
 * sculpture or photo). 64x64 viewBox, symmetric about x = 32.
 */
export const BULL = {
  hornL: "M23.6 23.2C14.8 24.6 7 21 4 8.2C8.8 14.6 15 17.4 24.4 17.2Z",
  hornR: "M40.4 23.2C49.2 24.6 57 21 60 8.2C55.2 14.6 49 17.4 39.6 17.2Z",
  hornShineL: "M5.6 11.6C9.4 17.6 15.4 20.6 22.4 21",
  hornShineR: "M58.4 11.6C54.6 17.6 48.6 20.6 41.6 21",
  earL: "M20.4 24.6C14.6 23.2 10 25 7.4 28.4C12.2 30.2 17 30 21.4 28Z",
  earR: "M43.6 24.6C49.4 23.2 54 25 56.6 28.4C51.8 30.2 47 30 42.6 28Z",
  head:
    "M20.6 18.6C25.6 15.6 38.4 15.6 43.4 18.6C46.4 24.4 44.8 31.8 41.4 37.6C39.8 40.8 38.9 44.2 38.6 47.4" +
    "C39 52.8 35.8 56 32 56C28.2 56 25 52.8 25.4 47.4C25.1 44.2 24.2 40.8 22.6 37.6C19.2 31.8 17.6 24.4 20.6 18.6Z",
  /** Lit left plane (light from the upper left). */
  facetL: "M20.6 18.6C25.6 15.6 32 15.9 32 15.9L32 44.4L25.4 47.4C25.1 44.2 24.2 40.8 22.6 37.6C19.2 31.8 17.6 24.4 20.6 18.6Z",
  /** Shaded right plane. */
  facetR: "M43.4 18.6C38.4 15.6 32 15.9 32 15.9L32 44.4L38.6 47.4C38.9 44.2 39.8 40.8 41.4 37.6C44.8 31.8 46.4 24.4 43.4 18.6Z",
  /** Forehead ridge highlight. */
  ridge: "M29.8 17.6L34.2 17.6L33.1 39L30.9 39Z",
  browL: "M22.6 26L30.2 28.3L29.8 29.3L22.4 27.1Z",
  browR: "M41.4 26L33.8 28.3L34.2 29.3L41.6 27.1Z",
  muzzle: "M25.6 46C28 43.9 36 43.9 38.4 46C39.6 52 36.2 56 32 56C27.8 56 24.4 52 25.6 46Z",
  eyeL: "M23.8 28.9L29.6 30.6L24.9 31.7Z",
  eyeR: "M40.2 28.9L34.4 30.6L39.1 31.7Z",
  nostrilL: { cx: 28.8, cy: 50.4, rx: 1.55, ry: 2.15 },
  nostrilR: { cx: 35.2, cy: 50.4, rx: 1.55, ry: 2.15 },
  ring: { cx: 32, cy: 56.8, r: 3.1 },
} as const;

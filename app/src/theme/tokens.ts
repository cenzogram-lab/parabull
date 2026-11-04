/**
 * Parabull design tokens: Wall Street Charging Bull, bronze / copper metallic.
 * The single source for colors used by Tailwind (tailwind.config.js imports
 * this file) and by canvas/SVG code (charts, sparklines, generated art).
 * docs/DESIGN.md documents each token and its contrast ratios.
 */
export const colors = {
  /** Base canvas: Deep Obsidian, and Dark Charcoal Bronze for raised bands. */
  canvas: { DEFAULT: "#0D0C0B", 2: "#141210" },
  /** Cards and surfaces: Brushed Dark Bronze. `3` is the derived hover step, `4` the active tab/chip fill. */
  surface: { DEFAULT: "#1A1715", 2: "#231D19", 3: "#2A231E", 4: "#2D2320" },
  /** Borders: Burnished Copper, Metallic Accent, and a derived soft hairline for rows inside a surface. */
  line: { DEFAULT: "#4A3528", accent: "#6B4C38", soft: "#2E241D" },
  /** Highlights and accents. */
  copper: "#C87D55",
  rosebronze: "#D49B7E",
  /** CTAs and active states. */
  gold: "#E5A967",
  bronze: "#B87333",
  /** Typography. */
  cream: "#F5EBE6",
  muted: "#9E8C82",
  /**
   * Derived: legible "down" text. #8B3A2B is too dark for text (2.55:1);
   * ember is 5.53:1 on canvas, 4.71:1 on raised surfaces, and ΔE 17.0 from
   * gold (12.6 under deuteranopia), so up and down never blur together.
   */
  ember: "#E35D4F",
  /** Candles: gold up, bronze-red down (with a lighter edge so bodies clear 3:1). */
  candle: { up: "#E5A967", down: "#8B3A2B", downEdge: "#B5503A" },
} as const;

export const fonts = {
  sans: ['"Inter Variable"', "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
  display: ["Cinzel", "ui-serif", "Georgia", "serif"],
  mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
} as const;

/** Flat values for code that needs a hex string (charts, SVG). */
export const hex = {
  canvas: colors.canvas.DEFAULT,
  canvas2: colors.canvas[2],
  surface: colors.surface.DEFAULT,
  surface2: colors.surface[2],
  surface3: colors.surface[3],
  line: colors.line.DEFAULT,
  lineAccent: colors.line.accent,
  lineSoft: colors.line.soft,
  copper: colors.copper,
  rosebronze: colors.rosebronze,
  gold: colors.gold,
  bronze: colors.bronze,
  cream: colors.cream,
  muted: colors.muted,
  ember: colors.ember,
  up: colors.candle.up,
  down: colors.candle.down,
  downEdge: colors.candle.downEdge,
} as const;

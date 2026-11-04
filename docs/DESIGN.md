# Parabull design system

**Brand:** Wall Street Charging Bull, in bronze and copper metal.

Everything in the web app (`app/`) is drawn from this document. The tokens
live in one place, `app/src/theme/tokens.ts`:
- `app/tailwind.config.js` imports them as Tailwind colors and fonts;
- charts, sparklines and generated art import the same file as hex values.

Change a color there, never inline.

## Visual language

- **Cast bronze:** the bull is heavy, polished and deeply shaded. Surfaces
  have weight: dark bronze cards, a faint warm highlight on the top edge,
  and shadows rather than glows.
- **Brushed copper:** metal fills have fine **horizontal** grain with soft
  **vertical** light bands, like the brushed-copper reference sheet.
  - The grain is fractal noise stretched horizontally (`feTurbulence
    baseFrequency="0.0035 0.75"`, in `app/src/index.css` as `--grain`).
  - It is blended over a horizontal sheen gradient.
- **Metallic strips:** sheen gradients run horizontally, light–dark–light,
  with a warm, narrow highlight. The range goes from rose-gold, through
  chocolate bronze, to red copper.
- **Metal is for accents.** It's used for the primary CTA, progress fills,
  active category tabs and the brand mark. Everything else is flat dark
  bronze, so the metal stays special.

## Color tokens

Contrast ratios are WCAG 2.x, measured against the page background (Deep
Obsidian), and checked with the dataviz contrast script.

| Token | Hex | Tailwind | Role | Contrast on canvas |
| --- | --- | --- | --- | --- |
| Deep Obsidian | `#0D0C0B` | `bg-canvas` | Page background, dock, header | |
| Dark Charcoal Bronze | `#141210` | `bg-canvas-2` | Inputs, inset wells, table heads | |
| Brushed Dark Bronze | `#1A1715` | `bg-surface` | Cards and panels | |
| Brushed Dark Bronze (raised) | `#231D19` | `bg-surface-2` | Hover rows, active nav, popovers | |
| Burnished Copper | `#4A3528` | `border-line` | Borders and dividers | 1.70 (decorative) |
| Metallic Accent | `#6B4C38` | `border-line-accent` | Emphasized borders, crosshair | 2.53 (decorative) |
| Brushed Copper | `#C87D55` | `text-copper` / `bg-copper` | Icons, accents, secondary CTA | 6.07 |
| Satin Rose-Bronze | `#D49B7E` | `text-rosebronze` | Lock badges, labels | 8.18 |
| Radiant Amber-Gold | `#E5A967` | `text-gold` / `bg-gold` | Primary CTA, active state, "up" | 9.49 |
| Polished Bronze | `#B87333` | `bg-bronze` | CTA depth, fills (not small text on raised surfaces: 4.39) | 5.15 |
| Warm Off-White / Cream | `#F5EBE6` | `text-cream` | Primary text | 16.67 |
| Warm Bronze-Muted | `#9E8C82` | `text-muted` | Secondary labels | 6.07 |
| Dark Bronze-Red | `#8B3A2B` | `bg-candle-down` | Down candles, sell fills | 2.55 (fill only) |

### Derived tokens (accessibility and depth)

| Token | Hex | Tailwind | Why |
| --- | --- | --- | --- |
| Surface hover | `#2A231E` | `bg-surface-3` | One step above `surface-2` for selected segmented controls |
| Soft hairline | `#2E241D` | `border-line-soft` | Row dividers inside a surface, quieter than `line` |
| Ember | `#E35D4F` | `text-ember` | "Down" text. `#8B3A2B` is 2.55:1 on canvas, too dark for text. Ember is 5.53:1 on canvas and 4.71:1 on raised surfaces, and sits ΔE 17.0 from gold (12.6 under deuteranopia), past the 15 / 8 floors, so up and down never blur together |
| Down-candle edge | `#B5503A` | `candle-downEdge` | Border and wick of down candles, so bodies in `#8B3A2B` still clear 3:1 |

### Rules

- **Up is Radiant Amber-Gold and down is Dark Bronze-Red** (ember for
  text). Direction is never shown by color alone: changes carry ↑ / ↓
  arrows and a sign.
- **Text uses text tokens** (cream, muted, gold, ember, rosebronze), never a
  fill color that fails 4.5:1.
- **CTA text** on gold, copper or bronze is obsidian (9.49 / 6.07 / 5.15:1).
- **Focus** is a 2px amber-gold outline with a 2px offset, on every
  interactive element.

## Typography

| Face | Use | Never |
| --- | --- | --- |
| Inter Variable | All UI, all numbers. Tables use `tabular-nums` (the `.num` class); large standalone figures keep proportional digits | |
| Cinzel 600/700 | The `PARABULL` wordmark, the "KING OF THE BULL" label, podium rank numerals: engraved-plaque moments only | Data values or hero figures |
| JetBrains Mono 400/500 | Contract addresses, Merkle roots, lock countdowns, lock keys | Prose |

All three are bundled with `@fontsource`, so there are no remote font
requests.

## Materials (CSS classes in `app/src/index.css`)

| Class | Material |
| --- | --- |
| `.panel` / `.panel-raised` | Dark bronze card, burnished-copper border, warm top highlight |
| `.brushed-dark` | Dark brushed bronze (panel headers, hero bands, ticket card) |
| `.metal-copper` | Bright brushed copper (progress fills, numbered steps) |
| `.metal-gold` | Radiant amber-gold metal (primary CTA, active category tab, Buy) |
| `.metal-text` | Copper/gold gradient text (wordmark, `$PARABULL`, rank numerals) |
| `.btn-gold`, `.btn-copper`, `.btn-ghost`, `.chip`, `.input`, `.kbd` | Controls |

## Brand mark

- An original, front-facing bull head with sweeping horns, shaded as
  faceted cast bronze: a lit left plane, a shaded right plane, a ridge
  highlight and a nose ring.
- It is drawn for Parabull, not traced from Arturo Di Modica's *Charging
  Bull* (a copyrighted sculpture), which is a mood reference only.
- Paths: `app/src/components/brand/bullPaths.ts`.
  `npx tsx scripts/gen-favicon.ts` regenerates `app/public/favicon.svg`
  from the same paths.
- `ParabullCoin` is the mark struck on a bronze coin: the `$PARABULL` token
  emblem.

## Data visualization

- **Candles:** gold up and bronze-red down, with the lighter edge above.
  Volume sits in its own band under the price, on its own scale (never a
  second y-axis). The OHLC readout follows the crosshair, value first.
- **Sparklines:**
  - A single series: no legend; the adjacent column carries the number.
  - 1.75px line with a ~20% gradient wash under it.
  - Gold if the window ended up, ember if down.
- **Meters** (bonding curve, DexScreener escrow): a metallic fill on a
  darker bronze track (`#2A211B`), with a cream tick at the leading edge.
  The value and its denominator are always printed next to it.
- **Ratio bar** (buys vs sells): 8px, rounded ends, 2px surface gap, legend
  below with counts and USD in text tokens.
- **Stat tiles:** sentence-case label, value in Inter semibold, optional
  signed delta.

## Layout

The layout uses the structure of the pump.fun desktop app (no Perps, GO or
Mayhem), restyled:
- **Dock:** collapsible left dock, `w-16` collapsed and `w-60` expanded.
- **Header:** `h-14`, with a centered ⌘K search and the wallet button.
- **Quick-info strip:** `h-10`, with Top traders, Open positions,
  Following and Recently viewed.
- **Content area:** each page.

The Board has two workspace layouts, switched from the dock: **Terminal
Pro** (four panels) and **Classic** (feed plus Movers cards).

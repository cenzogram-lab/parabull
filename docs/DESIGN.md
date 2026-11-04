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
- **Metal is for accents.** It's used for progress fills, the Buy side,
  hero bands and the brand mark. Everything else is flat dark bronze, so the
  metal stays special. CTAs are solid amber-gold (see Motion).

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
| `.metal-gold` | Radiant amber-gold metal (Buy side, King of the Bull crown) |
| `.metal-text` | Copper/gold gradient text (wordmark, `$PARABULL`, rank numerals) |
| `.btn-gold` | Primary CTA: solid `#E5A967`, `#B87333` on hover, obsidian text, `active:scale-[0.98]`, 100ms |
| `.btn-copper`, `.btn-ghost`, `.kbd` | Secondary controls |
| `.input` / `.input-shell` | `#141210` fill, `#4A3528` border, `#9E8C82` placeholder; focus: `#C87D55` border + 1px `#E5A967` ring, 100ms. `.input-shell` gives inputs with a prefix or suffix the same focus via `focus-within` |
| `.tab` / `.tab-active`, `.chip` / `.chip-active` | Inactive: muted text, cream + `#1A1715` on hover. Active: `#2D2320` fill, gold text, `#6B4C38` border, `shadow-sm`. 100ms ease-out |
| `.hover-lift` | Screener rows and token cards: `#231D19` fill, `#6B4C38` border, `0 4px 16px rgba(200,125,85,0.08)` shadow, 100ms ease-out |
| `.row-hover` | Table rows: the same fill change, 100ms |

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

## Motion

| Element | Behavior |
| --- | --- |
| Overlays (launch modal, ⌘K search, slippage settings) | Backdrop `bg-black/80 backdrop-blur-sm`, opacity over 150ms. Dialog scales 95% to 100% and fades in over 150ms ease-out; the exit plays in reverse before unmounting (`usePresence`, `app/src/hooks/usePresence.ts`) |
| Rows, cards, tabs, chips, inputs | 100ms ease-out color/border/shadow changes |
| CTAs | 100ms, pressed state `scale(0.98)` |
| Live data | Ticker marquee, new-trade flash in the ledger, launch-delay ring |

`prefers-reduced-motion: reduce` collapses all animation and transition
durations to near zero.

Where the backing surface is already `#1A1715` (Explore category tabs and
the Grid/Table toggle), inactive hover uses `#231D19` instead, so the hover
is visible.

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

## Mobile

Below `md` (768px) the app uses a phone layout built from the same tokens
and materials. From 768px up nothing changes: phone-only styles use
`max-md:` variants or CSS inside `@media (max-width: 767.98px)`, and whole
views switch with `useIsMobile()`.

### Frame

- **Header:** `sticky top-0 z-40 h-14 px-4`, `bg-canvas/90 backdrop-blur-md`,
  `border-b border-line`.
  - **Left capsule:** a 32px round avatar with a copper ring, the equity in
    cream, and the 24h PnL badge (see Gains and losses). The wallet's own
    avatar uses the bronze identicon pairs only (gold, rose-bronze, amber,
    copper), since it sits in the header on every page.
  - **Right:** the Deposit pill (`bg-gold`, `hover:bg-bronze`, obsidian
    `text-xs font-bold`, `rounded-full px-3.5 py-1.5`, `active:scale-95`,
    100ms) and the 44px notification bell.
- **Bottom nav:** a floating pill, never a full-width bar.
  - `fixed inset-x-4 bottom-[calc(0.75rem+env(safe-area-inset-bottom))]
    z-50 h-14 rounded-full px-5`, `bg-canvas/95 backdrop-blur-md`,
    `border border-line`, `shadow-[0_8px_32px_rgba(0,0,0,0.8)]`.
  - Five evenly spaced 48px items: Board (the bull glyph), Explore
    (concentric rings), Leaderboard (trophy), Portfolio (wallet), Search.
  - **Active:** gold, with a filled icon and
    `drop-shadow-[0_0_8px_rgba(229,169,103,0.4)]`, and `aria-current="page"`.
  - **Inactive:** muted, cream while pressed.
- **Create button:** a 52px round `btn-gold` with a "+", `right-4`,
  `bottom-[calc(5rem+env(safe-area-inset-bottom))]`, on the board and
  screener only.
- **Tab rows** under the header pin at `sticky top-14 z-30` on
  `bg-canvas/95 backdrop-blur-md` with a `border-line` rule. Underline tabs:
  inactive muted, active cream over a 2px gold bar. Pill tabs: a `bg-surface`
  track (`p-1 rounded-xl border-line`) with `.tab-active` on the selected item.

### Touch targets

- Every control is at least **44x44px**. Size it for real (`h-11`,
  `min-h-11`), or add **`.touch-target`**. That class (phones only, in
  `index.css`) adds a centered, invisible `::before` of `max(100%, 44px)` in
  each direction, so the hit area grows while the control looks the same.
  It can't reach past an ancestor with `overflow: hidden`.
- Enlarged hit areas of neighbours must not overlap: space them 44px apart
  or size them for real.
- On phones `index.css` also gives `.btn` and every `.btn-*`, `.chip`, `.tab`
  and `.tab-active` a 44px minimum, makes `.btn-icon` 44x44, and sets fields
  to 16px text so iOS doesn't zoom in on focus.
- Interactive elements are never nested. A row that opens something is one
  link or button; its secondary action (a Follow toggle) sits beside it, and
  decorative icons inside it are `aria-hidden`. Only inline links inside a
  sentence may sit in a `[data-touch-exempt]` element.
- `npm run audit:mobile` checks overflow, target sizes and console errors.

### Safe areas and bars

- The viewport uses `viewport-fit=cover`, so everything pinned to the bottom
  adds `env(safe-area-inset-bottom)`:
  - the nav floats 0.75rem above the home indicator;
  - page bars sit at `calc(5rem + env(safe-area-inset-bottom))`, just above
    the nav;
  - `<main>` pads its bottom by `7rem`, or `9rem` where the create button
    shows, plus the inset;
  - sheets pad their bottom by the inset.
- **Page bars:** the search field, Buy / Sell and Deposit / Receive.
  - Buy / Sell and Deposit / Receive are `sticky`, not `fixed`: they dock
    above the nav while the page scrolls and come to rest after the last
    section, so they never cover the page's last lines. A canvas fade behind
    them keeps scrolling content from showing around the buttons.
  - The search field is `fixed` and rises above the on-screen keyboard
    (`useKeyboardInset`); its page pads the bottom so the last row clears it.
- Nothing is ever hidden behind the header, the nav or a bar: lists end
  above them when scrolled to the bottom.

### Layers

| Layer | z-index |
| --- | --- |
| Sticky tab rows | `z-30` |
| Mobile header | `z-40` |
| Page bars (search field, Buy / Sell, Deposit / Receive) and the create button | `z-40` |
| Bottom nav | `z-50` |
| `Modal` (launch flow, full screen on phones), rendered after the shell so it covers the nav | `z-50` |
| Toasts on desktop | `z-[60]` |
| Bottom sheets | `z-[70]` |
| Toasts on phones: full width under the header, above sheets and clear of every bar at the bottom | `z-[80]` |

### Sheets and motion

- **`BottomSheet`** (`src/components/mobile/MobileUi.tsx`):
  - a `bg-black/80 backdrop-blur-sm` backdrop that fades over 150ms;
  - a `.panel-raised` panel with `rounded-t-2xl`, a grab handle, a title row
    and a 44px close button, up to 85% of the viewport tall with a scrolling
    body. It slides up from `translate-y-full` over 150ms ease-out, and the
    exit plays in reverse before it unmounts (`usePresence`).
  - Esc, a backdrop tap, the close button or dragging the handle down 80px
    closes it. Focus moves into the sheet and back to the trigger.
  - It doesn't use a portal, so render it at the page root: an ancestor with
    a transform, filter or backdrop blur (the header, a sticky tab row) would
    trap its fixed overlay.
- Colors, borders and fills change over 100ms ease-out; primary buttons press
  in with `active:scale-[0.98]` (the Deposit pill uses `scale-95`).
  `prefers-reduced-motion` collapses all of it.

### Gains and losses

- **Gains:** gold text on a `bg-gold/10` tint with an up arrow, as in
  `ChangePill` and the header's PnL badge (`+$5.69 ↑ 2.3%`).
- **Losses:** ember text (`#E35D4F`) on a `bg-candle-down/30` tint (Dark
  Bronze-Red, `#8B3A2B`) with a down arrow (`-$56.11 ↓ 7.8%`). `#8B3A2B` is
  only ever the tint or a fill: as text it's 2.55:1 on canvas, below the
  4.5:1 minimum.
- Never green, and never color alone: every change has a sign and an arrow.

### Type

The market caps on the mobile board's cards and King of the Bull card are
JetBrains Mono 700 (`font-mono font-bold`). That one face is declared inside the phone media query in
`index.css`, so desktop's semibold mono labels keep matching the 500 face.

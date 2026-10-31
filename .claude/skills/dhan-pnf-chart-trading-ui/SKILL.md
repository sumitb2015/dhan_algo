---
name: dhan-pnf-chart-trading-ui
description: Use when changing how the Point & Figure page looks and behaves as an order-placing terminal — the B / S rail beside the price axis, hover chips and order handles, the REAL-money banner / lock / confirms / Instant switch, the orders bar and Cancel all, order/position line show-hide and tag alignment, the "This chart" book filter, the floating Style bar, the entry line and P&L chip, the sticky session strip, and remembered per-chart preferences. Records the UI decisions taken on 2026-10-31 and the accessibility / density rules applied; extends dhan-terminal-polish and dhan-a11y-controls rather than replacing them.
---

# P&F chart as an order terminal — UI decisions

Pair with `dhan-pnf-resting-orders` (behaviour) and `dhan-pnf-chart-panel` (chart mechanics). Theme rules still bind: tokens only, `bg-oncolor-dark/NN` scrims, no hex, no slash-opacity on neutral text (CLAUDE.md "Theming"); accent-tint backgrounds/borders are fine.

## The ladder (`RailSvg` in `PnfPanel.tsx`)

Laid out like the XY ladder: **BUY | PRICE | SELL**, `RAIL_SIDE_W = 96` + `RAIL_PRICE_W = 60` + 96 = `RAIL_W` 252 px, sticky beside the price axis (`right: AXIS_W`), on every box row over the whole chart height. A click (pointer-down, not click: the chart's pan captures the pointer) in the BUY or SELL column places an order at that row's price; the PRICE column is not clickable. PRICE names every row (every Nth when rows are < 11 px: `rowsPerLabel`), marks the live price (amber band, green dot, the exact live value) and tints the price of a resting order in its side's colour — that tinted price *is* the price the order was placed at (SL-limit: its trigger). A resting order is a widget in its own side's column: `LMT|SL|TGT|TRL  [−] 1L [+]  [×]` (see `dhan-pnf-resting-orders`); the body drags it to another box. The open position is a blue band across its entry row: `LONG 1L` in its side's column, the entry price in PRICE, the live P&L (`▲ ₹650`, `P&L —` unpriced) in the other column (`pnf-rail-pnl`). Hovering a row shows `BUY LMT` / `BUY SL` in the column that would place it. Index charts have no ladder; the locked REAL ladder shows `LOCKED` and dims. Widgets live in their own `<g data-testid="pnf-rail-order">`: its bounding box is the drag handle the e2e aims at, so nothing else may be drawn inside it. Verify visually with a Playwright screenshot (a temporary test that places orders in the mocked ledger and clips around `pnf-rail`; the Chrome tool froze on this 3200 px page): `e2e/straddle-pnf-rail.spec.ts` has the mocks.
## REAL-money cues — always visible, hard to miss

- **Red page border + `LIVE REAL MONEY` badge** whenever mode is REAL.
- Switching to REAL **asks first** (confirm); the rail starts **LOCKED** and a `LOCKED / UNLOCKED` toggle must be pressed before clicks place anything.
- Placing the first REAL order asks once per page load (`realAskedRef`), naming side/kind/price and — for a straddle — that it is page-held and needs the tab open.
- **Moving or cancelling a REAL broker order asks first**; a per-chart **Instant** switch skips the question — default off, **never remembered**, reset on any mode change. Keep that: a remembered "don't ask" is how a wrong-account order gets placed.
- PAPER orders are labelled `[PAPER]`; a REAL fill from a level is `estimate` until Positions confirms.

## Orders bar, lines, books

- **Orders bar above each chart** lists the chart's resting orders with `×` per row and **Cancel all (Shift+C)** — works from the focused chart region (`onKeyDown`, only when a working order exists).
- Toolbar beside the zoom buttons (same `ZoomButton`, `aria-pressed`): **Squeeze / Stretch columns** (horizontal zoom, also Shift + wheel; see `dhan-pnf-chart-panel`), hide/show **order and position lines** (the orders bar keeps listing them), align tags **left/right** (remembered per chart), triangle toggles, marker toggle. Hiding lines must never hide the orders bar.
- Docked books get a **This chart** filter narrowing positions / orders / trades to the active chart's contracts — rows carry the broker key (`PositionRow.key` = Dhan security id, else trading symbol).
- **Entry line + P&L chip** (`d43fcd5f`): dotted entry line with side, lots, entry premium and P&L, and a chip on the rail at the entry row with an **arrow** (not colour alone). `—` (null), not 0, for an unpriced leg.
- **Style bar** (Single | Bracket | Cover + target / SL / trail points + `MtmGuardCard`) **floats over the chart's top padding** so it costs no chart height. Number boxes are drafts committed on blur / Enter (`dhan-commit-on-blur`); `PtsBox` resyncs from props with the render-time `seen` pattern, not an effect.

## Sticky session strip (non-equity)

`686aa0a9`: day labels moved out of the scrolling plot into a **zero-height sticky strip** (`sticky top-0 z-20 h-0 pointer-events-none`, `data-testid="pnf-session-strip"`) so they stay visible when the chart scrolls vertically while still scrolling sideways with the columns. Equity charts hide it (`sessionLines`, see `dhan-pnf-chart-panel`).

## Preferences

Per-chart prefs live in `localStorage` under `straddle-pnf-*` keys (`LINES_SHOWN_KEY`, `TAG_LEFT_KEY`, `TRI_SHOW_KEY`, `TRI_MIN_KEY`, `STYLE_KEY`, `MARKERS_SHOWN_KEY`, guard levels). Rules that held up: read **after mount** (no `localStorage` on the server render — `useEffect` seeds state, never a `useState` initialiser); wrap every read/write in try/catch (`readPref` / `savePref`); validate the parsed value (`n >= 3 && n <= 6`) and fall back; **never write storage inside a state updater** (review finding on the levels toggle); safety state (REAL, Instant, guard ON, lock) is deliberately **not** persisted.

## Density and accessibility applied

AUTO controls enlarged to 11 px / `h-6`; focus rings (`focus-visible:ring-2 focus-visible:ring-violet-500/60`) on new inputs and buttons; icon buttons have `aria-label`; the P&L chip carries an arrow; stop/limit handles distinguishable by shape, not only colour. New controls go in the existing toolbar rather than adding a second row — the header was already re-flowed to two rows (`style(pnf)` commit before today) and the trade bar names its chart.

## A feature removed on purpose

CPR / pivot / PDH-PDL lines were added (`a4016b8e`) and removed the same day (`f1b6786e`: "not relevant to P&F charts"), deleting `lib/pnfCpr*` and its toolbar switches and stored preference. Do not re-add price-action levels to a P&F chart without asking; P&F has no time axis.

## Verifying UI changes

`npx tsc --noEmit -p .`, `npx eslint <file>`, the unit tests above, and the e2e specs in `e2e/straddle-pnf*.spec.ts` against the running dashboard (`E2E_PORT=3000`). When a visual change was not looked at in a browser, say so in the hand-off; the user reports regressions from screenshots (empty chart, wrong box, stray lines), so a before/after screenshot request is reasonable for layout work.

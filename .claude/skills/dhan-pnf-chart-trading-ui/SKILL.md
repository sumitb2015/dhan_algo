---
name: dhan-pnf-chart-trading-ui
description: Use when changing how the Point & Figure page looks and behaves as an order-placing terminal — the B / S rail beside the price axis, hover chips and order handles, the REAL-money banner / lock / confirms / Instant switch, the orders bar and Cancel all, order/position line show-hide and tag alignment, the "This chart" book filter, the floating Style bar, the entry line and P&L chip, the sticky session strip, and remembered per-chart preferences. Records the UI decisions taken on 2026-10-31 and the accessibility / density rules applied; extends dhan-terminal-polish and dhan-a11y-controls rather than replacing them.
---

# P&F chart as an order terminal — UI decisions

Pair with `dhan-pnf-resting-orders` (behaviour) and `dhan-pnf-chart-panel` (chart mechanics). Theme rules still bind: tokens only, `bg-oncolor-dark/NN` scrims, no hex, no slash-opacity on neutral text (CLAUDE.md "Theming"); accent-tint backgrounds/borders are fine.

## The rail (`PnfPanel.tsx`, `RAIL_W = 76`)

Sticky beside the price axis (`style={{ right: AXIS_W }}`), a **buy | sell** two-column ladder, visibly tinted. Decisions: no "B / S" letters in cells (the column says it); hovering a row shows a **chip naming the order the click would place** (`LMT` / `SL` + side + price) on the row under the pointer; each resting order is a **lots pill with a grip** you drag to another row (a page order is modified in place); stop handles are **pill-shaped and say `SL`**; order tags sit at the **visible** edge and step aside from the position tag; dragging an order near the chart edge auto-scrolls. Cells carry `aria-label`s (`Buy LIMIT at 1,159.00`, `… (rail locked)`), `aria-disabled` when locked. Clicks on the rail `stopPropagation` so they never start a chart pan. Index charts render no rail.

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

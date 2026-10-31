---
name: dhan-pnf-chart-panel
description: Use when changing the Point & Figure chart UI — components/StraddlePnfPage.tsx, components/straddlePnf/PnfPanel.tsx, SettingsControls.tsx, lib/straddlePnfInterval.ts (intervals / resample), straddlePnfSettings.ts. Covers the equity-only interval list (30m/1h/4h/1d/1w/1M encoded as minutes), calendar resampling, clamping a stale interval, the `sessionLines` switch for stock charts, the column tooltip date rules, horizontal-only zoom (Shift + wheel), horizontal-only zoom (`xScale` / `colW`, Shift + wheel), price-axis drag-to-zoom, and the commit/verify workflow used on this page. For where a stock's bars come from see dhan-pnf-equity-history.
---

# P&F chart panel

## Intervals are minutes, and equity gets more of them

`lib/straddlePnfInterval.ts`:
- `INTERVALS = [1,3,5,15]` (everything); `EQUITY_INTERVALS` adds `30, 60, 240, 1440 (1 d), 10080 (1 w), 43200 (1 M)`. The `Interval` type is the **superset**, so `straddlePnfSettings.ts` parses/persists any of them.
- Always label with `intervalLabel(n)` ("30 min", "4 hr", "1 day"…). Never write `${n}-min` — header, alert log, empty-state text and the e2e header test all use the label.
- `intervalsFor(equity)` feeds the dropdown (`SettingsControls` takes `equity`); `effectiveInterval(interval, equity)` returns 1 when the chosen one is not offered. **Use it wherever the interval is consumed** (model build in `useChartModel`, panel props, header text, `AlertLog`), because a long interval picked on a stock persists in settings after the user switches the chart to an index.
- `resample()`: n < 1440 buckets from the 09:15 open (30/60 give a short final bucket, 240 splits at 13:15, both closed by `sessionCloseMin`). n ≥ 1440 goes to `resampleCalendar()`: IST day / Monday-start week (`(istDay + 3) / 7`, 1970-01-01 was a Thursday) / calendar month, stamped with the bucket's first bar. A bucket is closed once a later one exists; the **last day** also closes when its last minute is `close - 1` (that is why daily-prefix bars sit at 15:29); the last week/month stays forming (dropped unless `keepForming`).
- Tests: `lib/straddlePnfInterval.test.ts` (30/60/240 counts, day/week/month grouping). A 1-week chart on ~100 sessions has few columns — that is the data, not a bug.

## Equity-only presentation: `sessionLines`

A stock column can span many days, so session dividers and the date strip mislead. `PnfPanel` takes `sessionLines` (default `true`); `StraddlePnfPage` passes `target.kind !== 'equity'`. It gates **both** the dashed vertical dividers and the sticky date strip (`data-testid="pnf-session-strip"`). Index / F&O charts keep both. The per-column day number inside the first box of a session was removed everywhere: the old code *skipped the X/O glyph* for that box and drew the number instead, so removing the text alone leaves holes — the glyph builder must draw the normal X/O for every box.

Column tooltip (`Mon 10 Apr 2023 → Mon 17 Apr 2023`): `dateYear()` always adds the year; `timeIfAny()` drops `15:29` (the daily-close stamp); a column that starts and ends on one daily close prints only the date. Real intraday times still show.

## Horizontal-only zoom (column pitch)

The wheel and the − / + buttons zoom **uniformly** (`zoom` scales the square `cell`); there is a second, independent factor `xScale` (`XSCALE_MIN 0.25` – `XSCALE_MAX 4`, in `lib/straddlePnfLayout.ts`) that scales only the **column pitch** `colW = round(cell * xScale)`. `layoutPanel(..., zoom, slack, xScale)` returns `colW` and sizes `colsW`/`offsetX` from it; rows and height stay on `cell`. **Glyphs fill the pitch — no gaps between columns when stretched** (TradingView has none): the half-size is split into `sy = cell * 0.36` (height) and `sx = max(1, colW * 0.36)` (width), so an O becomes an ellipse (`a sx sy`) and an X a wider cross; `stroke` follows `cell`. A glyph that keeps a single `s` leaves visible gaps as soon as `xScale > 1`. In `PnfPanel`, anything that means "the x of column j" uses `xOf(j) = offsetX + j * colW` and centres on `colW / 2` (glyph paths, SMA polyline, signal / exit tags, triangle lines, execution markers, crosshair column index `floor((x - offsetX) / colW)`, the grid pattern's width, the newest-column test rect); anything that means a box height keeps `cell`. A new x-position added with `cell` instead of `colW` looks right at `xScale = 1` and breaks the moment the user stretches — grep for `cell / 2` when adding one.
- **Input:** `Shift + wheel` (`e.deltaY || e.deltaX`: Chrome reports a shifted wheel as `deltaX`) and two `ZoomButton`s (`ChevronsRightLeft` squeeze / `ChevronsLeftRight` stretch). `xZoomBy(factor, anchorX)` keeps the column under the pointer fixed by queueing `pendingRef = { left: L2.offsetX + j * L2.colW - x, top: el.scrollTop }`; the layout effect that applies `pendingRef` depends on `[zoom, xScale, scrollTick]`. `resetView` resets both factors.
- Test: `lib/straddlePnfLayout.test.ts` (xScale changes pitch only; cell, rows, height unchanged). Verify in the browser by reading `data-testid="pnf-newest"`'s `width` (= `colW`) before / after a dispatched `WheelEvent({ shiftKey: true })`.

## Price-axis drag zoom

The sticky right axis `<svg data-testid="pnf-axis-drag">` has its own pointer handlers: down → `stopPropagation()` (otherwise the wrapper starts a pan), `setPointerCapture`, remember `{y, zoom}`; move → `zoomRef.current(Math.exp((startY - clientY) * 0.01) * startZoom / zoomNowRef.current)`. Drag up = zoom in. Two refs matter: `zoomRef` always holds the latest `zoomBy` closure, and `zoomNowRef` the latest zoom — `zoomBy(factor)` multiplies the *current* zoom, so pass a factor relative to it, not an absolute target, or fast drags compound against a stale value. Zoom is clamped to 0.3–6 inside `zoomBy`. Double-click fits (bubbles to the wrapper). It also marks `touchedRef` so the chart stops auto-following the newest column.

## Hiding the VWAP / SMA line

`overlayShown` (page state, `straddle-pnf-overlay-shown`, `'0'` = hidden) is a **display switch only**: `PnfPanel`'s `overlayShown` prop drops the polyline and both legends, while `model.overlay` / `buildConfirmedModel`'s `reference` are still computed — the signals' `belowVwap`, the cover cue and the SMA waiting state read them. An eye button in the Overlay group toggles it; picking VWAP or SMA again shows the line (and stores `'1'`). Never gate the model on it.

**COVER tag:** the green `COVER` label (`exits` from `exitTags`, the first bar of an X column above the VWAP / SMA reference) is a short-side hint from the source video; nothing trades or alerts on it. It is **off by default**, switched by the `Cover tag` button (`coverShown`, `straddle-pnf-cover-shown`, `'1'` = on) and drawn only when `coverShown && exits.length > 0`. Do not wire AUTO or alerts to it without a rule decision.

## Triangles (squeeze) — `lib/pnfTriangle.ts`, guide `docs/PNF_TRIANGLE.md`

A triangle is a maximal run of >= N (3-6, the `△N` button, remembered per chart) columns each **nested** in the previous (`b.low >= a.low`, `b.high <= a.high`, strictly shorter). Entry = one box past the last column's glyph, stop = the opposite trigger, target = vertical count (breakout column boxes x reversal x box). Rules: **triangles are NOT signals** — kept out of `model.signals` because `lib/pnfAuto.ts` maps every signal kind to BUY / SELL, so AUTO would trade them; only confirmed (closed-bar) columns are used so one never repaints; a breakout already on the chart at load or after a settings change does not alert (like every other signal). Not implemented: the video's Adaptive-RSI trend filter and 750-stock scanner.

## Workflow notes for this page

- **Check the index before committing.** `git status` showed a different feature (triangle detection) already *staged* in the same files. Committing with `git add -A` would have swept it into the wrong commit; commit the staged work separately first (or confirm with the user), then add yours. Another actor also commits on `feat/pnf-resting-orders` — re-read `git log` before pushing.
- Verify: `npx tsc --noEmit -p .`, `npx eslint <file>`, `node --test lib/straddlePnf*.test.ts` (model/interval/settings/live), `venv/bin/python tests/test_price_pnf_candles.py`. e2e (`e2e/straddle-pnf*.spec.ts`) needs `E2E_PORT=3000` against the running dashboard (see CLAUDE.md; never start a second `next dev`). Several UI edits here were shipped verified by typecheck/tests only — say so rather than claiming a visual check.
- Order-placing behaviour lives in `dhan-pnf-resting-orders`; UI conventions for the rail / REAL cues in `dhan-pnf-chart-trading-ui`.
- Do not "fix" pre-existing uncommitted edits in the working tree that you did not make; report them.

## Comparing against another charting package

Do not eyeball column counts from a screenshot. Measure it: find the column pitch from colour runs (X and O alternate, ~10 px each at 2393 px wide), map pixel rows to price with two axis labels, extract each column's `dir / bottom / top`, and diff that against `buildConfirmedModel(...).columns` (script pattern: node over the route's JSON with the same `interval`, `boxPct`, `anchorT`). Match the grid first (TradingView's box levels are multiples of the box: 1,176.68 = 92 x 12.79, which is our grid when the anchor is a multiple of the box).

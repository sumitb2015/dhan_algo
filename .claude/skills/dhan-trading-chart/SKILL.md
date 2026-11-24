---
name: dhan-trading-chart
description: Use when building or changing a TradingView-style trading chart in rs_dashboard (lightweight-charts candles with orders and positions drawn on it) - the Index Scalper's ScalperChart, or a new page that wants one - or when a chart's position line, TP / SL line, working-order chip, drag-to-move bracket, price-scale "+" menu, chart hotkeys, indicator values (EMA, Supertrend, VWAP vs TradingView / Dhan's chart), tick-built live candles, session gating, autoscale, or the last-price label looks or behaves wrong. Symptoms: a stop shown as a target, a TP / SL off-screen, a position with no line after reload, a 10x estimated P&L, an off-tick price from the chart, "NIFTY" on another instrument, Supertrend diagonals across the chart, indicator values that differ from TradingView.
---

# Dhan Trading Chart (lightweight-charts + order overlays)

## Overview
A trading chart is two layers: a **lightweight-charts canvas** (candles, indicators, price lines) and **HTML chips
positioned over it** (position, TP / SL, working orders, the "+" menu, the drag ghost). Neither layer knows the
other's state, so every bug here has been one of three things:
- **Canvas and overlay disagree:** a chip with no line, a line off-screen, or a label set once and never updated.
- **Quantity or price units mixed:** lots vs barrels vs units, an index level vs a premium, an off-tick price.
- **A price used where only a live tick is valid:** a REST snapshot, or the previous close.

**Reference implementation:** `rs_dashboard/components/indexScalper/ScalperChart.tsx` (chart and overlays), driven
by `IndexScalperTerminal.tsx` (orders, sizing, SIM book). The pure logic lives in `lib/indexScalper*.ts`, each file
with a `*.test.ts` beside it. Copy from these files rather than starting fresh.

Related skills:
- `dhan-live-chart`: polled series, `update()` throwing, IST time axis, canvas theme hook.
- `dhan-indicators`: the six Supertrend copies.
- `dhan-floating-scalper-window`: one-click panels.
- `dhan-broker-positions` and `dhan-terminal-position-ownership`: exit sizing and ownership.
- `dhan-crudeoil-trading`: MCX units.

## Where each feature lives

| Feature | File / function |
|---|---|
| Chart, candle series, theme, resize | `ScalperChart.tsx`, the `chart lifecycle` and `theme` sections |
| Indicators (EMA, SMA, VWAP, Supertrend, BB, RSI, MACD, ADX), catalog, params | `lib/indexScalperIndicators.ts`: `INDICATOR_CATALOG`, `computeIndicator`, `clampParam` |
| Saved-settings migration | `migrateIndicatorsV1`; localStorage keys `indexScalper.indicators.v1` -> `v2` |
| Live candles from ticks; REST history as backfill | `applyTick`, `mergeHistory` (same file); the terminal's live-bars effect |
| Fast tail update vs full redraw | `tailUnchanged`, `flipsAtLast`, `pointColor`; the chart's `data + indicators` effect |
| Session gate per instrument | `lib/indexScalperSession.ts`: `inMarketSession` (NSE via `nseHolidays`, MCX via `mcxSession`) |
| Position anchor (where a leg is drawn) | `lib/indexScalperPositions.ts`: `legAnchor` |
| TP vs SL classification of a working order | `bracketKind` (same file) |
| Quantity -> lots / contract units | `lib/indexScalperInstrument.ts`: `qtyUnits`, `qtyLots`, `lotUnits`, `pnlMultiplier` |
| Bracket lines, chips, drag, ghost chip | `ScalperChart.tsx`: the `active brackets`, `bracket lines` and `dragging logic` sections, plus the chip JSX |
| Working-order lines and chips | `ScalperChart.tsx`: `regularOrders` and the `open order lines` section |
| Chip vertical layout | the chip-tops effect: `priceToCoordinate` polled every 150 ms, collisions pushed at least 26 px apart |
| Autoscale including overlays | `autoscaleInfoProvider` on the candle series, plus `scaleLevelsRef` |
| Price-scale "+" button and context menu; hotkeys | the `price scale hover` and `context menu events & keyboard shortcuts` sections |
| Placing / moving brackets (SIM and REAL) | `IndexScalperTerminal.tsx`: `onSetBracket`, `onCancelBracket`, `onReversePosition`, `onPlaceChartOrder` |

## Rules (each one fixed a real bug)

### Indicators must match TradingView and the broker's chart, checked against numbers
- **Supertrend:** use `supertrendSeries(..., { pine: true })`. Without the Pine path, NIFTY's flat 15:15-15:27 bars
  made the crossed bands flip on different bars from TradingView (18 of 750 bars, lines up to 266 points apart).
- **EMA:** SMA-seeded `emaSmaSeeded` (like Pine's `ta.ema`).
- **Defaults:** match what the user compares against. Dhan's chart is Supertrend **(10, 2)**, not (10, 3). This was
  pinned against a value read off Dhan's chart (25,405.52 at 23 Nov 15:25). When you change a default, version the
  localStorage key and migrate only untouched defaults (`migrateIndicatorsV1`). Never overwrite a user's own setting.
- **VWAP:** session-anchored hlc3 (`sessionVwap`). An index has no volume, so on an index chart this is an average.
- **Proof:** a "matches TradingView" claim needs a fixture with candles and the broker chart's printed values.
  A visual check is not proof.

### Supertrend is ONE series with a colour per point
- **Why not two series:** with one series per colour plus whitespace, lightweight-charts joins straight across the
  whitespace and draws diagonals through every opposite stretch.
- **How:** one line series. Each point carries its colour, and the point before a flip is transparent. Segments take
  their start point's colour, so this leaves TradingView's gap at the flip.
- **Redraw:** a flip on the forming bar recolours the previous point, so `flipsAtLast` forces a full redraw (on this
  pass and on the next).

### Live candles: ticks build bars, REST is backfill only
- `applyTick` folds every WebSocket tick into the forming bar, keeping its high and low. A 60 s REST poll loses
  intrabar extremes and drops closed bars.
- REST history (`/api/index-scalper/candles`) loads only on an interval or range change, after a hidden tab, or after
  a stale feed. `mergeHistory` joins it with the live bars. History is tagged with its interval, so a switch never
  mixes two intervals.
- **No candles outside the session.** Gate every tick with `inMarketSession(underlying, now)`, never with an NSE-only
  check. MCX runs 09:00 to 23:30 IST during US daylight saving and to 23:55 otherwise; a hard-coded 09:15-15:30 froze
  crude's evening candles. A held-over spot on a holiday must not invent a bar.
- **Fast path:** take it only when nothing but the forming bar moved (`tailUnchanged`, the same signature, and
  `bars.length` equal to n or n + 1). `update()` throws on older data. Catch it, reset `prevRef`, and let the next
  pass do a full `setData`.

### Liveness comes from the feed heartbeat, not from price changes
Staleness comes from the bridge's `feed_at`, which is sent on every push and as a 2 s heartbeat. A quiet minute with
no price change is not stale, but a frozen broker socket inside a running bridge is. Market orders, SIM fills and
SIM closes all require `feedAgeSec !== null && !stale` and a live price from `ltpById`.

### Only live ticks price anything that books or sends
- **Live-only map:** `ltpById` is built from the live bridge chain only. A REST snapshot or `prev_close` may be
  *displayed*, for example in the chain. It must never fill a SIM order, close a SIM leg or feed leg P&L.
- **No fallback in the bridge:** never write `prev_close` into a shared bridge's `ltp` (`live_options_ws.py`). Every
  terminal on that file treats `ltp > 0` as a traded price for stops, guards and P&L. Put display fallbacks in the
  page.
- **SIM fill price:** never take it from the ticket's or contract's display `ltp`.

### Labels set at mount must follow the instrument
The candle series `title` (the last-price label) is set in `createChart`'s effect, which runs once. Re-apply it in an
effect keyed on the name: `candleRef.current?.applyOptions({ title: cName })`. Without this, the label read "NIFTY"
on CRUDEOILM. Apply the same rule to any option given at creation that depends on props.

### Overlays: positions, TP / SL and orders
- **Anchor:** a position line is drawn by `legAnchor`. A **future is anchored at its average price**, because the
  chart *is* that future. Before this, a FUT position opened elsewhere or before a reload anchored at "strike" 0, so it
  lost its line, chip and TP / SL, and every order read as a TP. An option is anchored at the spot recorded when the
  page opened it, else its strike. Gate every chip and P&L calculation on `anchor.level > 0`.
- **TP vs SL:** decide with `bracketKind(orderType, price, anchor, isLong)`. A stop order (SL, SL-M, STOP...) is the SL
  and a limit is the TP. Only an unknown type falls back to which side of the entry it sits. Deciding by side alone
  showed a stop below a long as "TP +3,65,700".
- **Keep overlays in view:** the candle series' `autoscaleInfoProvider` widens the range with `scaleLevelsRef`
  (anchors, TP, SL, order prices). After the levels change, call
  `chart.priceScale('right').applyOptions({ autoScale: true })`. Leave the drag line out, or the scale chases the
  mouse. Without this, a target above the candles sat off-screen and could not be dragged. Note that
  `base.priceRange` can be null.
- **Chip placement:** price lines live on the canvas and chips are absolutely positioned HTML (`right-[84px]`, clear
  of the price axis). Poll `priceToCoordinate` every 150 ms, because zoom, pan and autoscale fire no event. Sort the
  chips by y and push each at least 26 px below the one above.
- **Looks (Dhan / TradingView):**
  - Lines: solid for position (sky), TP (emerald) and SL (rose); the drag line is dashed.
  - TP / SL chip: `TP +9,120 (+2.04%) | 6 Sell Limit | ×` and `SL -900 (-0.25%) | 6 Sell Stop Market | ×`.
  - Position chip: `TP | SL | ⇅ | 6 | +2,640 INR (+0.59%) | ×`.
  - Money: whole rupees with Indian grouping (`inrWhole`).
  - Colours: saturated data colours only (CLAUDE.md theming). Chrome comes from the theme hook (`dhan-live-chart` §5).

### Estimated P&L and order size use the broker's own quantity unit
- **Leg unit:** a leg's `netQty` is in the broker's unit. Dhan MCX counts **lots**; Kotak and SIM count **contract
  units** (10 barrels per CRUDEOILM lot, 65 per NIFTY lot). `leg.mult` carries the conversion.
  - Contract units = `qtyUnits(netQty, leg.mult)`.
  - Lots = `qtyLots(underlying, netQty, leg.mult, lotSize)`. It returns null for a part lot or an unknown lot size.
    **Never round a quantity into a bigger order.**
- **Order-book unit:** working-order quantities use the same unit, so pass
  `orderQtyMult = real ? pnlMultiplier(underlying, broker) : 1` to the chart.
- **The bug this prevents:** `lots = |netQty|` was correct for Dhan crude but sized a Kotak 2-lot (20-barrel) TP / SL
  as 20 lots. When filled, that flips +2 lots into -18. The per-order lot cap (20 x 10 = 200) did not catch it.
- **Estimated P&L:** point move x contract units, and % against the anchor. The chip shows exactly what the bracket
  would book.

### Dragging a bracket
- **Start:** `startDrag(kind, leg, anchor, isLong, lots, units, startPrice)` stores the drag state, then window
  `mousemove` / `mouseup` listeners take over, so the drag survives the cursor leaving the chip.
- **While dragging:** snap every move to the **instrument's tick** (CRUDEOILM future ₹1, NSE options ₹0.05). The ghost
  chip shows the live estimated profit or loss, and the dashed drag line moves with it.
- **On release:**
  - Write a **tentative** bracket (`tentativeBrackets`), so the chip stays while the order book catches up. The
    order book wins once it shows the order.
  - Then call `onSetBracket`. On REAL that cancels the existing bracket order of the same kind (same side; a limit
    for TP, a stop for SL) and places the new one: a LIMIT for TP, an SL-M for SL, sized by `qtyLots` and
    `source: 'isx'`.
  - On SIM it stores the level, and an effect exits the paper leg when the live price crosses it.
- **Reverse:** close, then open the other side. SIM opens the other side only if the close succeeded, otherwise
  "reverse" would double the position. REAL sends 2x the position's lots at market.

### Price-scale "+" menu and hotkeys
- **Hover:** within the price axis band, show a "+" at the snapped price (use the instrument's tick, never a
  hard-coded 0.05; crude once offered 7,505.17).
- **Click:** opens a menu with Buy/Sell Limit or Stop, chosen by which side of the last price it is, plus "Add order on
  … at …" (opens the ticket) and "Draw horizontal line".
- **Hotkeys:** active only while the menu is open: Shift+B, Shift+S, Shift+T, Alt+H, Esc.
- **Real-money check:** every order from the chart still goes through the terminal's `placeContract`, with its cap,
  live-price, session and lot-size checks. The chart never calls an order route itself.

### Open gap: brackets on option legs
The chart plots the underlying (the index, or crude's future). A TP / SL dragged on an **option** leg is an underlying
level, but the order is placed on the option's **premium**, and SIM compares it with the premium. Until brackets on
option legs are converted (delta-based or premium-axis), do not offer them, or label them as underlying-level
alerts. Futures legs are exact.

## Adding a new instrument or overlay: checklist
1. Add its spec to `INSTRUMENTS` (segment, tick, strike step, candle segment / instrument).
2. Set `lotUnits` and `pnlMultiplier` for every broker, and add a `qtyLots` unit test per broker.
3. Add its session to `inMarketSession`, with a test that covers the evening or holiday edge.
4. Decide the anchor rule (`legAnchor`) and the TP / SL rule (`bracketKind`), and add both to `lib/indexScalper.test.ts`.
5. Add the instrument's tick to the hover "+", the drag snap and the order ticket.
6. Make sure its overlay prices are in `scaleLevelsRef`.
7. If a label or option is set at chart creation, re-apply it in an effect.

## Verifying a chart change
- **Unit tests:** `node --test lib/indexScalper*.test.ts` and `npx tsc --noEmit -p .` from `rs_dashboard/`.
- **Is :3000 a dev server?** `ps -ef | grep "next (dev|start)"`. When it is `next start` (a **production build**), it
  never shows source edits, and an e2e run against it tests the old build. Run Playwright on its own dev server
  (default `E2E_PORT` 3100, `PW_CHROMIUM_PATH=/usr/bin/google-chrome`). `next start` does not use `.next/dev`, so the
  two do not collide. Afterwards, kill a leftover :3100 by its pid and remove `rs_dashboard/.next/dev`.
- **Screenshot harness:** copy `mockCrudeApi` from `e2e/index-scalper-crude.spec.ts` into a throwaway spec.
  1. Give it a REAL position (e.g. `CRUDEOILM-18Dec2026-FUT`, netQty 6, buyAvg 6110, `exchangeSegment: 'MCX_COMM'`)
     and open orders: a `LIMIT` sell above (TP) and a `STOP_LOSS_MARKET` sell below with `triggerPrice` (SL).
  2. Mock `DELETE /api/scalper/orders` and `/api/scalper/fast-order`. Anything else that is not a GET gets 599.
  3. Arm REAL, screenshot, and log `getByTestId('position-chip' | 'tp-chip' | 'sl-chip' | 'order-chip')` texts.
  4. Drag the SL chip with `page.mouse` (down, move in steps, up) and assert the cancel plus the new SL-M body
     (quantity in the broker's unit, trigger on the tick).
  5. Delete the spec afterwards.
- **Baseline before claiming no regressions:** when e2e specs already fail, run them on the parent commit too
  (`git stash`, `git checkout <base> -- <paths>`, run, restore). Then report which failures are new.

## Common mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Anchor a future at its strike | No position line or chip after a reload; every order shows as a TP | `legAnchor`: future -> avg |
| Classify TP / SL by side only | A stop shows as "TP +3,65,700 (+0.00%)" | `bracketKind` by order type |
| Overlay prices not in autoscale | TP off-screen, cannot drag | `autoscaleInfoProvider` + `scaleLevelsRef` |
| `title` only in `createChart` | "NIFTY" label on crude | `applyOptions({ title })` effect |
| `lots = abs(netQty)` | 10x orders / P&L on Kotak and SIM | `qtyLots(…, leg.mult, …)` |
| Hard-coded 0.05 tick | Off-tick limit from the "+" menu or a drag | the instrument's tick |
| Two Supertrend series with whitespace | Diagonals across the chart | One series, colour per point |
| NSE-only session check | Crude evening candles frozen | `inMarketSession(underlying, …)` |
| Fill from a snapshot or `prev_close` | Paper fills at stale prices | live-only `ltpById` + `feedAgeSec` |
| e2e against `next start` | "Unchanged" results after edits | dev server on :3100 |

---
name: dhan-trading-chart
description: Use when building or changing a TradingView-style trading chart in rs_dashboard (lightweight-charts candles with orders and positions drawn on it) - the Index Scalper's ScalperChart, or a new page that wants one - or when a chart's position line, TP / SL line, working-order chip, drag-to-move bracket, price-scale "+" menu, chart hotkeys, indicator values (EMA, Supertrend, VWAP vs TradingView / Dhan's chart), tick-built live candles, session gating, autoscale, or the last-price label looks or behaves wrong. Symptoms: a VWAP that differs from Dhan's on a future or option, a stop shown as a target, a TP / SL off-screen, a position with no line after reload, a 10x estimated P&L, an off-tick price from the chart, "NIFTY" on another instrument, Supertrend diagonals across the chart, indicator values that differ from TradingView, OI bars or labels piling up, a change-in-OI bar of zero where there is no baseline, Quick Trade chips out of line or showing a dash on an untraded strike.
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
- `dhan-index-scalper`: the terminal around this chart (SIM/REAL, Dhan/Kotak order paths, exits, account panel).
- `dhan-broker-positions`: broker payloads and exit sizing.
- `dhan-crudeoil-trading`: MCX units.

## Where each feature lives

| Feature | File / function |
|---|---|
| Chart, candle series, theme, resize | `ScalperChart.tsx`, the `chart lifecycle` and `theme` sections |
| Indicators (EMA, EMA Cross, SMA, VWAP, Supertrend, BB, CPR, Pivot S1-S4 / R1-R4, RSI, Stochastic RSI, MACD, ADX), catalog, params | `lib/indexScalperIndicators.ts`: `INDICATOR_CATALOG`, `computeIndicator`, `clampParam`; daily levels via `prevDayHlc`, `pivotLevels`, `dayBreaks` |
| Saved-settings migration | `migrateIndicatorsV1`; localStorage keys `indexScalper.indicators.v1` -> `v2` |
| Live candles from ticks; REST history as backfill | `applyTick`, `mergeHistory` (same file); the terminal's live-bars effect |
| Fast tail update vs full redraw | `tailUnchanged`, `flipsAtLast`, `pointColor`; the chart's `data + indicators` effect |
| Session gate per instrument | `lib/indexScalperSession.ts`: `inMarketSession` (index candles: NSE cash to 15:30), `inOrderSession` (orders, paper fills, option premium candles: NSE F&O to 15:40, the close auction); NSE via `nseHolidays`, MCX via `mcxSession` |
| Position anchor (where a leg is drawn) | `lib/indexScalperPositions.ts`: `legAnchor` |
| TP vs SL classification of a working order | `bracketKind` (same file) |
| Quantity -> lots / contract units | `lib/indexScalperInstrument.ts`: `qtyUnits`, `qtyLots`, `lotUnits`, `pnlMultiplier` |
| Bracket lines, chips, drag, ghost chip | `ScalperChart.tsx`: the `active brackets`, `bracket lines` and `dragging logic` sections, plus the chip JSX |
| Working-order lines and chips | `ScalperChart.tsx`: `regularOrders` and the `open order lines` section; drag (`ordDrag`, chip or the `order-line-handle` strip on the line) and lots / price editor (`OrderEditPopover.tsx`), rules in `lib/indexScalperOrderEdit.ts`, sent by the terminal's `onModifyOrder` |
| Chip vertical layout | the chip-tops effect: `priceToCoordinate` polled every 150 ms, collisions pushed at least 26 px apart |
| Autoscale including overlays | `autoscaleInfoProvider` on the candle series, plus `scaleLevelsRef` |
| Price-scale "+" button and context menu; hotkeys | the `price scale hover` and `context menu events & keyboard shortcuts` sections |
| 1 / 2 chart layout, per-pane instrument + timeframe | `ChartPane.tsx` (pane header, filters, contract binding); layout + panes in `indexScalper.layout.v1` |
| What a pane plots; which legs / orders / TP-SL belong on it | `lib/indexScalperChartSource.ts`: `resolveSource` (strike pinned once resolved, ATM fallback), `legOnChart`, `bracketsOnChart`, `orderOnChart` (by `OrderRowView.securityId`, `isOption`) |
| Quick Trade (live C / P chips on every strike in view, Buy / Sell in one click) | `QuickStrikeOverlay.tsx` over underlying panes; pure rules `lib/indexScalperQuickTrade.ts` (`visibleStrikeRows`, `clampQuickSettings`); header switch, off by default |
| Call / Put OI profile (Total or Chg) | `lib/indexScalperOiProfile.ts` (`oiProfileKey`, label placement, `fmtOI`); one overlay canvas in `ScalperChart.tsx`; header OI switch + Total / Chg |
| Per-pane candles (underlying or one option's premium) | `useChartBars.ts`; route `candles?kind=option&securityId=` (NSE_FNO/OPTIDX, MCX_COMM/OPTFUT) |
| Placing / moving brackets (SIM and REAL) | `IndexScalperTerminal.tsx`: `onSetBracket`, `onCancelBracket`, `onReversePosition`, `onPlaceChartOrder` |

## Rules (each one fixed a real bug)

### Indicators must match TradingView and the broker's chart, checked against numbers
- **Supertrend:** use `supertrendSeries(..., { pine: true })`. Without the Pine path, NIFTY's flat 15:15-15:27 bars
  made the crossed bands flip on different bars from TradingView (18 of 750 bars, lines up to 266 points apart).
- **EMA:** SMA-seeded `emaSmaSeeded` (like Pine's `ta.ema`).
- **Defaults:** match what the user compares against. Dhan's chart is Supertrend **(10, 2)**, not (10, 3). This was
  pinned against a value read off Dhan's chart (25,405.52 at 23 Nov 15:25). When you change a default, version the
  localStorage key and migrate only untouched defaults (`migrateIndicatorsV1`). Never overwrite a user's own setting.
- **Line width** is a per-indicator setting (`IndicatorInstance.width`, 1-4 px; Auto = each line's own default: 2 on the
  price pane, 3 for a coloured Supertrend, 1 for Bollinger / daily levels and in an oscillator pane). `computeIndicator`
  applies it to every line, never a histogram; it is part of the series signature so a change rebuilds the series.
- **EMA Cross:** two `emaSmaSeeded` lines (9 / 20) and circles where they cross (`crosses`: Pine `ta.crossover` /
  `ta.crossunder`, so touching then moving on is a cross). Circles ride on the fast series as `OutSeries.markers`, drawn by
  lightweight-charts' `createSeriesMarkers` at `atPriceMiddle` between the lines, green up / red down; re-sent only
  when the list changes (`markerSigRef`). A cross on the forming bar comes and goes until the bar closes, as on TradingView.
- **Bollinger Bands:** `bollinger` = SMA basis +/- mult x the POPULATION stdev (Pine `ta.stdev`, divides by N); matched a
  pandas ddof=0 reference to 1e-9. `pandas_ta.bbands` divides by N - 1 (wider bands): not the reference. Drawn at 1 px
  (bands in the indicator colour, basis orange) like TradingView; at the 2 px default they crowded the candles.
- **Stochastic RSI:** the shared `stochRsiArray` (lib/indicators.ts, also Signal Orb's): TradingView's K = SMA(stoch(RSI),
  K), D = SMA(K, D), defaults K 3 / D 3 / RSI 14 / Stoch 14, 20 / 80 guides; a flat RSI window is null, as in Pine.
  Matched `pandas_ta.stochrsi` on 1,843 NIFTY daily bars (last K / D equal to 1e-13; max 0.075 in the RSI warm-up).
- **VWAP:** session-anchored hlc3 (`sessionVwap`), **volume-weighted** when bars carry `v` (a future, an option), as
  Dhan's / TradingView's chart; equal-weight on the index (no volume). Volume comes from the candle script (`v` per
  bar; never for IDX_I: Dhan's index "volume" is a pseudo figure) and, live, from the day's cumulative volume
  (`feed.volumeById`: chain options, the bridge's `future.volume`) turned into per-bar increases in `useChartBars`
  (`applyTick`'s `volDelta`; `mergeHistory` keeps the larger of history / ticks for the forming bar, never the sum).
  Equal weight put CRUDEOILM's VWAP at 7503.01 vs Dhan's 7513.11 (2026-11-25); weighted it matched to the paisa.
- **Proof:** a "matches TradingView" claim needs a fixture with candles and the broker chart's printed values.
  A visual check is not proof.

### Daily levels (CPR, pivots) step at the day change, with no slanted joins
- **Source:** levels come from the previous IST day that has bars (`prevDayHlc`; a weekend or holiday is skipped),
  using TradingView "Pivot Points Standard", Traditional (`pivotLevels`).
  - P = (H+L+C)/3, BC = (H+L)/2, TC = 2P-BC (TC is shown as the upper of the two).
  - R1/S1 = 2P-L / 2P-H; R2/S2 = P±(H-L); R3/S3 = 2P+(H-2L) / 2P-(2H-L); R4/S4 = 3P+(H-3L) / 3P-(3H-L).
  - The first day of the history has none (null).
- **Close basis:** C is the last intraday bar's close. A daily candle's official close (NIFTY's 15:30 closing price)
  can differ slightly, so check against the broker chart before treating a level as exact.
- **Day breaks:** lightweight-charts joins across whitespace, so each day's last point is transparent (`breaks`,
  honoured by `pointColor`). `flipsAtLast` treats "the last bar opened a new day" as a flip, so the tail path re-sends
  just that series once per day. A new day-based indicator must set `breaks` too.
- **Line width:** levels are drawn at width 1 (`lineWidth` on the series). They take part in autoscale, as on
  TradingView, so R4/S4 widen the price range. Fewer `levels` keeps the candles larger.

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
- **Bars are anchored to the session open** (`barAnchorSec`: NSE 09:15, MCX 09:00), in `applyTick` and in the
  backend's resample alike. From midnight a 30 m / 1 h bar would start at 09:00 / 09:30 while the history's start at
  09:15; 1/3/5/15 m are the same either way. A new interval must be added to `Interval`, `INTERVALS`, `validPane`,
  the candles route's list and the script's `SUPPORTED` / `FETCH`.
- **Two NSE closes.** The index (cash) stops at 15:30; F&O trades to **15:40** (SEBI close auction, same clock as
  `optionsPricing.ts`). Orders / `feed.marketOpen` and option premium candles use `inOrderSession`; index candles use
  `inMarketSession`. Orders cut at 15:30 used to refuse trades the exchange still takes (fixed 2026-11-25).
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
- **Which orders are a leg's TP / SL:** only closing-side orders on the leg's OWN contract, matched by `securityId`
  (`activeBrackets`). A symbol-text match made an entry Buy Limit beside a long read as its TP, and dragging it re-placed
  the entry as an exit sized to the position (fixed 2026-11-25). Every other order is a plain chip.
- **Editing a working order** (plain chip): only this page's own (`isEditable`: `own`, open, LIMIT / STOP_LOSS /
  STOP_LOSS_MARKET). **Click to select first** (line thickens, a round grip appears; Esc / a click elsewhere
  deselects), then drag the grip or the line (12 px hit strip): a Limit moves its price, an SL-M its trigger, an SL-limit both by the
  same amount (`movedLevels`); Esc cancels a drag. The lots / price popover commits only on Modify / Enter. Checked
  against the live price like a new order (`orderEditError`: a Buy Limit above it fills at once, a stop on the wrong
  side triggers at once), lots 1..20 and none on a part-filled order (`editLotsError`). REAL only.
- **TP vs SL:** decide with `bracketKind(orderType, price, anchor, isLong)`. A stop order (SL, SL-M, STOP...) is the SL
  and a limit is the TP. Only an unknown type falls back to which side of the entry it sits. Deciding by side alone
  showed a stop below a long as "TP +3,65,700".
- **Keep overlays in view:** the candle series' `autoscaleInfoProvider` widens the range with `scaleLevelsRef`
  (anchors, TP, SL, order prices). After the levels change, re-apply `autoScale: true` **only if the scale is still
  auto-scaling** (`priceScale('right').options().autoScale`). Leave the drag line out, or the scale chases the mouse.
  Without the re-apply, a target above the candles sat off-screen and could not be dragged; forcing it
  unconditionally reset the user's hand-scaled axis on every new trade (fixed 2026-11-25, e2e "a new trade keeps a
  price axis the user scaled by hand").
- **Reset scale** (header button, `Scaling` icon): bumps `resetSeq` -> the chart turns price auto-scale back on and
  re-frames time on the chosen range (else `fitContent`), like a fresh instrument. It is the way back after a hand zoom.
  A click is consumed even if the chart is not created yet; a pending one would otherwise fire on the next range click.
- **% TP / SL rounds AWAY from entry** (`snapAway`: ceil above, floor below) and a level equal to entry is refused;
  nearest-tick rounding put 10% of a 0.20 premium on 0.20. Typed values are plain decimals only (`Number("1e3")` is
  1000, `Number("0x10")` is 16). Note that
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

### Quick Trade (Upstox Chart 360 style)
- **Off by default**: off, the overlay is not mounted and option legs keep the entry-spot anchor. On, option legs are
  drawn on their strike line (`legAnchor(..., { atStrike: true })`) next to that strike's chips.
- **Overlays read the chart's geometry, they do not re-render it.** `ScalperChart` fills `viewportRef`
  (`priceToY`, `plotWidth`, `plotHeight`); the overlay polls it every 150 ms and re-renders itself on price pushes.
  Passing live premiums as chart props would re-render the memoised chart on every tick.
- **Live prices trade; previous close only displays** (`47cbbaa6`): a chip prices from `ltpById`. A strike with no
  trade on the live feed (LTP 0, common on deep-ITM CRUDEOILM) shows the chain's last price, else its previous
  close, **dimmed and marked not live**, and its
  Buy / Sell stay disabled with the reason until a live tick arrives. No price at all shows `—`.
- **Strikes shown:** only ATM ± n (setting "Strikes around ATM (±)", 1..50, default 10; `clampQuickSettings`), and of
  those every strike in view, thinned by doubling steps from ATM when closer than 24 px (ATM always kept).
- **Fixed-width columns** (`908a8e17`): strike label, C/P badge and premium have fixed widths (premium right-aligned) and
  all rows share ONE right edge, so a wide position chip moves the whole ladder instead of knocking one row out of line.
- **Orders** go through the terminal's `onTradeContract` -> `placeContract` (lot cap, session, live price, broker routing,
  `isx`), market, at once; one order per click (overlay latch + `oneClickBusyRef`). Lots per click come from a select
  (Buy and Sell separately), never a typed box (`dhan-commit-on-blur`).
- **Placement**: chips sit `CHIPS_RIGHT` (430 px) from the right, clear of the OI bars and a plain position chip, pulled
  right on a narrow pane so they never leave the plot. A row holding a position measures that chip (it grows with TP /
  SL badges) and sits just left of it.
- **Trade control**: a click on a chip shows two small B / S buttons, opening to the LEFT of the chip (on the right a
  strike's position chip covered them, so a straddle's second leg could not be traded), lots and any refusal reason in
  the tooltip, not a panel.
- **Per-leg chips** (`b752a099`): each leg is independent, even CE and PE on one strike, labelled "S CE 25350" /
  "B PE 25350" with - / + around its lot count. The step is the Quick Trade setting "Lots per + / −" (`stepLots`,
  1..20, default 1, read through a ref at click time). "+" = step lots more through the one-click path; "-" =
  `lotsToRemove(step, held)` off through the exit path (fresh broker read, any owner, Kotak freeze slices / unknown
  hold; see `dhan-index-scalper`): never the last lot, so it is disabled at one lot (Exit closes the leg). SIM fills
  the same lots the other way. Buttons are named "More lots CE 25350" / "Fewer lots CE 25350" (e2e relies on them).
- **Target / stop on a strike position** (`PremiumBracketControls.tsx`, rules `lib/indexScalperPremiumBrackets.ts`):
  typed on the position chip, never dragged on the index axis: a PREMIUM ("245.50") or a % of the ENTRY (average)
  premium ending in "%" ("20%"; `parseBracketInput`: a long's target above entry / stop below, a short's the other way;
  converted to a premium on the tick before Set, so REAL still sends a plain LIMIT / SL-M price). Validated against the LIVE premium (a long's
  target above it, stop below; a short's the other way; none without a live premium) and the option tick
  (`INSTRUMENTS[u].optTick`, not the chart's), then sent through `onSetBracket` (REAL: LIMIT / SL-M on that contract,
  isx; SIM: the paper watcher on `leg.ltp`). Badges read SIM levels or this contract's working orders by security id;
  × cancels; a click on the badge re-opens the editor prefilled with that level (Set replaces this page's order:
  cancel + place; the same level sends nothing). Those orders are not drawn as lines on the index axis.
- **Option P&L on the index chart** comes from premiums (`legPremiumPnl`), "—" without a live premium. It used to fall
  back to index points x units, and its % was an index-point ratio.

### OI profile (Call / Put OI at each strike)
- **Display only**, on the index / future pane, never on an option premium pane. Calls red above the strike level,
  Puts green below, one shared scale, the largest of each side highlighted. Source: the live chain, else Dhan's
  snapshot.
- **One overlay canvas, repainted only when OI or the view geometry changes**; the chart re-renders only when
  `oiProfileKey` changes. Ticks that move no OI cost nothing (`f2c35c97`).
- **Change mode is exact from the previous-day OI** (`62a52113`): the bridge emits `prev_oi` (additive field) and the
  REST snapshot passes `previous_oi`. `oi_chg_pct` 0.0 cannot tell "no change" from "no baseline", so a strike with no
  baseline gets **no bar, never a zero**; a bridge started before `prev_oi` existed is read from a non-zero
  `oi_chg_pct` only, and the pane says when no previous-day OI exists. Added OI = filled bar, shed OI = outline.
- **Labels by priority** (`b752a099`): largest Call / Put first, then by OI; a label that would touch another is
  dropped, so zoomed out they do not pile up.

### Price-scale "+" menu and hotkeys
- **Hover:** within the price axis band, show a "+" at the snapped price (use the instrument's tick, never a
  hard-coded 0.05; crude once offered 7,505.17).
- **Click:** opens a menu with Buy/Sell Limit or Stop, chosen by which side of the last price it is, plus "Add order on
  … at …" (opens the ticket) and "Draw horizontal line".
- **Hotkeys:** active only while the menu is open: Shift+B, Shift+S, Shift+T, Alt+H, Esc.
- **Real-money check:** every order from the chart still goes through the terminal's `placeContract`, with its cap,
  live-price, session and lot-size checks. The chart never calls an order route itself.

### Brackets on option legs live on the option's own premium chart
A pane plots the underlying or ONE option's premium (`ChartPane`, `premium` prop on `ScalperChart`). On an option pane
the leg is anchored at its average premium (`legAnchor(..., { premium: true })`), and TP / SL / order chips / the "+"
menu are premium levels on that contract: exact. On the underlying pane an option leg keeps its line and P&L chip but
gets **no** TP / SL handles (`canBracket`), and option orders are not drawn there (`orderOnChart`), because an index
level and a premium are different axes. The SIM bracket watcher compares `leg.ltp` only, never spot. Replacing a
REAL bracket cancels only an order on the same `securityId`.
- Each pane has its own drawings key (`indexScalper.drawings.v1:<securityId>` for an option) and is remounted
  (`key`) when its contract changes, since drawings are read at mount.
- A strike outside the bridge's 35-strike window gets REST history but no live ticks ("no live ticks" note); market
  orders on it refuse in `placeContract` as before.

## Performance: what keeps the chart smooth
The page receives bridge pushes at 20-40 Hz. `useLiveOptionsWS` coalesces them to at most one React update per frame,
so the page itself re-renders on every frame that has a push. Everything below keeps that cheap.
- **Memoised chart:** `ScalperChart` is `memo(...)`. Every prop the page passes is a state value, a memo, or a
  `useCallback`; never an inline arrow. One inline arrow or one object rebuilt per push re-renders the whole chart on
  every push.
- **Keep `legs` stable:** `ltpById` is a new Map on each push. `legs` keeps its identity through `legsKey` (memo on
  the key). A push that moves no held leg then changes nothing on the chart.
- **No prices in identity objects:** `chartContract` is keyed on contract identity (id, symbol, expiry, broker). With
  the live LTP inside it, every callback built from it changed on every push. Orders price from `ltpById` and the
  ticket from `ticketLtp`.
- **Order callbacks read the position size through `legsRef`**, not a `legs` dependency, so P&L ticks don't rebuild
  `placeContract` and everything above it.
- **Supertrend flips cost one series:** while the forming bar stays flipped, the tail path still runs. Only the
  coloured series is re-sent, and only when the flip state changes (`recolor`). Before this, every tick re-sent all
  13k bars and every indicator for the rest of the bar.
- **Lazy initial state:** `useState(() => …)` for anything that formats a date. A plain
  `useState({ day: istDayKey() })` builds an `Intl` formatter on every render.
- **Costs measured on 13k one-minute bars:** default EMA + Supertrend recompute ≈3.4 ms; all eight indicators ≈16 ms.
  They recompute only when `bars` changes, and `applyTick` returns the same array when a tick doesn't move the bar.
- **Order latency:** click to `fetch` is ≈1-2 ms. Nothing may be awaited before the send. A fresh read belongs only to exits
  (positions; plus Kotak's order book for the unknown-outcome hold).
- **How to measure:**
  - Run a throwaway Playwright spec on the dev server: mock prices moving every 100 ms, 13k bars, a REAL position
    with a TP and an SL.
  - Collect a CDP `Profiler` CPU profile and aggregate self-time by function.
  - Use `long-animation-frame` and `longtask` PerformanceObservers for frame cost. Playwright's `page.clock` fakes
    `requestAnimationFrame` and `performance.now`, so frame intervals timed with rAF are meaningless there.
  - To count renders, log in the component body. In dev Strict Mode every render logs twice: halve the count.
  - To find the prop that defeats a memo, diff the props against the previous render.
  - Result after these fixes, in a 12 s window: long tasks 71 (≈4.8 s) -> 0; long frames 65 (5.3 s) -> 9 (0.5 s),
    0 ms blocking.

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
| Forcing `autoScale: true` when levels change | Hand-scaled axis resets on every trade | re-apply only while `options().autoScale` |
| `title` only in `createChart` | "NIFTY" label on crude | `applyOptions({ title })` effect |
| `lots = abs(netQty)` | 10x orders / P&L on Kotak and SIM | `qtyLots(…, leg.mult, …)` |
| Hard-coded 0.05 tick | Off-tick limit from the "+" menu or a drag | the instrument's tick |
| Two Supertrend series with whitespace | Diagonals across the chart | One series, colour per point |
| NSE-only session check | Crude evening candles frozen | `inMarketSession(underlying, …)` |
| Fill from a snapshot or `prev_close` | Paper fills at stale prices | live-only `ltpById` + `feedAgeSec` |
| e2e against `next start` | "Unchanged" results after edits | dev server on :3100 |
| OI change drawn from `oi_chg_pct` alone | Zero bars on strikes with no baseline | `prev_oi`; no baseline -> no bar |
| Quick Trade row widths vary with content | One strike's chips out of line | fixed-width columns, one shared right edge |
| A chart callback depending on a feed-built function (`kotakPrice` rebuilds with `ltpById`) | Drag handler restarted on every push; a drag released after a tick sent nothing | read such values through refs; keep a drag's price in a ref, not an effect local |
| A price-line map not cleared on chart teardown | No line under an order chip after the chart is re-created (every dev mount) | clear it (and any drag line ref) in the chart effect's cleanup |
| Inline arrow / price-bearing object as a chart prop | Chart re-renders on every feed push | `useCallback`, identity-only memo, `legsKey` |
| Full redraw while the forming bar stays flipped | Long tasks on every tick after a Supertrend flip | `recolor`: re-send only the coloured series |

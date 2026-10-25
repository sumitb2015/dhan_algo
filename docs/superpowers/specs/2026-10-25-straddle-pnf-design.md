# Straddle Point & Figure page — design

Date: 2026-10-25. Status: draft for review. Scope: the **live page only**; the Simulator is a separate, later cycle that reuses the engine below.

## Purpose
A Scalping-group page that shows three NIFTY straddle Point & Figure charts side by side (ATM-200, ATM, ATM+200), with VWAP / SMA10, double-top-buy and double-bottom-sell markers, audio + visual alerts and a log of the last 30 alerts. It supports the short-straddle method in the Apna Trader video (https://www.youtube.com/watch?v=dsbZbNisx9Q, itself credited to Dr. Shubhendu Ganguly): sell a straddle when a double bottom forms below VWAP; exit when a green X closes above VWAP. **Signals only — the page places no orders.**

## Rules (from the user's brief and the video)
- Straddle price = CE close + PE close per 1-min bar, same strike and expiry.
- Box = 0.5% of the straddle price at the start of the loaded history, fixed thereafter. Reversal = 3 boxes (1.5%). X green (up), O red (down). Columns advance on 1-min closes only.
- Double bottom (sell): a new O column's bottom is below the previous O column's bottom. Double top (buy): a new X column's top is above the previous X column's top. A signal fires once per column, on the bar that prints the breaking box.
- Display-only strategy context: a double bottom while the straddle is below VWAP is flagged "entry zone"; a green X closing above VWAP is tagged "exit". No order logic.
- Strikes: fixed at page load. ATM comes from spot at load ("Auto") or the first-5-minute ATM; offsets are ±200 (NIFTY). A "Re-center" button reloads with a new ATM. No auto-rolling, so each chart is one continuous contract pair and VWAP stays valid.
- Expiry dropdown, max 4: upcoming weekly, next weekly, this monthly, next monthly (deduplicated when the monthly is also a weekly).
- Overlay choice: VWAP (yellow) or SMA10 (light black), one at a time via a toggle. VWAP is volume-weighted over the loaded range; if the straddle has no volume series, the page labels it as the arithmetic cumulative mean and says so.
- History: last 3 sessions of 1-min bars for the same contract, with dotted date dividers on the chart.
- Header: index spot and index-future price (live), DATA chip, expiry dropdown, VWAP/SMA toggle, Re-center, mute, alert-log button.

## Components
1. `rs_dashboard/lib/straddlePnf.ts` (+ `straddlePnf.test.ts`) — pure: `buildPnf(closes, boxPct, reversal)` → columns; `detectSignals(columns)`; `vwap(bars)`, `sma(closes, 10)`; marker/tag derivation. No I/O.
2. `rs_dashboard/app/api/straddle-pnf/route.ts` — GET `underlying`, `expiry`, `atm`: returns the expiry list, spot + futures price, and 3-session 1-min CE/PE/straddle bars for the three strikes. Spawns `scripts/tools/options_straddle_candles.py` through `runPythonJson` (`dedupe`d, one spawn per strike), with the dashboard's rate-limit pacing. Read-only.
3. Live ticks — CE/PE LTP from `debug/live_options_quotes.json` (existing options bridge, started/stopped via the existing bridge route). The current minute's bar is built from ticks; when the bridge file is stale the page falls back to polling the API.
4. `rs_dashboard/app/straddle-pnf/page.tsx` + `components/StraddlePnfPage.tsx`, `components/straddlePnf/*` — three equal SVG panels (X/O glyphs, VWAP/SMA line, signal bars above the last 2 columns, current-value tag), alert-log drawer (last 30, kept in localStorage in try/catch). Follows `dhan-page-theme`, theme tokens (no hardcoded colours) and `dhan-alert-sound`.
5. Sidebar: a new link in the Scalping group of `components/Sidebar.tsx`, plus a `desc`.

## Data flow
Load → API returns expiries, strikes, history → page builds P&F per chart → ticks extend the open minute; on minute close the bar is appended and the engine re-runs. Signals evaluate on closed bars only (no repaint). Each signal gets an id `(strike, column index, kind)` so refreshes never re-alert.

## Alerts
Visual: panel flash + marker bar (green = double top buy, red = double bottom sell) + log row. Audio: chime via `lib/alertSound.ts`, leader tab only, burst-throttled, browser-autoplay unlock on first click, mute toggle. Log keeps the last 30.

## Errors and edge cases
Market closed → last session's data with a "STALE" chip, no alerts for historical bars (alerts only for bars closed after page load). A missing/illiquid leg → per-panel error, no signals for that panel. 429 → existing backoff. Fewer than 3 columns → "building" state. If the box would round to zero → clamp to the strike's tick size.

## Testing
Unit: P&F engine on hand-built price paths (box rounding, 3-box reversal, both signals, no duplicate signals, entry-zone/exit tags, VWAP/SMA values). API route: validation paths only, no live calls. Playwright smoke with mocked `/api/*` (mock lives in the browser, per the repo's e2e rules); run against :3000 with `E2E_PORT=3000`, never a second `next dev`.

## Out of scope / later
Order placement or algo mode, SENSEX, the Simulator (index, start/end date, 1X/50X/100X/200X, seeded with the prior day's chart), auto-roll strikes.

## Open assumptions to confirm during review
- NIFTY only for this cycle.
- Straddle VWAP uses the legs' volume if the candle fetch returns it; otherwise it falls back to the cumulative mean (labelled).
- The page requires an existing Dhan session and the options bridge for sub-minute freshness.

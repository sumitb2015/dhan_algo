# Signal Orb — CRUDEOILM / CRUDEOIL / NIFTY indicator-consensus follower

Dashboard page `/signal-orb`. **Real money in REAL mode.** It has no backtest yet, and these rules have not been checked against history.

## Rules
- **Instrument:** the CRUDEOILM future with the nearest expiry *after* today (IST). A contract is never opened on its expiry day. An open position keeps its own contract until it is closed.
- **Bars:** 1-minute bars from the P&F feed (`usePnfFeed`: history plus the live LTP from the WebSocket bridge), resampled to 1, 3, 5, 15 or 60 minutes on the IST clock. **Only closed bars are read.**
- **Indicators.** Each one votes +1, −1 or 0. A warming-up indicator votes 0.

| Indicator | Default | +1 (bull) | −1 (bear) |
|---|---|---|---|
| EMA (n) | 9 | close > EMA | close < EMA |
| Supertrend | 10, 2 | direction up | direction down |
| EMA cross | 9 / 21 | fast > slow | fast < slow |
| RSI | 14, 55 / 45 | RSI > 55 | RSI < 45 (in between = 0) |
| Stoch RSI | 14, 14, K3, D3, 80 / 20 | K > D and K < 80 | K < D and K > 20 |

  **Matching TradingView.** Every indicator follows TradingView's Pine definitions:
  - EMA is `emaSmaSeeded` (`ta.ema`).
  - RSI is `rsiArray` (`ta.rsi`).
  - Stoch RSI is `stochRsiArray`, matching TradingView's built-in Stoch RSI. A flat RSI window gives na, because Pine's x / 0 is na.
  - Supertrend is `supertrendSeries(..., { pine: true })`, the exact `ta.supertrend`: ATR from `ta.rma(ta.tr(true))` with TR on bar 0 = high − low, a DOWN start, and the flip decided by the previous line's band. That last rule matters when the ratcheted bands **cross** in a flat stretch. The default `supertrendSeries` path (used by Renko, Breakdown Scalper, Algo Lab, Bearish Strikes, RS Strategy) is unchanged and differs there; `lib/indicatorsPine.test.ts` pins both.
  - Bars carry the true high / low through resampling, and sit on the **IST clock**, so hourly bars start 09:00, 10:00, … as TradingView draws MCX.

  **Verified on 2026-11-19:**
  - Against a literal Pine port on 51,981 CRUDEOILM DEC 1-minute bars: the Supertrend line was identical on every bar, and direction from bar 9 (bars 0–8 are warm-up). EMA and RSI were identical (≤ 6e-14 rounding).
  - Against a TradingView screenshot of the 1-hour chart (forming bar O 7820 H 7857 L 7757 C 7780): EMA 9 = 7780.80, EMA 21 = 7786.36, ST(10,2) = 7684.68 up. Both match to the paisa.
  - Stoch RSI differs only in illiquid flat stretches. There the value depends on 1e-14 float rounding, TradingView itself shows na or noise, and the Orb's vote is neutral.
  - The Orb reads only CLOSED bars, so it can differ from a chart's still-forming last bar until that bar closes.
- **VWAP** indicator: close vs TradingView's session VWAP (hlc3 × volume on the chart-timeframe bars, reset each IST day). No volume in the session = no vote ("no volume").
- **Orb colour:** green (BULL) when *every* active indicator votes +1, red (BEAR) when every one votes −1, gray otherwise. With no indicators the orb is gray.
- **Follower** (`decideOrb`, checked in this order):
  1. Cutoff (default 23:00 IST): exit. This runs even with no price; the ledger then books the last price seen.
  2. Hard stop (points from the decision entry): exit. It is skipped while there is no price. A stop-out blocks re-entry on the same side until the colour has been something else.
  3. Only on a closed bar newer than the watermark (one bar acts once): flat + BULL/BEAR enters; opposite colour **reverses**; same colour or gray **holds**.
  4. Entries and reversals only inside the entry window (default 09:15–22:45).
- **Daily loss limit:** when realised plus open P&L reaches it, the page closes the position and the server halts the engine.

## Orders (lib/signalOrbServer.ts)
- The browser sends only `enter` / `exit` / `reverse`, the side and the decision price. The server reads lots, contract and broker from the ledger. It sizes the order from the broker's own lot (`brokerLegs`) and sends through the P&F executor `placePnfMarket(order, 'pnf', 'orba')`. Brokers: Dhan, Kotak and Zerodha. Product: MIS.
- **No lot cap** (user's decision, 2026-11-20): `lots` is any whole number ≥ 1; `orba` has no per-source cap in `lib/dhanSourceCaps.ts` / `lib/kotakOrderRules.ts`, and the Orb's server passes `parsePnfOrder(…, { uncapped: true })` (a function argument, never read from a request body) past the P&F 20-lot cap. Orders above the MCX freeze quantity are rejected by the exchange, not sliced.
- **Symbol:** CRUDEOILM (10 barrels/lot), CRUDEOIL (100) or NIFTY (the master lot, read from the contract, never hard-coded). The indicators always read the symbol's nearest monthly future after today (for NIFTY the future, not the index: the index feed has no volume, which would pin VWAP to neutral). NIFTY options sell the nearest weekly, ATM ± the strike offset. Switching symbol sets that exchange's times: crude 09:15 / 22:45 / 23:00, NIFTY 09:16 / 15:00 / 15:17 (editable afterwards). NIFTY is uncapped like crude (exchange freeze limit only) and refuses entries on a non-session day (`isNseSessionDay`). Product is MIS on every broker.
- **Instrument:** `futures` — BULL long, BEAR short the future. `options` — BULL **sells a PE**, BEAR **sells a CE** on the nearest option expiry after today, ATM ± `strikeOffset` (+N = N strikes OTM: PE down, CE up; −N ITM), picked with Gearbox's `pickTarget()` at the decision future price. A reversal buys the sold option back, then sells the other side at the new strike. The premium is read from Fresh Money's server WebSocket (`lib/freshMoneyWs.ts`); an entry without a live premium is refused before the bar is consumed (it retries next tick); an exit never waits for one (it books the last premium seen, else the entry, and notes it). Symbol, instrument and strike offset are pinned while a row is live.
- **The stop is in FUTURE points** for both instruments (`row.signalEntry`).
- **A reversal is two orders: close, then open.** The open is sent only after the close was placed. If the close outcome is unknown, the engine halts and no second order is sent.
- The row is written (`sending` / `closing`) **before** the order leaves. Outcomes:
  - `placed`: the row becomes open or closed.
  - `rejected`: an entry row becomes failed; an exit row goes back to open and is retried after 5 s. Three rejects in a row halt the engine.
  - `unknown` (no clean reply / 504): the row becomes unknown and the engine halts. You resolve it from the broker book ("It is open" / "Never filled" / "It is closed"). A row still `sending` / `closing` after 90 s (its request died with a server restart) is treated the same way.
- **An exit closes only the Orb's own units** (`exitOwn`), capped by what the broker shows in that direction. A P&F / Renko square-off of the same contract keeps the Orb's units (`reservedByOrb` in `lib/signalOrbFile.ts`).
- **P&L uses the decision price (the LTP when the order was sent), not the broker fill.** Futures: points × barrels per lot × lots; options (always sold): (entry premium − exit premium) × barrels per lot × lots (`rowPnl`). The replay stays in future points in options mode (labelled "fut pts").

## Safety
- SIM is the default. Switching mode always leaves the engine paused. REAL needs a hard stop above 0 and the **Arm real money** click on each page load; the arm is never saved.
- The engine runs only in an open browser tab, and only in the leader tab (localStorage lock). Closing the tab stops entries **and stops**: the broker's MIS square-off is the only backstop.
- A price feed with no new price for 30 s blocks entries, never exits.
- A row from an earlier IST day is not managed automatically.
- Ledger: `debug/signal_orb_state.json`. Writes are op-based and serialised on one in-process chain, with atomic writes and a `rev` bump on every write. The client accepts only a newer `rev`.

## Sounds
`lib/alertSound.ts` synthesises every sound. The page decides when to play one with `lib/signalOrbChime.ts` (`orbAlert`, pure and tested), and a sound only comes from a *change* between two ticks.

| Sound | When | Switch |
|---|---|---|
| Entry: two rising tones | an entry or reversal was placed | speaker (trade chimes) |
| Exit: two falling tones | a position was closed | speaker |
| Buzz | an order was rejected, or its outcome is unknown | speaker |
| Arpeggio up / down / two level tones | the orb turned green / red / gray on a new closed bar, and the engine did NOT trade it | bell (signal alerts) |
| Buzz | the engine halted (including the loss limit), a row needs you (unknown / stuck / an earlier day's), or the feed went stale while auto is on | bell |

- **Which tab rings:** automatic sounds ring in the leader tab only. A manual close rings in the tab that sent it.
- **Switches:** each is saved in its own localStorage key, `signalOrb.tradeSound` / `signalOrb.alertSound`, default on.
- **Autoplay:** browsers keep the page silent until the first click or key press. Until then the header shows "click to enable sound". On-screen messages always show, sound or not.

## Synthetic futures, short straddle and short strangle
Three structures beyond the future and the one sold option. Every leg is its own single-option market order (`lib/orbLegs.ts`); REAL runs on **Dhan or Kotak** (the config refuses Zerodha for these structures; market data and the Focus rules always run on Dhan's feed, only the orders and the fill reads go to the row's broker). Kotak's MCX option legs and fills are unconfirmed against a live order.

- **Synthetic** (signal-driven, like futures): BULL = long synthetic (BUY the ATM CE + SELL the ATM PE, same strike and expiry), BEAR = short synthetic (BUY the PE + SELL the CE). The stop, trail, cutoff and daily loss limit are the future-point ones above; BULL <-> BEAR closes both legs and opens the opposite pair.
- **Straddle / strangle** (NOT signal-driven): a short straddle (ATM CE + PE) or strangle (each `strikeOffset` strikes OTM). The indicators are ignored. They are sold at the entry time (`premium.entryTime`, default 09:20 NIFTY / 09:30 crude) once a day when Auto is on, or with **Enter now**, and managed by the **Ultimate Scalper's own rule functions** (`lib/orbFocus.ts` builds their inputs and calls `lib/focusToolRules.ts`): leg SL x (+ Trail SL every/by/start), SL to cost, leg target %, total SL (% of premium and / or rupees), overall target (% of premium or rupees), the cutoff and the daily loss limit. A leg's SL / target / cost stop closes that leg; the total SL, overall target, cutoff and loss limit close everything.
- **Server-side:** `lib/orbPremiumServer.ts` runs the entry and these rules every 2.5 s with every browser tab closed (started from `instrumentation.node.ts`). Prices come from the server's own WebSocket (`lib/freshMoneyWs.ts`). A row is marked `closing` before an exit is sent; an exit is never resent after an unknown outcome. If an open leg has no live premium for 60 s the page shows a banner, sounds the warning chime and the log notes it: its stops cannot be judged (only the cutoff).
- **Safety:** a REAL run needs a leg SL or a total SL, and a server-side **ARM** for the day (kept in memory: a dashboard restart disarms). A fail-closed funds / margin check (`lib/orbMargin.ts`) runs before any entry with a short leg. A bought leg is confirmed filled before a short is sent; a leg refused after another went in reverses the placed ones; an UNKNOWN leg is flagged on its own (resolve it from the broker book with "It is open / It is closed") while the other leg stays judged.
- **Measure:** the total-SL % and the overall-target % are measured on the legs still open (the Focus Tool's definition), so after one leg stopped they apply to the remaining leg alone; use the rupee total SL to cap the whole loss.
- Not built yet: the overall Trail SL and re-entry (ASAP / OTM / Cost / Momentum). Untested against a live fill.

## Known limits
- The signal-driven structures (futures, one sold option, synthetic) run in the browser engine: there is no server-side stop watcher for them (the straddle / strangle have one, above).
- There is no real backtest. The page shows a **replay** (`replay()` in `lib/signalOrb.ts`) of the last 20 sessions with the current rules: the same `decideOrb`, one decision per closed bar at its close, the stop checked on closes, no costs or slippage. It is a rough flip-rate / direction check.
- **What the replay found with the defaults (EMA 9 + ST 10,2) on the stored CRUDEOILM history, 62 sessions to 2026-11-19, gross:**

  | Timeframe | Orders / day | Points / day | Green days |
  |---|---|---|---|
  | 1m | ~126 | −285 | 9 / 62 |
  | 5m | ~21 | −75 | 18 / 62 |

  Do not run the defaults in REAL without changing them.
- The Zerodha MCX futures quantity is unconfirmed against a live fill (see `lib/pnfOrderServer.ts`).

# Signal Orb — CRUDEOILM indicator-consensus follower

Dashboard page `/signal-orb`. **Real money in REAL mode.** It has no backtest yet, and these rules have not been checked against history.

## Rules
- **Instrument:** the CRUDEOILM future with the nearest expiry *after* today (IST). A contract is never opened on its expiry day. An open position keeps its own contract until it is closed.
- **Bars:** 1-minute bars from the P&F feed (`usePnfFeed`: history plus the live LTP from the WebSocket bridge), resampled to 1, 3 or 5 minutes on the epoch grid (09:00 IST lies on it). **Only closed bars are read.**
- **Indicators.** Each one votes +1, −1 or 0. A warming-up indicator votes 0.

| Indicator | Default | +1 (bull) | −1 (bear) |
|---|---|---|---|
| EMA (n) | 9 | close > EMA | close < EMA |
| Supertrend | 10, 2 | direction up | direction down |
| EMA cross | 9 / 21 | fast > slow | fast < slow |
| RSI | 14, 55 / 45 | RSI > 55 | RSI < 45 (in between = 0) |
| Stoch RSI | 14, 14, K3, D3, 80 / 20 | K > D and K < 80 | K < D and K > 20 |

  EMA is `emaSmaSeeded` (TradingView's seed). Supertrend is `supertrendSeries`, and **it runs on closes only (high = low = close), because the feed has no high or low**, so it will not exactly match a TradingView candle Supertrend. Stoch RSI is `stochRsiArray` in `lib/indicators.ts`.
- **Orb colour:** green (BULL) when *every* active indicator votes +1, red (BEAR) when every one votes −1, gray otherwise. With no indicators the orb is gray.
- **Follower** (`decideOrb`, checked in this order):
  1. Cutoff (default 23:00 IST): exit. This runs even with no price; the ledger then books the last price seen.
  2. Hard stop (points from the decision entry): exit. It is skipped while there is no price. A stop-out blocks re-entry on the same side until the colour has been something else.
  3. Only on a closed bar newer than the watermark (one bar acts once): flat + BULL/BEAR enters; opposite colour **reverses**; same colour or gray **holds**.
  4. Entries and reversals only inside the entry window (default 09:15–22:45).
- **Daily loss limit:** when realised plus open P&L reaches it, the page closes the position and the server halts the engine.

## Orders (lib/signalOrbServer.ts)
- The browser sends only `enter` / `exit` / `reverse`, the side and the decision price. The server reads lots, contract and broker from the ledger. It sizes the order from the broker's own lot (`brokerLegs`) and sends through the P&F executor `placePnfMarket(order, 'pnf', 'orba')`. Brokers: Dhan, Kotak and Zerodha. Product: MIS.
- **One lot per order** (`MAX_ORB_LOTS = 1`, `orba` caps in `lib/dhanPlaceOrder.ts` (MCX) and `lib/kotakOrderRules.ts`) until the page has traded live.
- **A reversal is two orders: close, then open.** The open is sent only after the close was placed. If the close outcome is unknown, the engine halts and no second order is sent.
- The row is written (`sending` / `closing`) **before** the order leaves. Outcomes:
  - `placed`: the row becomes open or closed.
  - `rejected`: an entry row becomes failed; an exit row goes back to open and is retried after 5 s. Three rejects in a row halt the engine.
  - `unknown` (no clean reply / 504): the row becomes unknown and the engine halts. You resolve it from the broker book ("It is open" / "Never filled" / "It is closed"). A row still `sending` / `closing` after 90 s (its request died with a server restart) is treated the same way.
- **An exit closes only the Orb's own units** (`exitOwn`), capped by what the broker shows in that direction. A P&F / Renko square-off of the same contract keeps the Orb's units (`reservedByOrb` in `lib/signalOrbFile.ts`).
- **P&L uses the decision price (the LTP when the order was sent), not the broker fill.** It is points × 10 barrels × lots.

## Safety
- SIM is the default. Switching mode always leaves the engine paused. REAL needs a hard stop above 0 and the **Arm real money** click on each page load; the arm is never saved.
- The engine runs only in an open browser tab, and only in the leader tab (localStorage lock). Closing the tab stops entries **and stops**: the broker's MIS square-off is the only backstop.
- A price feed with no new price for 30 s blocks entries, never exits.
- A row from an earlier IST day is not managed automatically.
- Ledger: `debug/signal_orb_state.json`. Writes are op-based and serialised on one in-process chain, with atomic writes and a `rev` bump on every write. The client accepts only a newer `rev`.

## Known limits
- Browser-only engine: there is no server-side stop watcher.
- Supertrend runs on closes only.
- There is no backtest.
- The Zerodha MCX futures quantity is unconfirmed against a live fill (see `lib/pnfOrderServer.ts`).

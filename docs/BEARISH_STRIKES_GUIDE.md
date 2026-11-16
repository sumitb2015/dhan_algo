# Bearish Strikes guide (`/bearish-strikes`)

User guide for the Bearish Strikes page. Code: `rs_dashboard/components/BearishStrikes.tsx`,
`rs_dashboard/components/bearishStrikes/`, `rs_dashboard/lib/bearish{Strikes,Alerts,Ledger,Risk}.ts`,
`rs_dashboard/app/api/bearish-strikes/`. Positions live in the page's own ledger, `debug/bearish_strikes_state.json`.

Bearish Strikes finds option strikes whose price is falling below three levels at once, Supertrend, VWAP and EMA20,
which makes them candidates to sell short. You then sell, manage and exit those shorts from the same page.
It's a real-money page. SIM (paper) is the default.

## 1. Pick what to scan (top bar)

- **Underlying**: NIFTY, BANKNIFTY, SENSEX or CRUDEOILM. **Expiry** shows days to expiry.
- **Timeframe** (1m / 3m / 5m): the candle size the signals are worked out on.
- **Side**: CE+PE, CE only or PE only.
- **Filters ▾** opens the finer settings. When it's closed, a one-line summary shows what's active.
  - **Below Supertrend / VWAP / EMA20**: the levels a strike must be under. Untick one to ignore it, e.g. EMA20 early
    in the day while it's still warming up.
  - **OI**: Any; SB / LU (short buildup or long unwinding backs the fall); Not LB (hide strikes where long buildup
    disagrees).
  - **OTM only**, **Below day open** (fewer candle downloads), **100s only** (CRUDEOILM).
  - **Min / Max ₹** premium range, **Min OI / volume** in lots.
  - **ATM from … to ±**: which band of strikes around ATM to scan.
  - **Scan max**: the most strikes it fetches candles for.
- **⚙ gear**: Supertrend period and multiplier, and the EMA length. These also drive the alerts and levels.

## 2. Read the table

- **Signal**:
  - **BEARISH**: the last *closed* candle and the live price are both below all three levels. This is the strongest
    read.
  - **WATCH · ST + VWAP…**: the closed candle is bearish, but the live price is back above the named level(s).
  - **2/3** and similar: only some of the conditions hold.
- **Lights** (ST · VW · EMA · OI):
  - Green: below the level, which is good for a short.
  - Red: above it.
  - Amber: the closed candle is below, but the live price has crept back above.
  - Grey: still warming up.
- **OI ✓ SB/LU** means positioning backs the fall. **OI ⚠ LB** means fresh longs disagree. OI labels are measured
  against the previous day.
- **HELD** marks a strike you're already short; pressing SELL there adds to that position.

## 3. SIM vs REAL

- The page always opens in **SIM**: paper trades filled at the live price, and nothing goes to a broker.
- To trade real money:
  1. Pick the account in the **broker box**: Dhan, Kotak or Zerodha.
  2. Click **SIM** and confirm **Arm REAL on …**.
  3. A red **REAL MONEY** strip appears, and the buttons change to **SELL · REAL**.
- REAL lasts only until you reload the page.
- You can't switch broker while armed. Each position always exits on the account it was opened on.

## 4. Sell

Press **SELL** on a row. The ticket shows whether it's SIM or REAL. Choose the lots (at most 50) and MARKET or LIMIT,
then place the order. The server also refuses a Kotak or Zerodha sell above 50 lots.

## 5. Manage positions

Once anything is open, the **Positions** panel moves above the scan table.

**Risk group** (applies to every open short):

- **SL %**: buy back when the premium rises this % above your average sell price.
- **Target %**: buy back when it falls this % below.
- **Trail pts**: once the premium has traded below your entry, the stop sits this many points above the lowest
  premium seen and moves down with it.
- **Max loss ₹** (kill switch): when today's P&L for this mode, open plus closed positions, reaches minus this amount,
  new sells are blocked.
  - **Reset** clears the block, but it fires again at once if you're still past the limit, so raise the limit to keep
    trading.
  - It won't act while any open position has no live price.
- **Auto-exit** (turns red while REAL is armed): when an alert, SL, target, trail or max loss is hit, it buys back at
  MARKET by itself.
  - A resting LIMIT buy-back is cancelled first, then replaced with a MARKET order.
  - It tries up to 3 times per position, then shows **AUTO-EXIT FAILED**.
  - It's off again after a reload.

**Alerts group:**

- Choose which levels to watch (Supertrend / VWAP / EMA20).
- **Live price** warns earliest; **Closed bar** waits for a closed candle and gives fewer false alarms.
- **Sounds** (they start only after your first click anywhere on the page, a browser rule; the toasts always show):
  - **Bell**: alert sounds. A rising three-tone chime when a level alert or the SL / Target / Trail fires; a low buzz
    when max loss is hit or auto-exit gives up.
  - **Speaker**: trade chimes. Two rising tones on a sell fill, two falling tones on a buy-back, a low buzz on a
    rejected or unknown order, or when a position was closed outside the page.
  - With the page open in several tabs, only one tab plays the automatic sounds (the others show "sound: other tab").
- **Desktop** turns on browser notifications.

**Per row:**

- **EXIT** buys back the whole position or some lots, at MARKET or LIMIT.
- The **Watch** column shows how far the price sits from each level.
- An amber **"paused"** means the stops can't act on that row right now: it's on another underlying or expiry, the
  feed is stale, or there's no price.

**Toolbar:**

- **Exit all** buys back every open position in the current mode, after you confirm.
- **Orders · Trades · Positions** shows the selected broker's whole order book, trade book and positions.

## 6. Important limits

- **Stops, alerts, auto-exit and max loss run only while this browser tab is open.** Keep it in its own window,
  because browsers slow down hidden tabs. Nothing protects you if the tab is closed.
- A position is watched only when the page is showing **its underlying and expiry**. Otherwise an amber banner says it
  isn't fully protected.
- A red banner, **"Your short is moving against you"**, appears when an alert fires. Its **EXIT NOW** button opens the
  exit ticket.
- If a sell's reply from the broker is lost, the row shows "entry order working". After about a minute the page looks
  for the order in the broker's order book: on Dhan by the exact tag sent with the order, on Kotak and Zerodha (sells
  only) by symbol and quantity. If it finds the order it tracks it; if not, it warns you to check the order book.
- Exit size always comes from this page's own record, never from the broker's combined position. If the broker shows
  less than the page (closed elsewhere), the page lowers its quantity to match; it never raises it.
- Built for laptops and desktops; phones aren't supported.

## Suggested first use

Stay in SIM. Set SL %, Max loss and Auto-exit, make a few paper sells, and watch the alerts and exits fire. Then arm
REAL with 1 lot.

# Gearbox Drive guide (`/gearbox`)

User guide for the Gearbox Drive page. Code: `rs_dashboard/components/gearbox/`, `rs_dashboard/lib/gearbox*.ts`.
Real-money endpoint — **SIM (paper) is the default.** REAL is Dhan only, 1 lot, and must be armed on every page load.
You decide every trade: the page never trades on its own. The "ghost driver" is only a comparison.

## What it is

The page turns the near-month CRUDEOIL or CRUDEOILM **future** into a driving dashboard (road, gears, lamps). You read it, then click
**↑ Long** or **↓ Short** to buy an **option** on that commodity. The future is only the signal; the option is what you trade.
The signal uses **closed** bars only (1, 3 or 5 minutes, default 5). It needs 200 closed bars before it shows a gear; until then
the page says "Warming up: N / 200" and entries are off.

## Reading the cluster

Everything below is computed on the last **closed** bar.

- **Road and sky** — the *mode*. Blue sky, road climbing: two closes above EMA200 and EMA200 not falling. Dusk, road descending:
  the mirror. **Fog / Neutral**: price within 0.3 ATR of EMA200, or the EMA200 slope disagrees with the side.
- **Gear shifter** — trend strength: 1 plus how many of EMA 9 / 20 / 50 / 100 price is beyond, in the mode's direction (1 to 5).
  N when in fog. Gear 5 is full throttle; gear 1 is a deep pullback, near a reversal.
- **Speed** — slope of EMA9 over 3 bars, in basis points per bar.
- **RPM** — distance from EMA9 in ATRs. Over 2 (the red zone) is over-revving: stretched, partial-profit territory.
- **Altitude** — (close − EMA200) ÷ ATR. **Acceleration** — speed now minus speed 3 bars ago.
- **Lamps**
  - **VWAP** green: close is on the trend's side of the session VWAP (VWAP resets at the MCX open). Red: the wrong side. Off in fog.
  - **Supertrend** green: Supertrend (14, 3) agrees with the mode. Red: it disagrees. Off in fog.
  - **Setup** amber: the gear reached 4–5 and then pulled back to 2–3.
  - **Shift up** (orange, pulsing): the next upshift out of a Setup with VWAP and Supertrend agreeing, inside the entry window, and
    the mode more than 3 bars old. This is the ghost's entry signal. It is a hint, not an order.
  - **Over-rev** red: RPM above 2.
- **Header chips** — `LIVE` / `STALE` (is the futures price fresh), `DATA: date`, the IST clock with the time left to square-off,
  and a bell that rings on Shift up (off by default, rings in one tab only; click the page once after a reload).

## Buttons and hotkeys

| Control | Key | What it does |
|---|---|---|
| ↑ Long | ↑ | Flat: opens the Long leg. Short held: **reverse** (exit, then open Long). Long held: nothing. |
| ↓ Short | ↓ | Mirror of the above. |
| Exit | X | Closes the held leg. |
| Pause (on the scene) | Space | Stops the road animation only. Prices, gears, SL and target keep running. |
| Lots − / + | — | 1 to 10 lots in SIM, **1 in REAL**. Locked while a leg is held. |

- One position per underlying. There is no pyramiding: pressing the same direction again is ignored.
- Hotkeys ignore key repeat (holding ↑ sends one order) and do nothing while a text box or dropdown has focus.
- In REAL every ↑ / ↓ / X asks for a confirmation first, the same as the buttons.
- A **reverse** checks every entry rule *first* (price, strike, option price, limits) and only then sends the exit; it opens
  the new leg only after the exit is confirmed filled. If the exit is rejected, the old leg stays open and nothing new is sent.
  If the exit has no verdict within 10 s, the row goes UNKNOWN and the reverse is abandoned.

## The direction map

The map says which option each button trades. Defaults: **↑ = BUY ATM CE, ↓ = BUY ATM PE.** Per direction you can change
BUY / SELL, CE / PE and the strike offset (3 ITM … ATM … 3 OTM). Expiry is always the **nearest expiry after today**.

- The summary next to each row shows the contract the server would pick right now and its live price.
- **The strike is picked on the server at the click**, from its own fresh price of the future whose expiry matches the option
  expiry. The price on your screen is only recorded, never used to pick or price a fill.
- The map, the underlying and the broker are **locked while a leg is held** (so are mode and lots).
- A SELL leg is a short option: margin and unlimited risk. A map such as "↑ BUY PE" is allowed (it gains when price falls): check it.

## SIM vs REAL

- **SIM** — paper. Fills at the option's live price at the click. Nothing is sent to any broker. Up to 10 lots.
- **REAL** — live Dhan orders, intraday product. **1 lot per order and per position** on both CRUDEOIL and CRUDEOILM, until it
  has run live. Switch with the SIM / REAL toggle (not possible while a leg is held), then press **Arm real money** and confirm.
  The arm is for **this page load only**: it is not saved, and changing mode, underlying or broker disarms it. A reload disarms it.
- REAL is **Dhan only.** Kotak and Zerodha are off in this version (their MCX option units are not confirmed against a live fill).
- REAL P&L is re-priced from the actual traded price once the fill is confirmed. If no fill price comes back in 10 s the entry is
  booked at the option's last price and the log says so.
- The ₹ P&L is points × lots × barrels per lot (CRUDEOIL 100, CRUDEOILM 10).

## What runs with the tab closed

**Only one thing: the square-off.** The dashboard server (not the browser) closes every open Gearbox leg, SIM and REAL, at the MCX
auto-exit time (`mcxSession().autoExit`, shown in the header). It checks every 5 s, uses only this page's own quantity, and runs
whether or not a tab is open. An earlier day's leg that is still open is closed once the next session opens.

It will **not** touch a row whose status is UNKNOWN, SENDING or CLOSING: it logs "square-off skipped" once and leaves it for you.
A REAL exit the broker refuses leaves the row open and is retried on the next 5-second tick.

Nothing else runs on the server: no entries, no stop-loss, no target, no trailing. Stopping or restarting the dashboard stops the
square-off with it.

## SL and target are browser-only

The **SL** and **Target** boxes are in option-premium points (the option's price move against / for the leg; empty = off). They
are watched by **the leader browser tab only**, and the page says so: *browser-only — closes nothing if this tab is closed.*
They pause when the option price is stale. When one fires it sends a normal exit, **in REAL without the confirmation prompt**,
and retries every 5 s if it fails. Boxes commit on blur or Enter, never per keystroke; Escape reverts.

If you close the tab or the browser sleeps, an open REAL leg has **no stop** until the square-off time. Do not rely on SL/target
for a leg you walk away from.

## Daily limits

Optional, blank = off, set in the risk bar. Counted per day, in the current mode (SIM and REAL are counted separately):

- **Max loss / day (₹)** — once today's closed P&L is at or below minus this, new entries are blocked.
- **Max trades / day** — once this many trades have been opened today (open or closed), new entries are blocked.

A block stops entries and the second half of a reverse; **Exit always works.**

## Checks that refuse an order

Nothing is sent when any of these fails, and the page shows the reason. Exits are never refused for a stale price.

- Still warming up (fewer than 200 closed bars), or REAL not armed on this page load, or the feed is stale.
- **The server's futures price is older than 10 s** (or missing), so no strike can be picked.
- **Outside the MCX window**: entries run from the MCX open to the square-off time only; a shut day (holiday) refuses.
- **No live price for the chosen option** yet (try again in a few seconds).
- **The expiry is today**: "nearest" skips an option expiring today, and a hand-picked expiry of today is refused.
- No such strike or expiry in the master list, or the offset runs off the listed strikes.
- Lots over the cap, or a daily limit reached.
- The page is out of date (mode, underlying or broker no longer match the ledger): reload.
- A position already exists and is not OPEN (see below), or the same direction is already held.

## UNKNOWN outcomes

If the broker's reply to an order is unclear, the row goes **UNKNOWN** and the page **never resends it.** Check the Dhan order
book and positions, then choose **It is open**, **Never filled**, or **It is closed (at LTP)**. A new entry is blocked until you do.

## What other pages can and cannot close

Gearbox owns only what it opened (its own file, `debug/gearbox_state.json`). It exits only its own quantity, capped by what
Dhan still shows.

- A **/renko or P&F square-off** on the same strike keeps Gearbox's units: Gearbox's open REAL legs are held back from it.
- A **Price Ladder exit, a scalper exit, Exit All, P&L-exit or any manual trade** on the same contract is **not covered**: Dhan nets
  positions by contract, so one of those can close Gearbox's leg. Gearbox then finds nothing left and books the row closed at its
  last price with the note "closed outside this page". Do not run another terminal on the same strike.
- Gearbox legs show up in other terminals' position lists as ordinary Dhan positions.

## The ghost driver (unvalidated)

The ghost follows the rules mechanically on the future and keeps its own score, in **futures points on paper, with no costs or
slippage**. It never places an order. **The rules have not been validated by any backtest** and the page labels them so. Its rules:

1. Setup arms when the gear reached 4–5, then drops to 2–3.
2. Entry on the next upshift if VWAP and Supertrend agree, the mode is more than 3 bars old, and the bar is inside the entry window
   (15 min after the MCX open until 40 min before the square-off).
3. Stop: the tighter of the 10-bar swing and Supertrend, trailed with Supertrend at gears 4–5; tested on the bar's low / high.
4. Exit on stop, mode flip, gear collapsing to 1, or the session square-off. Fog does **not** exit.

Treat "You vs Ghost" as a comparison, not as evidence the rules make money.

## After pulling an update

The dashboard runs `next start`, a production build. After pulling a change that adds or changes Gearbox:
**rebuild and restart the dashboard.** Until then `/gearbox` does not exist and the **square-off loop is not running**, so an open
Gearbox leg would not be closed at the auto-exit. Check the server log for `[gearbox-squareoff] watcher started`.

## Files

- Ledger: `debug/gearbox_state.json` (one writer, the dashboard server; the page only names the action). Order tag `gbx`.
- Maths: `lib/gearbox.ts`. Order path: `lib/gearboxCore.ts` / `lib/gearboxServer.ts`. Square-off: `lib/gearboxSquareOffCore.ts`,
  started from `instrumentation.node.ts`.

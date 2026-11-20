# Gearbox Drive guide (`/gearbox`)

User guide for the Gearbox Drive page. Code: `rs_dashboard/components/gearbox/`, `rs_dashboard/lib/gearbox*.ts`.
Real-money endpoint — **SIM (paper) is the default.** REAL is Dhan only, 1 lot, and must be armed on every page load.
You decide every trade: the page never trades on its own. The "ghost driver" is only a comparison.

## What it is

The page turns the near-month CRUDEOIL or CRUDEOILM **future** into a driving dashboard (road, gears, lamps). You read it, then click
**↑ Long** or **↓ Short** to trade an **option** on that commodity, or the **future itself** (a FUT leg, see below). The direction
map decides which.
The signal uses **closed** bars only: 1, 3 or 5 minutes (default 5), or 5, 10, 20 or 30 seconds (see "Bar size"). It needs 200
closed bars before it shows a gear; until then the page says "Warming up: N / 200" and entries are off.

## Reading the cluster

Everything below is computed on the last **closed** bar.

- **Road and sky** — the *mode*. Blue sky, road climbing: two closes above EMA200 and EMA200 not falling. Dusk, road descending:
  the mirror. **Fog / Neutral**: price within 0.3 ATR of EMA200, or the EMA200 slope disagrees with the side.
- **Warming up** — until 200 closed bars exist the cluster shows only a progress bar ("Warming up the engine"): no gear, gauges
  or lamps, and entries are off.
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

## Bar size (minutes or seconds)

The bar-size picker in the header offers **5s, 10s, 20s, 30s** and **1m, 3m, 5m**. It is locked while a leg is held.

- **Minute bars** come from Dhan's 1-minute history plus the live feed, so they are ready as soon as the page loads.
- **Seconds bars** are built from the price bridge's **tick log** (`debug/pnf_ticks/`, the same log `/renko` uses). The bridge
  samples the future every **0.5 s**, so nothing faster than that is seen. Dhan has no history below one minute, so seconds bars
  exist only from when the log started recording today: they **warm up from the MCX open each day** (200 closed 10-sec bars is
  about 33 minutes after the open). Until 200 have closed the page shows "Warming up" and entries are off, also after you switch
  from minutes to seconds mid-session if the log has little in it.
- A tick bar holds only the last price in its bucket: **open = high = low = close**. So **ATR on seconds bars is close-to-close**
  (it has no bar range), and the stop the ghost tests on a bar's low / high is tested on its close.
- Picking a seconds bar shows **more trades and whipsaws**: the gearbox reads the same rules on much noisier bars, so the gear
  and the mode flip far more often. Gears, lamps and the ghost still act only on closed bars. The ghost's entry window stays in
  minutes (15 min after the open to 40 min before the square-off).

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
- In REAL every ↑ / ↓ / X asks for a confirmation first, the same as the buttons. While an order is in flight the buttons and
  hotkeys are off, so no second confirmation can pop up.
- A **reverse** checks every entry rule *first* (price, strike, option price, limits) and only then sends the exit; it opens
  the new leg only after the exit is confirmed filled. If the exit is rejected, the old leg stays open and nothing new is sent.
  If the exit has no verdict within 10 s, the row goes UNKNOWN and the reverse is abandoned. After the exit fills, the new leg's
  strike is **picked again from the price at that moment** (and every entry check runs again); if the futures price has gone
  stale by then, the reverse stops flat (the log says "reverse stopped: stale price").

## The direction map

The map says what each button trades. Defaults: **↑ = BUY ATM CE, ↓ = BUY ATM PE.** Per direction you can change
BUY / SELL, CE / PE / **FUT**, the strike offset (3 ITM … ATM … 3 OTM) and the expiry: **Nearest** (the first expiry after today,
never one expiring today) or any listed later expiry. A FUT leg has no strike or expiry to pick, so those two boxes are hidden.

- The summary next to each row shows the contract the server would pick right now and its live price.
- **The strike is picked on the server at the click**, from its own fresh price of the future whose expiry matches the option
  expiry. The price on your screen is only recorded, never used to pick or price a fill.
- The map, the underlying and the broker are **locked while a leg is held** (so are mode and lots).
- A SELL leg is a short option or a short future: the map marks it **margin, unlimited risk**. A leg that gains on the other
  direction's move (↑ with a PE BUY, a CE SELL or a **FUT SELL**; ↓ with a CE BUY, a PE SELL or a **FUT BUY**) is allowed but gets
  a **⚠ gains on a fall / rise** mark: check it. The usual futures map is ↑ = BUY FUT, ↓ = SELL FUT.

## Trading the future (FUT legs)

Pick **FUT** in a direction's CE / PE box and that button trades the **signal future itself**: the same contract that drives the
road (the first CRUDEOIL / CRUDEOILM future expiring on or after the nearest option expiry, never one expiring today). The summary
reads e.g. **BUY FUT CRUDEOILM DEC** with the future's live price.

- Same caps as options: **REAL is Dhan only, 1 lot**; SIM up to 10 lots. One CRUDEOIL lot is 100 barrels (about ₹100 per point),
  one CRUDEOILM lot 10 barrels (about ₹10 per point).
- An open needs the **server's futures price no older than 10 s**; in SIM the fill is that price. Otherwise nothing is sent.
- **SELL FUT** is a short future: it needs margin and its loss has no limit while the price rises.
- **SL / Target** on a FUT leg are in **futures points** (on an option leg they are premium points).
- P&L = points × lots × barrels per lot, the same as an option leg. Exits close only Gearbox's own units, the square-off closes FUT
  rows too, and an unclear reply goes UNKNOWN and is never resent, exactly as for options.

## SIM vs REAL

- **SIM** — paper. Fills at the option's live price at the click (refused if that price is more than 10 s old). Nothing is sent to any broker. Up to 10 lots.
- **REAL** — live Dhan orders, intraday product. **1 lot per order and per position** on both CRUDEOIL and CRUDEOILM, until it
  has run live. Switch with the SIM / REAL toggle (not possible while a leg is held), then press **Arm real money** and confirm.
  The arm is for **this page load only**: it is not saved, and changing mode, underlying or broker disarms it. A reload disarms it.
- REAL is **Dhan only.** Kotak and Zerodha are off in this version (their MCX option units are not confirmed against a live fill).
- REAL P&L is re-priced from the actual traded price once the fill is confirmed. If no fill price comes back in 10 s the entry is
  booked at the option's last price and the log says so.
- The ₹ P&L is points × lots × barrels per lot (CRUDEOIL 100, CRUDEOILM 10), for options and FUT legs alike.

## What runs with the tab closed

**One thing trades: the square-off.** (One more job only records prices, see the end of this section.) The dashboard server (not the browser) closes every open Gearbox leg, SIM and REAL, at the MCX
auto-exit time (`mcxSession().autoExit`, shown in the header). It checks every 5 s, uses only this page's own quantity, and runs
whether or not a tab is open. An earlier day's leg that is still open is closed once the next session opens.

It will **not** touch a row whose status is UNKNOWN: it logs "square-off skipped" once and leaves it for you.
A REAL exit the broker refuses leaves the row open and is retried at most **3 times a day, at least 30 s apart**, and never at or
after the MCX close. After the 3rd refusal the row goes UNKNOWN ("square-off failed 3 times"): close it at Dhan and resolve it.
While any leg is live the server also keeps its contract's price (the option, or the future of a FUT leg) subscribed, so a SIM
square-off with every tab closed uses a fresh price, not the last one a tab saw.

**Recording the future for seconds bars** (`lib/gearboxAlwaysRecord.ts`, read-only, no orders): from the MCX open to the MCX close
the server asks the price bridge, every second, for the configured underlying's signal future and for the future of any live FUT
row, so the tick log has the whole session even with every tab closed. Outside the session (and on an MCX holiday) it asks for
nothing. It does not run when the dashboard is started with `DASHBOARD_NO_BACKGROUND=1`.

Nothing else runs on the server: no entries, no stop-loss, no target, no trailing. Stopping or restarting the dashboard stops the
square-off and the recording with it (seconds bars then have a gap and warm up again).

## SL and target are browser-only

The **SL** and **Target** boxes are in points of the held contract (the option's premium, or the future's price for a FUT leg;
the move against / for the leg; empty = off). They
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
- **No live price for the chosen option** yet (try again in a few seconds). A FUT leg's price is the futures price checked above.
- **The expiry is today**: "nearest" skips an option expiring today, and a hand-picked expiry of today is refused.
- No such strike or expiry in the master list, or the offset runs off the listed strikes.
- Lots over the cap, or a daily limit reached.
- The page is out of date (mode, underlying or broker no longer match the ledger): reload.
- A position already exists and is not OPEN (see below), or the same direction is already held.

## UNKNOWN outcomes

If the broker's reply to an order is unclear, the row goes **UNKNOWN** and the page **never resends it.** Also UNKNOWN:

- A row still SENDING or CLOSING when the next server action starts (the dashboard restarted, or the send threw, mid-order). Its
  note says "orphaned by a restart — check the order book".
- An exit that finds nothing at Dhan within 60 s of the entry fill (or of the entry, when its fill was never confirmed): too soon
  to trust "already closed".

Check the Dhan order book and positions, then choose **It is open**, **Never filled**, or **It is closed (at LTP)**. A new entry is blocked until you do.

## A damaged ledger file

If `debug/gearbox_state.json` exists but is not valid JSON, the server refuses every trade, setting and resolve with
"gearbox ledger unreadable — fix debug/gearbox_state.json" and **never writes the file** (so nothing on it is lost). The
square-off does not run until it is fixed. A row in the file that is missing its status, contract or size is ignored.

## What other pages can and cannot close

Gearbox owns only what it opened (its own file, `debug/gearbox_state.json`). It exits only its own quantity, capped by what
Dhan still shows.

- A **/renko or P&F square-off** on the same option strike **or the same future** keeps Gearbox's units: Gearbox's open REAL
  legs (options and FUT) are held back from it. Signal Orb exits only its own units, so it never takes Gearbox's either.
- A **Price Ladder exit, a scalper exit, Exit All, P&L-exit or any manual trade** on the same contract is **not covered**: Dhan nets
  positions by contract, so one of those can close Gearbox's leg (option or future). Gearbox then finds nothing left and books the row closed at its
  last price with the note "closed outside this page". Do not run another terminal on the same strike or future.
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
- Maths: `lib/gearbox.ts`. Bars: `lib/gearboxBars.ts` (minute and seconds). Order path: `lib/gearboxCore.ts` / `lib/gearboxServer.ts`.
  Square-off: `lib/gearboxSquareOffCore.ts`; seconds-bar recording: `lib/gearboxAlwaysRecord.ts`; both started from
  `instrumentation.node.ts`.

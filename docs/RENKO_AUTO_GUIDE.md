# Renko AUTO trading (`/renko`) - user guide

How the Renko page's automatic trading works: what it trades, when it enters and exits, how it sends orders, what protects a position
(the MTM guard and the server-side watcher), and what is still unproven. The strategy spec and ledger rules live in
[`strategies/pnf_auto/strategy.md`](../strategies/pnf_auto/strategy.md); the code map is at the end.

> **Status.** UNVALIDATED. There is no backtest or replay of these rules. Several broker paths (Kotak / Zerodha MCX quantity units, the
> server watcher) have not been confirmed against live fills. Start in PAPER, then one lot REAL. See [Known limits](#9-known-limits).

---

## 1. Quick start

1. Open `/renko`. Pick the instrument for chart 1 (and optionally chart 2): a future or an option. An index cannot be traded.
2. Set the **Box** (brick size, in points) and **Confirm** (N, the number of bricks a signal waits for).
3. Choose the **broker** and **PAPER / REAL** (page-wide). A page always opens in PAPER; switching to REAL asks for confirmation.
4. In the chart's **AUTO** controls choose the **rule** (see section 2) and the **lots** (`L` stepper).
5. Click **AUTO**. In REAL the first click turns the button red (`ARM REAL AUTO?`); click again within 6 s.
6. Arming does **not** switch the MTM guard on (section 6): it stays OFF until you open the MTM Guard card, set the levels (a chart with
   nothing saved shows 10 boxes target / 10 boxes stop) and click **Switch on**. In REAL a toast reminds you it is off. Without it N-brick, trend
   and Supertrend have **no loss limit** (only the end-of-day exit).
7. Leave the tab open (section 7 explains what keeps working if you do not).

While AUTO is armed or holds a position, the rule, lots, instrument and box are locked. To change them, stop AUTO (and close its
position) first.

**AUTO survives a reload.** The switch is saved with the AUTO ledger, so a reload, a dashboard rebuild or a second tab of the page puts
it back on (a toast says *AUTO resumed on chart N*) as long as it is the same day, the chart shows the same contract and the page is on
the same broker and mode. The page always opens in PAPER, so a REAL arming waits — the AUTO status reads *AUTO not resumed: … switch the
page to REAL to resume* — and comes back on by itself once you switch the page to REAL. A stop, a halt, the MTM guard or the server guard
switches AUTO off in every open tab, and the AUTO log says why (*AUTO switched off: …*).

An open AUTO position on a chart whose AUTO is off shows **AUTO OFF · exit only**: it still exits by its rule, but nothing re-enters after
it (before 2026-11-04 a reload did this silently — an exit with no re-entry). For that reason, stopping **REAL** AUTO while it holds a
position takes a second click: the first turns the button amber (`STOP AUTO? no re-entry`); click again within 6 s. Stopping never
closes the position (use **Exit** for that).

## 2. The rules

Pick one per chart from the dropdown next to AUTO. A chart starts on **Supertrend** (the choice is then remembered per chart; the dropdown is locked only while AUTO is armed). A "brick" is one Renko column; a run is consecutive bricks of one colour.

| Rule | Enters | Exits |
|---|---|---|
| **N-brick** | BUY / SELL on the Nth brick after a colour change (once per run). The chart's first run never signals. Mid-run, it waits for the next reversal. | First brick of the opposite colour after the entry. No stop. |
| **N-brick (trend)** | On **every** brick that completes N same-colour bricks, so with N = 1 the next brick of the run you are in. Arming mid-run enters on the next brick. | First opposite brick, and that brick is also an entry for the other side (N = 1): the chart **flips** straight into the new direction. No stop. |
| **Two-back** | 3+ bricks, a 2-brick pullback, then the run resumes and a brick makes it 3 long and closes past the swing. | A stop one brick beyond the pullback, checked against the **live price** every second (by the tab, and by the server for a REAL row). With no fresh price, a closed brick beyond the stop exits at that brick's close. No opposite-brick exit and no target. |
| **One-back** | 2+ bricks, a 1-brick pullback, then 2 resuming bricks that break the swing. | The same kind of stop. |
| **Supertrend** | BUY on a **green** brick while the Supertrend line is up, SELL on a **red** brick while it is down (the line's direction on the chart's ATR period x multiplier, the `ST` control). A brick of the other colour never enters: armed SELL-side while the line is down, a green pullback brick is skipped and the next red brick enters. Arming mid-run enters on the next brick of the right colour. | The first brick after the entry whose Supertrend direction is against the position (the line flips), and that brick is also the entry for the other side: the chart **flips**. No stop. |

N-brick, N-brick (trend) and Supertrend carry **no stop of their own**: the MTM guard is their loss limit. Two consecutive S (or B) markers on the
chart under the trend rule are a flip: the first is the exit of the old position, the second the entry of the new one.

**Side.** Next to the rule, **Buy + Sell** (default) / **Buy only** / **Sell only** limits what AUTO may *open*; a signal for the other side is ignored (a buy-only chart stays flat through a sell phase and enters on the next buy). The AUTO status line says `SELL signal ignored (Buy only)` while it holds one back (logged once per change of direction), and arming logs and toasts the side. Exits are never filtered: an open position always exits by its own rule, MTM guard or end of day. The choice is remembered per chart and locked only while AUTO is armed. On options, "Sell" means selling the option.

## 3. When it enters

- **Closed bars only.** A brick exists only after its 1-minute bar has closed, so a signal can never repaint. The order goes out about
  one second after the bar closes. If the price runs several boxes inside the minute, AUTO does not enter until the bar closes.
  On the **Tick** interval (below) every recorded price is a closed bar, so this becomes "about one to two seconds after the brick prints".
- **Arming ignores history.** Everything already on the chart when you arm is skipped; the first qualifying brick formed afterwards counts.
- **Fresh signals only.** The signal must be on the newest closed bar and less than 3 minutes old. A missed signal is never chased.
- **Product (MIS / NRML).** Picked per chart beside the lots box, locked while armed or holding a position, and saved with the arm and on
  the row. **MIS** (default) squares off NSE at 15:15; **NRML** squares off NSE at **15:35** (F&O trades until 15:40), entries until 15:25. On
  a chart whose market closes earlier, NRML squares off 5 minutes before that close. MCX is the same for both. A stock is always MIS. Adds and
  exits use the row's own product, never the switch's current setting. The switch's tooltip shows today's cutoff and square-off for the chart.
  NRML has no broker square-off behind it: the server retries a refused end-of-day exit every 10 s until the close (it never stands down
  then), and a position still open from an earlier day is never exited by AUTO. It raises a red alert on the page and in the AUTO log
  instead, so close it at the broker and resolve it.
- **Session.** Only during the market session and before the entry cutoff: **NSE 15:05** for MIS (10 minutes before the 15:15 exit; 15:25 for NRML; a stock in the closing auction session 15:00), **MCX 10 minutes before the market close** = 23:45 on a 23:55 close (23:20 on a 23:30 close), the same minute as the MCX square-off, so a trade taken in the last minute is squared off at once.
  Holidays and weekends count as closed.
- **Feed.** Needs a live price and a fresh feed. A stale feed pauses entries.
- **Refusals.** Three refused entries in a row halt the chart.
- **One direction per contract (REAL).** A REAL entry is refused while the other chart holds a REAL position on the opposite side of the
  same contract on the same broker: the broker nets the two, so each exit would open a position the other owns. The entry is retried
  while the signal is fresh, then logged as missed. The same side is allowed (each chart exits only its own units).
- **Nothing sent yet.** If an entry fails before any order goes out (the contract lookup has not answered, the ledger is unreachable for a
  moment - a dashboard restart), it is retried every second while the signal is still the newest closed bar's; a signal that ages out that
  way is logged as `missed the … signal`.

### Tick and 10 / 20 / 30 sec intervals (live-price bricks)

Pick **Tick**, **10 sec**, **20 sec** or **30 sec** in the Interval list (Renko only). Bricks then come from the live price itself, not from 1-minute closes:

- **What it reads.** The price bridge (`scripts/tools/pnf_ws.py`) logs every price change it sees, sampled every 0.5 s, to
  `debug/pnf_ticks/<date>/<SEG>_<id>.jsonl`. The page reads that log every second. It is not every exchange trade: a spike that reverses
  inside half a second can be missed.
- **Bricks are permanent.** A brick prints the moment a price crosses the box and never disappears, unlike the provisional bricks of the
  running minute on the 1 min interval. A reload or a second tab draws the same bricks from the log.
- **Alerts and AUTO act at once.** Entries, the opposite-brick exit and `+1L/brick` adds all fire on the brick, about 1-2 s after the
  price (the log is served 0.4 s behind, the page polls each second). Expect more trades and whipsaws than on a minute chart; arming warns once.
- **Before the log.** Ticks exist only from when the bridge started asking for the instrument. The stretch before that is drawn from
  the 1-minute closes; from the first logged price on, only logged prices are used, so a later history refresh can never change a
  brick alerts or AUTO already acted on. A bridge outage shows as a jump: bricks catch up on the next logged price. A straddle leg
  that has not changed since logging began uses its last history price until its first logged one.
- **Loading.** Until the first read of the log lands (about a second), the chart has no bars, so a reloaded page with AUTO armed
  cannot act on a minute-close brick the tick chart does not have. A log that keeps failing is shown on the chart.
- **10 sec** groups the same recorded prices into 10-second bars (the bar's last price), and a brick prints when its 10 s are over
  (about 0.5-1.5 s after the boundary, once the log has been served past it). A spike that reverses inside the 10 s prints nothing, so it whipsaws less than Tick and still
  reacts far sooner than 1 min. Same log, same fallback to minute closes.
- **20 sec** and **30 sec** work the same way with 20- and 30-second bars: fewer whipsaws than 10 sec, slower to react.
- **Brick count after a reload.** On an index the 1-minute history is a rolling window whose start (`anchor_t`) moves with the clock, so
  a full rebuild can differ by a few bricks at the far start of the chart (2024). Recent bricks are identical (checked 2026-11-05:
  the last ~101k bricks and all of the day's matched); alerts and AUTO key on bar time, not brick number.
- **Switching** the interval is locked while AUTO is armed or holds a position, as for every setting.
- The bridge must be running the version with the tick log. After updating, restart it once while no AUTO is armed: write
  `debug/pnf_ws_stop.trigger` and an open P&F / Renko page starts the new one within about 30 s (prices pause until then).

## 4. When it exits

In priority order:

1. **End of day.** NSE 15:15 (MIS) or 15:35 (NRML); MCX 10 minutes before the close; a cash stock in the closing auction 5 minutes before the continuous session
   ends. The time is the **position's own market** (saved on the row), never the market of whichever chart is on screen.
2. **Stop** (Two-back / One-back). If the market gaps through, the fill is booked at the gapped price.
3. **Opposite brick** (N-brick and trend).
4. **MTM guard** (section 6).
5. **Exit button** on the AUTO status line. Closes at the live price and switches AUTO off. REAL asks for a second click. It waits for a
   live price and never books an exit at the entry price.

Exits keep running for an open position even when AUTO is switched off.

### Adding lots as the trade moves (`+1L every N bricks`)

Optional, per chart, Renko only: the **`+1L every brick`** switch next to the AUTO lots box. Once on it shows **`+1L every [N] bricks · Max [M] · Trail SL [T] bx`**:
**N** = bricks between adds (default 1, at most 50), **Max** = total lots (default 10, at most 20).
Both are set before arming and locked while AUTO is armed. Saved per chart and on the AUTO arming, so a reload resumes them.

- While a position is open and AUTO is armed, AUTO adds **one lot** when the newest closed bar prints a brick in the position's direction that
  closes **beyond the best brick close since the entry** (a short: a new lower brick; a long: a new higher brick). The entry brick's close is
  the starting level.
- **Every N bricks:** with N above 1 the new best brick must also be at least **N bricks past the last add** (past the entry brick for the
  first add). A short entered on the 100 brick with N = 2 and a 1-point box adds at 98, then at 96, 94 ... A bar that jumps several bricks
  counts all of them, but still adds one lot. N is saved on the row at entry, so changing it later does not affect an open position.
- A pullback that only gets back to a level already reached adds nothing. **At most one lot per bar**, however many bricks it printed.
  Bricks on an older bar (a sleeping tab) are never chased. No adds after the entry cutoff (15:05 NSE) or with a stale feed.
- **Trailing SL after an add (`Trail SL [2] bx`, on by default):** once at least one lot has been added, AUTO exits the whole position
  on the first **closed brick** that is **N boxes back from the best brick since entry** (default 2, 2-20; 2 is the first opposite brick,
  because a Renko reversal is a 2-box move - a saved 1, which behaved the same, now reads as 2). Bricks the entry bar printed after the
  signal brick count toward the best, and toward the first add's starting level. It does not wait for the
  Supertrend to turn, and it is checked before the Supertrend / opposite-brick rule (the end-of-day exit still comes first). The position line
  shows the level once it is active: `LONG 5L (4+1) @ 8340.20 avg … SL 8352.00`. It is set before arming (locked while armed) and saved on the row at entry, so a change only
  affects the next trade. Switch it off with the `Trail SL` button. It runs in the open `/renko` tab, like the Supertrend exit; with the
  tab closed only the server's MTM guard and end-of-day exit protect the position.
- **After a Trail SL exit AUTO does not re-enter the same side on the pullback.** The Supertrend rule signals on every brick while the
  line points one way, so it used to buy straight back on the exit brick. Now a same-side entry waits until a brick closes **beyond the
  best brick** the trailed trade reached (the trend has resumed); the status says `trail exit: BUY waits for a brick beyond 8488.00`.
  The opposite side still enters as soon as its signal comes. The wait also ends when an opposite signal prints after the exit (the trend
  turned, even if `Buy only` / `Sell only` ignored it, so a fresh trend is traded), or at the next trade. Otherwise it lasts the rest of the day
  on that contract. The level is the best brick saved at the exit, so changing the box afterwards does not move it.
- Adds stop at **Max**. The cap is saved on the row at entry, and a new arming can only lower it.
- The position exits as **one**: the exit rule, the MTM guard, the end of day and the Exit button all close every lot (exits send the row's total units).
  The next entry starts again at the base lots.
- The row keeps one **average entry price** over all lots (status line: `SHORT 3L (1+2) @ 99.87 avg`), so its P&L and the MTM guard
  cover the whole position. An add at the market price does not move the MTM. **Box levels of the MTM guard are worth more as lots are added**
  (one box = box size x the current total size).
- PAPER books each add at its brick close. REAL reserves the add (`adding`), sends one lot in the position's direction on the broker the row was
  opened on, then confirms it. The broker's fill replaces the decision price for that lot once read. A refused add waits for the next
  new best brick. An add with an unclear outcome (no reply, a partial fill, or placed units that do not match) halts the chart and is **never resent**:
  check the broker, then click **Add went through**, **Add did not happen** or **Is flat**. While the add is unresolved, its lot's units
  stay reserved (a close from the other chart or page cannot take them), and the page's own exits wait.
- **A stuck add (unresolved for over a minute, e.g. the tab died after reserving it) does not leave the position unprotected.** The server
  guard and end-of-day exit still close it: the confirmed lots plus the pending lot, capped by what the broker actually shows. The close
  records whether the added lot was there. If another AUTO row holds the same contract on that broker, the cap cannot tell the two rows apart,
  so the server only warns and the row waits for you.
- Adds wait for the chart's history to finish loading, and run only when the row's broker is the page's broker. A failure before anything was sent
  is retried up to 3 times on its bar. An add whose order went out is never retried.

## 5. Orders and brokers

- **PAPER** sends nothing and books at the **brick edge** (the brick's close). **REAL** books the **live price** at the decision first, then **replaces it with the broker's average traded price** once the orders are final
  (summed over a straddle's legs; the decision price is kept on the row as `entryDecision` / `exitDecision`) and recomputes the P&L. On a minute that prints
  several bricks REAL is therefore worse than PAPER by the boxes the price moved before the order filled.
- **Brokers.** Dhan, Kotak and Zerodha can trade CRUDEOILM futures from this page. Kotak orders in barrels (10 per lot), Dhan and Zerodha in
  lots. **There is no MCX unit cap.** Kotak is confirmed (a live 1-lot round trip on 2026-11-03: 10 barrels = 1 lot). Zerodha MCX is **not yet confirmed by a live fill** (Kite refused a test order from this machine: no static IP is whitelisted for the app), but a wrong unit cannot over-size an order. The page's own ceiling of 20 lots and Kotak's per-source lot cap (20) still apply. MCX options and NSE
  futures on Zerodha are refused. Prices always come from Dhan.
- **Own units only.** An exit sends only the units AUTO opened (from the ledger), capped by what the broker still shows in that direction.
  A manual trade, or the other chart on the same contract, is never touched. The exit goes to the broker the position was opened on.
- **Resting orders** from the chart rail are separate from AUTO.

### Safety rules (the ledger)

- One live AUTO row per chart. A REAL entry is **reserved before it is sent** (`entering`), an exit likewise (`exiting`). A placed entry
  must match the reserved units leg by leg; anything else becomes `unknownEntry` and halts the chart.
- The ledger keeps the last 500 rows by dropping the oldest **closed** ones; a live row is never dropped.
- An order whose outcome is unknown (no reply, partial) becomes `unknownEntry` / `unknownExit`, halts the chart and is **never resent**.
  Check the broker, then click **Is open** or **Is flat**.
- A reservation older than 60 s (the tab died with the order on the wire) is offered for the same resolution.
- Every change is one operation applied under a file lock and written atomically. When the page and the server both try to exit a row, the
  first to start the exit owns it; the other stands down.

## 6. The MTM guard

One guard per chart, shown in the toolbar (**MTM Guard ON/OFF**) with its card.

- **Levels.** Target, stop-loss, trailing give-back, and Protect profit (a locked floor once MTM reaches a trigger, with optional steps).
  Target and stop-loss are in **rupees or in boxes, not both**: the `₹ Rupees / Boxes` switch picks the unit and only that unit is saved.
  Trailing and Protect profit are always rupees.
- **Boxes.** 10 boxes means a move of 10 x box points on the position. It is converted to rupees as box x lots x rupees-per-point-per-lot
  at the position's current size, and the guard keeps the last known value if it is briefly unreadable. If the box value is never known
  while a position is open, the guard warns once that the box levels are **not** enforced.
- **Defaults.** A chart with nothing saved starts in Boxes with **10 target / 10 stop**. Saved levels always win.
- **Switching on.** Off by default, also while AUTO is armed: switch it on from the card (**Switch on**), for AUTO or for manual trades. Edit the
  levels while it is ON and click **Update**; typed values are not applied until you do. A guard already past a level asks before switching on.
- **Baseline.** Measured from when the guard was switched on. For a PAPER AUTO position it starts from AUTO's **entry price**. A new AUTO
  trade (the trend rule flips within a tick) starts from its own baseline with a fresh best-so-far and locked floor. After a flat reading
  the baseline is dropped (on REAL the book must read flat for 12 s first, so a missed poll cannot erase a drawdown).
- **When it trips.** It cancels the chart's resting orders, then exits AUTO's own position through AUTO (which also **switches AUTO off**, so
  the trend rule cannot re-enter), then anything else on the contract (a manual lot) on the next retry. It retries every 6 s and settles only
  when the book reads **flat**. After settling it **stays ON** and measures the next trade from its own start; the toast says so.
  If what is left on the contract belongs to another AUTO position - the other page's, or this page's **other chart** on the same
  contract - it is kept (the follow-up close sends `guardChart`) and the guard switches off instead. A trade-bar SQUARE OFF still closes
  everything.
- **Refusals.** It will not exit AUTO's row if the row is on a different broker than the page's, and it waits for a live price.
- **Scope.** Switching broker or PAPER/REAL switches the page's guards off. The guard runs in the page: with the tab closed see section 7.

## 7. What runs where

| | Browser tab (the leader tab) | Dashboard server |
|---|---|---|
| Strategy rules, entries | yes | no |
| Opposite-brick / trailing SL exit | yes | no |
| Two-back / One-back stop | yes | **yes, for open REAL AUTO rows** (guard on or off) |
| MTM guard | yes | **yes, for open REAL AUTO rows** |
| End-of-day exit | yes | **yes, for every open REAL AUTO row** (guard on or off) |

The tab does all the trading. If it closes, sleeps or loses its network, **nothing in the left column runs**, and an N-brick position would
sit without a stop. A Two-back / One-back REAL row keeps its stop: the server checks it against the bridge price every 2.5 s and records
the exit as an ordinary `stop` (so an open tab stays armed, as after its own stop exit). To cover that, the dashboard server runs an **exit-only watcher** (`lib/autoServerWatcher.ts`, started with the server):

- The page syncs each chart's guard to the server every time you switch it on, update it or switch it off (`debug/auto_server_guards.json`).
  The page re-reads the server every 3 s and always lists what it holds beside the MTM Guard button (**Server**: `OFF`, or one chip per
  chart with its levels; amber = held for another broker / mode than the page's). For the page's own broker and mode the card follows the
  server: a server guard switches the card ON with its levels, and one switched off elsewhere (another tab) switches it OFF here. A guard for
  another broker / mode is shown on the card once you switch the page to it, and is also announced with a **Switch it off** button while a
  REAL AUTO position is open on that chart. (Before 2026-11-05 the page read the server once per load, which loads in PAPER, so a REAL
  guard could exit trades while the card said OFF.)
- It guards only **REAL, open** rows of the synced broker and mode, from the row's entry price (or from the row's P&L when you switched the
  guard on late), using the same bridge prices as the page. Every leg must have ticked within 10 minutes, otherwise it pauses on that row and
  logs it. A row from an earlier day is reported, never exited. A Two-back / One-back row's own stop is enforced too, guard on or off.
- A trip is an ordinary ledger exit: it takes `beginExit`, sends the same own-units exit as the page, then records `close` /
  `markUnknown`. A rejected exit is retried every 10 s; after 5 failures in a row it stands down for a minute and says so. A ledger write that
  fails after the order went out is queued and retried. A row it closed shows `server guard: <rule>`; an open tab disarms AUTO on seeing it.
- Every 30 s it checks each open REAL row (at least 90 s old) against the broker's book; a row the broker shows flat on two passes in a row is
  closed as `flat at broker` (no order, no P&L booked): it was closed by hand, by a square-off or by the broker.
- It also squares **every** open REAL AUTO row off at the end-of-day time, guard on or off (no price needed: it books the entry price if none is available, and says so). After the market's close it never sends orders, it only reports a row still open. With the guard OFF there is **no** server stop-loss.
- It places **no entries**: a closed tab never trades, it only protects.

Only one tab per browser profile leads (Web Locks). A second browser or machine is not covered and could run a second engine.

## 8. What you see

- **Chart markers.** B / S for AUTO entries and exits, drawn from the ledger. An exit on a bar that printed no brick sits on the latest brick.
- **Status line** next to AUTO: `SHORT 5L @ 9,085.00 +₹X paper`, `waiting for a signal`, `HALTED`, `UNRESOLVED`, the stop level, and the **Exit**
  button.
- **Books (bottom strip).** *AUTO* tab: every AUTO row with entry, exit, P&L and state. *Trade Book* tab: a **Paper trades** section above the
  broker's trades, listing every simulated fill of the day (trade bar, rail, guard, AUTO entries and exits, newest first). Trade-bar paper
  fills are kept in this browser for the day (localStorage, stamped with the IST date; another day's list is ignored); AUTO ones come from the
  server ledger and survive a reload on any browser.
- **Ledger files.** `debug/renko_auto_state.json` (Renko) and `debug/pnf_auto_state.json` (the P&F page). The two pages never share a row.

## 9. Known limits

- **Not validated.** No backtest or replay. PAPER is more optimistic than REAL.
- **The tab is the strategy.** The rules, entries and the opposite-brick exit need an open, leader tab (browsers slow the timers of a
  hidden tab). The page now says so out loud when a gap of 8 s+ opens between two checks while AUTO is armed or holds a position (at most
  every 5 minutes). Use the server watcher's guard as the backstop, and keep the guard ON.
- **Unconfirmed broker unit.** Zerodha MCX futures: no cap, but confirm with one 1-lot REAL trade and check Zerodha's Positions shows 1 lot (it needs
  the machine's IP added in the Kite developer console first). Kotak is confirmed (10 barrels per lot).
- **Server watcher** has had no live test. Test it once: arm one REAL 1-lot trade with a tight rupee stop, close the tab, and confirm the
  ledger shows `server guard: ...` and the position is flat at the broker.
- **REAL fills** are read back from the broker (Dhan, Kotak and Zerodha order books) once an order is **fully traded**, and only when the price is
  whole: one order per leg, each filled for its leg's full units. A part-filled order, a cancelled remainder, a leg that was already flat, a Zerodha order
  split into slices, a row closed as `flat at broker` / `resolved`, or a fill more than 20% from the decision price is **not** used: the row keeps its
  decision price, shown with a `~` in the status line. Unreadable orders are tried 5 times (a minute apart) and then said once in the ledger log. Any
  leader tab settles, on every ledger change and every 15 s, so a trade made while no tab was open is settled by the next tab you open.
- **Two charts on one contract** net at the broker; each exits only its own units.
- **A whole-position SQUARE OFF** in the trade bar closes AUTO's units too; AUTO then finds the leg flat and books it closed.

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Kotak MCX orders are not supported from this page` (older build) | The page is running an old production build. Rebuild and restart the dashboard. |
| `No IPs configured for this app` on a Zerodha order | Kite requires a static IP: add this machine's public IP in the Kite developer console. |
| Zerodha order fails | The Zerodha session expires daily at 06:00 IST; log in again (`scripts/tools/zerodha_autologin.py`). |
| AUTO entered late / not at all | It only trades a signal on the newest closed bar, and only after arming. Arm before the move. |
| Two S (or B) markers in a row | The trend rule flipped: exit of the old position, then entry of the new one. |
| `exit waiting for a live price` | The feed has no price for that chart; the exit (manual or guard) is retried. |
| `MTM guard ... box value ... NOT enforced` | The chart's box size or the position's lot value is unknown. Use a rupee level or wait for the chart. |
| A trade closed as `eod` hours early (older builds) | Fixed: end of day now uses the position's own market. |
| UNRESOLVED | An unknown order outcome. Check the broker's Orders / Positions, then **Is open** / **Is flat**. |
| Dashboard on :3000 behaves like an old version | `:3000` is a production `next start` build; changes appear only after a rebuild and restart. |

## 11. Code map

| Area | Files |
|---|---|
| Tick interval | `scripts/tools/pnf_ws.py` (`TickLog`), `lib/pnfTicksServer.ts` + `app/api/straddle-pnf/ticks/route.ts` (log reader), `lib/pnfTicks.ts` (ticks to closed bars, splice with minute history), `components/straddlePnf/usePnfFeed.ts` |
| Rules (pure, tested) | `rs_dashboard/lib/renko.ts` (`renkoSignals`, `trendSignals`, `twoBackSignals`, `oneBackSignals`), `lib/pnfAuto.ts` (`decideAuto`, windows), `lib/pnfAutoRule.ts` |
| Engine (browser) | `components/straddlePnf/usePnfAuto.ts`, `AutoControls.tsx`, `components/StraddlePnfPage.tsx` |
| Ledger | `lib/pnfAutoLedger.ts`, `lib/pnfAutoServer.ts`, `app/api/straddle-pnf/auto/route.ts` |
| Orders | `app/api/straddle-pnf/order/route.ts`, `lib/pnfOrderExec.ts`, `lib/pnfOrderServer.ts`, `lib/pnfOrderLogic.ts` |
| MTM guard (page) | `components/straddlePnf/usePnfGuard.ts`, `components/priceLadder/MtmGuardCard.tsx`, `lib/priceLadderGuard.ts`, `lib/pnfGuardBoxes.ts` |
| Server watcher | `lib/autoServerWatcher.ts`, `lib/autoServerGuard.ts`, `app/api/straddle-pnf/server-guard/route.ts`, `lib/pnfLiveBridge.ts`, `instrumentation.node.ts` |
| Books | `components/straddlePnf/BrokerBooks.tsx`, `lib/pnfPaperBook.ts` |
| Tests | `lib/*.test.ts` (rules, ledger, guard, watcher core), `rs_dashboard/e2e/renko-auto.spec.ts` |

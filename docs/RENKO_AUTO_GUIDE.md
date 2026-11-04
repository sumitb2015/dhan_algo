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
position) first. AUTO is never remembered across a reload; open positions are.

## 2. The rules

Pick one per chart from the dropdown next to AUTO. A chart starts on **Supertrend** (the choice is then remembered per chart; the dropdown is locked only while AUTO is armed). A "brick" is one Renko column; a run is consecutive bricks of one colour.

| Rule | Enters | Exits |
|---|---|---|
| **N-brick** | BUY / SELL on the Nth brick after a colour change (once per run). The chart's first run never signals. Mid-run, it waits for the next reversal. | First brick of the opposite colour after the entry. No stop. |
| **N-brick (trend)** | On **every** brick that completes N same-colour bricks, so with N = 1 the next brick of the run you are in. Arming mid-run enters on the next brick. | First opposite brick, and that brick is also an entry for the other side (N = 1): the chart **flips** straight into the new direction. No stop. |
| **Two-back** | 3+ bricks, a 2-brick pullback, then the run resumes and a brick makes it 3 long and closes past the swing. | A stop one brick beyond the pullback, checked against the **live price** every second. No opposite-brick exit and no target. |
| **One-back** | 2+ bricks, a 1-brick pullback, then 2 resuming bricks that break the swing. | The same kind of stop. |
| **Supertrend** | BUY while a brick closes **above** the Supertrend line, SELL while it closes **below** it (the line's direction on the chart's ATR period x multiplier, the `ST` control). Arming mid-run enters on the next brick. | The first brick after the entry whose Supertrend direction is against the position (the line flips), and that brick is also the entry for the other side: the chart **flips**. No stop. |

N-brick, N-brick (trend) and Supertrend carry **no stop of their own**: the MTM guard is their loss limit. Two consecutive S (or B) markers on the

**Side.** Next to the rule, **Buy + Sell** (default) / **Buy only** / **Sell only** limits what AUTO may *open*; a signal for the other side is ignored (a buy-only chart stays flat through a sell phase and enters on the next buy). Exits are never filtered: an open position always exits by its own rule, MTM guard or end of day. The choice is remembered per chart and locked only while AUTO is armed. On options, "Sell" means selling the option.
chart under the trend rule are a flip: the first is the exit of the old position, the second the entry of the new one.

## 3. When it enters

- **Closed bars only.** A brick exists only after its 1-minute bar has closed, so a signal can never repaint. The order goes out about
  one second after the bar closes. If the price runs several boxes inside the minute, AUTO does not enter until the bar closes.
- **Arming ignores history.** Everything already on the chart when you arm is skipped; the first qualifying brick formed afterwards counts.
- **Fresh signals only.** The signal must be on the newest closed bar and less than 3 minutes old. A missed signal is never chased.
- **Session.** Only during the market session and before the entry cutoff: **NSE 15:05** (10 minutes before the 15:15 exit; a stock in the closing auction session 15:00), **MCX 10 minutes before the market close** = 23:45 on a 23:55 close (23:20 on a 23:30 close), the same minute as the MCX square-off, so a trade taken in the last minute is squared off at once.
  Holidays and weekends count as closed.
- **Feed.** Needs a live price and a fresh feed. A stale feed pauses entries.
- **Refusals.** Three refused entries in a row halt the chart.

## 4. When it exits

In priority order:

1. **End of day.** NSE 15:15; MCX 10 minutes before the close; a cash stock in the closing auction 5 minutes before the continuous session
   ends. The time is the **position's own market** (saved on the row), never the market of whichever chart is on screen.
2. **Stop** (Two-back / One-back). If the market gaps through, the fill is booked at the gapped price.
3. **Opposite brick** (N-brick and trend).
4. **MTM guard** (section 6).
5. **Exit button** on the AUTO status line. Closes at the live price and switches AUTO off. REAL asks for a second click. It waits for a
   live price and never books an exit at the entry price.

Exits keep running for an open position even when AUTO is switched off.

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

- One live AUTO row per chart. A REAL entry is **reserved before it is sent** (`entering`), an exit likewise (`exiting`).
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
  If what is left on the contract belongs to another page's AUTO, the guard switches off instead.
- **Refusals.** It will not exit AUTO's row if the row is on a different broker than the page's, and it waits for a live price.
- **Scope.** Switching broker or PAPER/REAL switches the page's guards off. The guard runs in the page: with the tab closed see section 7.

## 7. What runs where

| | Browser tab (the leader tab) | Dashboard server |
|---|---|---|
| Strategy rules, entries | yes | no |
| Opposite-brick / Two-back stop exit | yes | no |
| MTM guard | yes | **yes, for open REAL AUTO rows** |
| End-of-day exit | yes | **yes, for every open REAL AUTO row** (guard on or off) |

The tab does all the trading. If it closes, sleeps or loses its network, **nothing in the left column runs**, and an N-brick position would
sit without a stop. To cover that, the dashboard server runs an **exit-only watcher** (`lib/autoServerWatcher.ts`, started with the server):

- The page syncs each chart's guard to the server every time you switch it on, update it or switch it off (`debug/auto_server_guards.json`).
  After a reload the page adopts a guard the server still holds, so the card shows what is enforced. A server guard held for another broker /
  mode than the page opened in (a page opens in PAPER) is announced with a **Switch it off** button, never left enforcing unseen.
- It guards only **REAL, open** rows of the synced broker and mode, from the row's entry price (or from the row's P&L when you switched the
  guard on late), using the same bridge prices as the page. Every leg must have ticked within 10 minutes, otherwise it pauses on that row and
  logs it. A row from an earlier day is reported, never exited.
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
| Rules (pure, tested) | `rs_dashboard/lib/renko.ts` (`renkoSignals`, `trendSignals`, `twoBackSignals`, `oneBackSignals`), `lib/pnfAuto.ts` (`decideAuto`, windows), `lib/pnfAutoRule.ts` |
| Engine (browser) | `components/straddlePnf/usePnfAuto.ts`, `AutoControls.tsx`, `components/StraddlePnfPage.tsx` |
| Ledger | `lib/pnfAutoLedger.ts`, `lib/pnfAutoServer.ts`, `app/api/straddle-pnf/auto/route.ts` |
| Orders | `app/api/straddle-pnf/order/route.ts`, `lib/pnfOrderExec.ts`, `lib/pnfOrderServer.ts`, `lib/pnfOrderLogic.ts` |
| MTM guard (page) | `components/straddlePnf/usePnfGuard.ts`, `components/priceLadder/MtmGuardCard.tsx`, `lib/priceLadderGuard.ts`, `lib/pnfGuardBoxes.ts` |
| Server watcher | `lib/autoServerWatcher.ts`, `lib/autoServerGuard.ts`, `app/api/straddle-pnf/server-guard/route.ts`, `lib/pnfLiveBridge.ts`, `instrumentation.node.ts` |
| Books | `components/straddlePnf/BrokerBooks.tsx`, `lib/pnfPaperBook.ts` |
| Tests | `lib/*.test.ts` (rules, ledger, guard, watcher core), `rs_dashboard/e2e/renko-auto.spec.ts` |

# Price Ladder guide (`/price-ladder`)

User guide for the Price Ladder terminal. Code: `rs_dashboard/components/priceLadder/`, `rs_dashboard/lib/priceLadder*.ts`.
Real-money endpoint — SIM (paper) is the default; REAL needs the daily LIVE · REAL MONEY arm.

## Placing orders

- **XY (index) ladder** — click the Buy or Sell column at an *index* level. Limit = the option is cheaper (Buy) / dearer (Sell)
  at that level; the other side needs Order Type SL (breakout), or is a breakout by itself in **Anywhere** zones. The option
  order goes at MARKET when the index crosses the level. On a Put the ladder is inverted: a Buy is a limit *above* spot.
- **Plain ladder** — the ladder is the option's own price. Buy below LTP / Sell above it = LIMIT. The other side is an SL-M
  stop (Classic) or, in Anywhere, an SL-limit whose limit sits the SL-buffer % past the trigger. Orders rest at the broker.
- **Pair ladder** — the ladder is the combined premium (CE + PE) of a straddle / strangle. Sell above / Buy below = limit-like
  entry; the other side is a breakout. Both legs go at MARKET together when the combined price crosses the level (REAL: if
  only one leg fills it is closed again). Target / SL / trail are in combined-premium points and exit both legs.
- **Style** — Single (no exit rule), Bracket (target + SL in index points) or Cover (SL only). **Trail SL by** keeps the SL
  that many points behind the best level reached; it only moves in your favour.
- Number boxes have up/down arrows (and ArrowUp/ArrowDown). Target / SL / trail step by 1 point; per-leg SL % by 5; the SL
  buffer by 0.1 (a fractional value steps from itself, so 2.5 → 3.5). The tick you pick is remembered per mode (Plain defaults to 1). An arrow run commits once, half a second after you stop.

- **Buy Market / Sell Market** (under Lots, on every ladder) — one click sends the selected contract at MARKET now (on a Pair ladder, both legs of the shown straddle / strangle together; REAL: a lone filled leg is closed again), with the
  current lots, product, broker and SIM/REAL mode; the first REAL click each page load asks first; no bracket (exit from its widget or the MTM guard). The
  server applies every arm check (REAL arm, session, hours, auto-exit time, 20-lot cap, funds).

## Basket mode (prebuilt strategies on the net premium)

The **Ladder** switch has a fourth mode, **Basket**: pick one of the Baskets page's single-expiry strategies (iron condor, iron
butterfly, butterflies, batman, spreads, ratio spreads, lizards, ...). The legs are placed on the listed strikes around ATM
(offsets as on the Baskets page) and the ladder shows the strategy's **net premium**: a credit (iron condor) or a debit
(butterfly), always as a positive number. **Sell** = receive that premium, **Buy** = pay it. In the direction that matches the
strategy (Sell a credit / Buy a debit) the legs are as defined; in the other direction every leg is mirrored.

- **Edit legs** opens a pop-up: change a leg's side, CE / PE, strike (with ATM±n labels) or ratio (x1-x10), remove a leg, **Add leg**
  (up to 8), or **Reset to template**. The ladder re-prices as you edit; the legs are locked while a basket on them is armed or open.
- Everything else is the Pair ladder's behaviour on the net premium: arm at a level (Buy below / Sell above; the other side needs
  Order Type SL or Anywhere), Buy Market / Sell Market, Style (Single / Bracket / Cover) with Target / SL / Trail in net-premium points,
  drag the entry / target / SL, the Net Pos panel (25 / 50 / 75 / Exit, whole lots oldest first), the Open positions / Total P&L strip,
  the MTM guard, the day archive, the cutoff square-off, and the server watcher with every tab closed.
- **SIM** fills every leg at its live price at once.
- **REAL** needs the daily LIVE · REAL MONEY arm and a live broker session, is limited to **5 lots** per basket for now (the
  20-lot per-contract cap still applies) and passes a fail-closed funds check (the basket's hedged exchange margin plus the
  premium of the BUY legs). The orders go **hedges first**: the BUY legs together at MARKET, and only once every one filled in
  full the SELL legs. A hedge that fails sends no short (what filled is sold again); a short that fails or part-fills closes
  every filled leg, shorts first. An unknown order outcome stops everything and reverses nothing: resolve each leg
  ("Is open" / "Is flat") in the Baskets table. Exits cover the shorts first and sell the hedges only once none is held.
  A leg closed outside the ladder makes the basket BROKEN (bracket off; exit what is left). The first REAL run should be a
  1-lot defined-risk basket after a SIM day.
- Two-expiry strategies (calendars, diagonals) are not offered. No OI bars in Basket mode (rows are premiums).

## Trading cutoffs (MCX and NSE)

Two settings, in the ladder's Settings modal and the global Settings drawer: **MCX Trading Cutoff (CRUDEOILM)**, default 23:15,
and **NSE Trading Cutoff** (Nifty, Bank Nifty, Fin Nifty, Sensex and the other indices), default 15:17. After its cutoff a market
takes no new orders or armed levels and the ladder squares off that market's open MIS positions (NRML is carried). The NSE
cutoff must be 13:00-15:39 (the session closes 15:40; the last minute is left so the square-off can still be sent); the MCX one 22:00 to the close. Setting a time that has already passed
asks first, because it would square off open MIS positions on the next tick. Code: `lib/priceLadderCutoff.ts`,
`sessionFor()` in `lib/priceLadder.ts`.

## Closing from the positions window

The Positions tab of the books window has a **Close** column: 25 / 50 / 75 % (whole lots, rounded down) or **Close** (all) per
row, MARKET, after a confirm. The browser sends only the broker, the contract key, the product and the share
(`/api/price-ladder/close-position`); the server re-reads the broker's own book, derives the side and quantity, and the
order can only reduce that position. No REAL arm is needed (an exit). One close per position at a time, then an 8 s cooldown
while the book catches up. It is refused while the ladder itself is exiting that contract (a second exit would flip the position). Not supported from here: Kotak / Zerodha MCX (quantity units unconfirmed), non-F&O rows. A ladder
slice on the same contract is trimmed by the watcher's down-only reconcile once the book shows the change. Order-book
edit / cancel stays view-only on this page.

## Option chain window

The **Option chain** button in the header opens the chain of the ladder's current underlying + expiry (OI, OI change vs the
previous day, volume, IV and price per side, ±8 / 12 / 20 strikes around ATM, OI bars). Click a CE or PE price to put the
ladder on that contract. It is Dhan's rate-limited REST chain, so it loads on open and then every 20 s while open (the
server dedupes and spaces calls and serves the last good chain, flagged, if Dhan refuses).

## MTM guard (one per ladder)

One guard per **ladder + broker + SIM/REAL mode**, over the P&L of the orders **that ladder placed** (closed trades at
their exits, open ones at live prices, every contract and pair it placed — the same number as that ladder's header
"Ladder P&L" chip). Ladder 1 and ladder 2 have independent guards even on the same broker and mode: one never reads,
exits or cancels the other's positions. Orders from before ladders were tagged count as ladder 1's. It is enforced by
the **server watcher** (`lib/priceLadderGuard.ts`, evaluated once a second inside the ledger lock), so it works with
every tab closed — closing ladder 2 leaves its guard running over its positions (reopen ladder 2 to see or change it).
Each new day the levels you saved are restored but the guard is OFF (its best MTM and locked profit do not carry): switch it on again. If it was ON yesterday the event log says so.

| Rule | Meaning |
|---|---|
| Target ₹ | Exit when MTM reaches this profit. |
| Stop-loss ₹ | Exit when MTM falls to this loss. |
| Trail by ₹ | Exit when MTM gives back this much from its best since the guard was switched on. The best starts at the MTM at that moment. |
| Protect profit | Once MTM has touched **When MTM reaches ₹**, never give back below **Lock at least ₹** (0 = break-even). Optionally, for every further **+₹** of MTM the lock rises by **raise lock by ₹**. The lock only ever goes up. |

Example: trigger 1,000, lock 400, every +500 raise 250 → lock 400 at MTM 1,000, 650 at 1,500, 900 at 2,000.

**When a rule trips:** every open position of that scope is queued to exit at market, armed levels are cancelled and resting
REAL entry orders are cancelled at the broker (off the watcher's tick, retried every 30 s; a failure that leaves the order
resting is logged as an error). The guard then stays on — shown as *Tripped* — until nothing of its scope is live: a
rejected or held exit (e.g. market closed) is queued again, an entry still in flight is exited when it opens, and on REAL
a long (a hedge) exits only after that ladder's shorts are closed — a short on the *other* ladder does not hold it back,
so a long that hedges the other ladder's short can exit and raise that short's margin. Only then does it switch itself off and report *Fired*. Switching
off by hand never needs a valid draft.

**Things to know**
- MTM includes P&L already booked today. Switching on a 2,000 stop when the day is already −3,000 would exit at once, so
  the card asks you to confirm when MTM is already past one of its levels.
- Levels are only sent when you press Switch on / Update (never while typing). Update keeps the best MTM and the locked
  profit; switching off and on starts fresh.
- No price for an open leg = no decision (a partial sum would hide that leg's loss). Prices come from the WebSocket bridges
  and are only used when fresh.
- A guard only ever exits or cancels, so it needs no REAL arm.
- One guard covers every ladder on that broker + mode (both cards show the same guard).

## Saved trades (restart-proof)

The ledger `debug/price_ladder_state.json` is written atomically on every change, so a restart the same day, or the next
day, brings back everything live: open positions (NRML carries; MIS is squared off at the cutoff), exits in flight,
UNKNOWN orders to resolve, pairs, settings, and the MTM guard levels (OFF). The armed XY levels and the REAL arm are
one-day things and lapse with the day.

Everything the ledger is about to forget is saved first, in `debug/price_ladder_archive_<YYYY-MM-DD>.json` (one file per
IST day, kept forever, not in git): at the first write of a new day the whole previous day's ledger (every slice and
pair — closed, cancelled, rejected, open — the event log and the guards as they were), and on **Clear** the rows it
removes. A position carried overnight appears in that day's file as it stood at day end, and again under the day it
finally closes. Files merge by id, so a retry never duplicates a trade. If the archive cannot be written the ladder keeps
running and logs a red "Trade archive failed" event instead of stopping. There is no history window yet: open the file.

## Prices and Dhan rate limits

- **Every price the ladder trades on is a WebSocket price** — never a REST quote (a `/marketfeed` call shares Dhan's 1/s
  limit and slows to 10+ s after a 429). Index spots ride `live_indices_ws.py`; option LTPs the options bridges; everything
  else (SENSEX, MCX futures axis, uncovered strikes) `scripts/tools/price_ladder_ws.py` on the shared market-data hub (one
  Dhan connection). No fresh WebSocket price = levels pause and SIM fills wait; there is no REST fallback.
- **The only REST calls**, all paced: expiries (cached 1 h) and the option chain (strike list + ATM; one call per
  underlying/expiry change, deduped + spaced server-side, retried with back-off by the page); order status for a working
  REAL order (every 1.5 s each); the broker positions book for the REAL reconcile (every 5 s while a REAL position is
  open); the header account P&L (every 5 s, server-cached); the books window (every 5 s, only while open). Orders and
  cancels go through the shared order-rate lane (8/s).
- The MTM guard makes no REST calls at all — it reads the same WebSocket prices.

## CRUDEOILM on Zerodha and Kotak

CRUDEOILM trades on all three brokers. Prices always come from Dhan; only the order unit differs, and it is fixed when the contract is resolved (`resolveContract`):

| Broker | Exchange | Order qty | lotSize | `mult` | Sell margin |
|---|---|---|---|---|---|
| Dhan | `MCX_COMM` | lots | 1 | 10 | Dhan calculator, qty in lots |
| Zerodha | `MCX` | lots (Kite's dump reads lot_size 1) | 1 | 10 | same Dhan calculator |
| Kotak | `mcx_fo` | barrels (10 per lot) | 10 | unset (1) | Dhan calculator, qty / 10 lots |

A contract whose broker lot size is not the expected one is refused rather than guessed. Kotak and Zerodha positions are matched by trading symbol and product, as for the index options. Not yet confirmed against live Zerodha/Kotak MCX fills.

## OI bars (XY ladder only — test feature, branch `feat/ladder-oi-bars`)

The XY ladder's rows are index / futures levels, so each strike row carries that strike's open interest from the option chain: **call OI** as a red bar growing left of the Price column (resistance), **put OI** as a green bar growing right (support), both scaled to the largest OI on the whole chain. Hover a bar for the exact OI and its change vs the previous day (shown only when Dhan sends a previous-day OI). Rows that are not a strike (tick 5 against 100-point strikes) have no bar. Toggle with the **OI** checkbox in the ladder header. The chain is re-read every 30 s. Plain and Pair ladders show none: their rows are premiums, not levels. CRUDEOILM's OI unit (lots or barrels) is not yet confirmed against the chain, so the bars carry no unit label.

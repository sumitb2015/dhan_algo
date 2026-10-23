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

- **Buy Market / Sell Market** (under Lots, Plain and XY ladders) — one click sends the selected contract at MARKET now, with the
  current lots, product, broker and SIM/REAL mode; the first REAL click each page load asks first; no bracket (exit from its widget or the MTM guard). The
  server applies every arm check (REAL arm, session, hours, auto-exit time, 20-lot cap, funds).

## Trading cutoffs (MCX and NSE)

Two settings, in the ladder's Settings modal and the global Settings drawer: **MCX Trading Cutoff (CRUDEOILM)**, default 23:15,
and **NSE Trading Cutoff** (Nifty, Bank Nifty, Fin Nifty, Sensex and the other indices), default 15:17. After its cutoff a market
takes no new orders or armed levels and the ladder squares off that market's open MIS positions (NRML is carried). The NSE
cutoff must be 13:00-15:29 (the session closes 15:30); the MCX one 22:00 to the close. Setting a time that has already passed
asks first, because it would square off open MIS positions on the next tick. Code: `lib/priceLadderCutoff.ts`,
`sessionFor()` in `lib/priceLadder.ts`.

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
It resets each day.

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

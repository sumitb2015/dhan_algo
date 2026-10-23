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
  buffer by 0.1. An arrow run commits once, half a second after you stop.

## Option chain window

The **Option chain** button in the header opens the chain of the ladder's current underlying + expiry (OI, OI change vs the
previous day, volume, IV and price per side, ±8 / 12 / 20 strikes around ATM, OI bars). Click a CE or PE price to put the
ladder on that contract. It is Dhan's rate-limited REST chain, so it loads on open and then every 20 s while open (the
server dedupes and spaces calls and serves the last good chain, flagged, if Dhan refuses).

## Global MTM guard

One guard per **broker + SIM/REAL mode**, over the ladder's whole P&L for that scope (closed trades at their exits, open
ones at live prices, every contract and pair — the same number as the header "Ladder P&L" chip). It is enforced by the
**server watcher** (`lib/priceLadderGuard.ts`, evaluated once a second inside the ledger lock), so it works with every tab
closed. It resets each day.

| Rule | Meaning |
|---|---|
| Target ₹ | Exit when MTM reaches this profit. |
| Stop-loss ₹ | Exit when MTM falls to this loss. |
| Trail by ₹ | Exit when MTM gives back this much from its best since the guard was switched on. The best starts at the MTM at that moment. |
| Protect profit | Once MTM has touched **When MTM reaches ₹**, never give back below **Lock at least ₹** (0 = break-even). Optionally, for every further **+₹** of MTM the lock rises by **raise lock by ₹**. The lock only ever goes up. |

Example: trigger 1,000, lock 400, every +500 raise 250 → lock 400 at MTM 1,000, 650 at 1,500, 900 at 2,000.

**When a rule trips:** every open position of that scope exits at market, armed levels are cancelled, resting REAL entry
orders are cancelled at the broker (retried every 30 s; a failure is logged as an error), and the guard switches itself
off — switch it on again to carry on. If an entry is still in flight (a market entry being sent, a resting REAL order, a
pair placing) the guard stays on, shown as *Tripped*, exits whatever then opens, and switches off once nothing can still
become a position.

**Things to know**
- MTM includes P&L already booked today. Switching on a 2,000 stop when the day is already −3,000 would exit at once, so
  the card asks you to confirm when MTM is already past one of its levels.
- Levels are only sent when you press Switch on / Update (never while typing). Update keeps the best MTM and the locked
  profit; switching off and on starts fresh.
- No price for an open leg = no decision (a partial sum would hide that leg's loss). Prices come from the WebSocket bridges
  and are only used when fresh.
- A guard only ever exits or cancels, so it needs no REAL arm.

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

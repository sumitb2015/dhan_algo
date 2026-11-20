# Gearbox Drive: futures legs and seconds bars (short design)

Date: 2026-11-20 · Status: approved in chat by the user · Builds on `2026-11-20-gearbox-drive-design.md`.

## Intent
Two additions the user asked for while scalping on `/gearbox`: read the gearbox on WebSocket-built bars shorter than one minute,
and trade the crude future itself, not only its options.

## Approaches
- Seconds bars: (chosen) reuse `usePnfFeed`'s `tickSec` path, which builds N-second bars from the price bridge's tick log
  (`debug/pnf_ticks/`), as `/renko` does; keep the crude future logged all MCX session from the server, as `lib/pnfAlwaysRecord.ts`
  does for NIFTY. Rejected: gauges recomputed on every live tick (gear flicker inside a bar); a Tick (one bar per price) interval
  (EMA200 over a few minutes, constant gear flips).
- Futures: (chosen) a third leg type `FUT` in the existing direction map, ordered through the same PnF layer Signal Orb uses for
  crude futures. Rejected: a page-wide Options/Futures mode switch (less flexible, more UI state).

## Decisions
- Bar sizes: 5, 10, 20, 30 s added to 1 / 3 / 5 min. Gearbox, lamps and ghost still act only on closed bars. Picking a seconds bar
  shows "more trades and whipsaws". No Tick option. The ghost's entry window stays in minutes.
- Server keeps the signal future of the configured underlying (and of any live FUT row) asked for in the price bridge from MCX open
  to close (`mcxSession`), every second, with every tab closed. Read-only.
- `DirLeg.opt` becomes `'CE' | 'PE' | 'FUT'`. A FUT leg ignores offset; its contract is the page's signal future
  (`futureTarget`: first future expiring on or after the nearest option expiry), never one expiring today.
- Caps unchanged: REAL Dhan only, 1 lot (CRUDEOIL 100 bbl ≈ ₹100/pt, CRUDEOILM 10 bbl ≈ ₹10/pt); SIM up to 10. SELL FUT shows
  "margin, unlimited risk". The ⚠ "gains on the other direction" rule: LONG flags SELL FUT, SHORT flags BUY FUT.
- Freshness: an open needs the server future price ≤ 10 s old (FUT entry price = that future price in SIM).
- Exits: own units only (`exitOwn`), unknown never resent; the square-off covers FUT rows. SL/target are in futures points for a
  FUT leg (premium points for options). P&L = move × lots × unitsPerLot, same as options.
- Hold-back: `placePnfMarket`'s close also keeps Gearbox's live REAL **futures** units (add `reservedByGearbox(broker,
  targetKey(target), p)` beside `reservedByOrb` in `fromOther`). Signal Orb's own exits use `exitOwn`, so they never take
  Gearbox's units. Price Ladder / scalper / Exit All are still not covered (guide says so).

## Non-goals
Kotak/Zerodha REAL, futures-only signal changes, server-side SL/target, sub-0.5 s accuracy (the tick log samples every 0.5 s),
history for seconds bars before logging started.

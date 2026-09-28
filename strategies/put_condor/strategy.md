# Nifty Put Condor (Double Bear Put Spread)

`strategies/put_condor/nifty_put_condor.py`

> **UNVALIDATED — dry-run only in v1.** Sourced from a single pasted video summary (no title/channel
> captured by the user, provided 2026-09-28) describing a "puts-only" monthly positional strategy. No
> transcript was ingested via the research pipeline and no backtest exists — the options DB
> (`Options Data/nifty_options.db`) is populated from `download_expired_options.py` and could support
> one later, but v1 ships without it. The source shows one static numeric example (spot 26,188) and no
> multi-month track record, losing-month example, or theory for *why* the structure has an edge beyond
> "defined, small, known max loss vs. a larger capped max profit if the market drifts down." Treat the
> risk/reward numbers below as a worked example, not a guarantee — see Section 8 for what is
> deliberately not validated.

---

## 1. Why / edge hypothesis

The source describes buying a near-the-money **bear put spread** (long higher-strike put, short
lower-strike put) and, below it, selling a second **bear put spread** further out of the money
(short a higher strike, long a lower strike). Laid out by strike, all four legs are, high to low:
**BUY / SELL / SELL / BUY** — which is the standard **4-leg put condor**, just described leg-by-leg in
the source as "two stacked bear put spreads" rather than named as a condor. The short middle body
(between the two SELL strikes) is *wider* than a textbook symmetric condor's outer wings in the
source's own example (200 pts vs 150 pts), which skews the payoff: maximum profit is reached on a
**moderate decline** into the body, financed partly by the second (lower) spread's net credit, while
both sides of the position remain risk-defined by construction — a long put above and a long put below
box in the possible loss no matter how far the market moves either way.

Source's worked example (spot 26,188, monthly expiry):
| Leg | Side | Strike |
|---|---|---|
| Upper long put | BUY | 26,000 |
| Upper short put | SELL | 25,800 |
| Lower short put | SELL | 25,600 |
| Lower long put | BUY | 25,450 |

Quoted numbers for 1 lot at those strikes: margin ≈ ₹80,000, max loss ≈ ₹1,900 (rallies against the
view), max profit ≈ ₹11,000 (in the short body, 25,600-25,800), breakeven ≈ 25,971. These are
internally consistent: breakeven 25,971 implies a 29-pt net debit, and with 65 qty that gives max loss
29 × 65 = ₹1,885 and max profit (200 − 29) × 65 = ₹11,115 (checked in `tests/test_put_condor.py`). A
crash below 25,450 still ends positive: (200 − 150 − 29) × 65 = ₹1,365. The only losing side is a
rally, and it is capped at the debit. These
are for illustration only — v1 does not hardcode these strikes or premiums; see Section 3 for how
strikes are chosen generally.

## 2. Instruments and product

- Underlying: **NIFTY** index options only (v1; no other underlying).
- Product: **MARGIN** (carry-forward) — this is a monthly hold, never `INTRADAY`.
- Expiry: current monthly expiry, all 4 legs (unlike `volcano_calendar`, there is no second expiry
  here). "Monthly expiry" uses the same last-expiry-of-calendar-month grouping as `volcano_calendar`
  (works whether that date is a Tuesday, Wednesday or Thursday — no weekday hardcoded).
- Lot size from `helper.get_lot_size("NIFTY")`, never a constant. All 4 legs are sized at the same
  `--lots` (no 1×2×1 body ratio here — the body's two SELL legs are single strikes, not a doubled one).

## 3. Entry

- **Cycle selection by DTE, not by weekday**: when flat, the strategy targets the first monthly
  expiry whose calendar DTE is inside [`--min-dte`, `--max-dte`] (default 20–38), skipping the expiry
  it last traded (`last_cycle_expiry`, persisted). After an expiry the next monthly is 27–35 days out,
  so a new cycle starts on the next trading day; after a mid-cycle target/stop it waits until the
  following monthly comes inside the window. (v1 originally entered on the last trading Friday like
  `volcano_calendar`; that was wrong here: NIFTY's monthly is the last Tuesday, so the last Friday can
  land 4 days before expiry, e.g. Fri 2026-09-25 vs Tue 2026-09-29, and when it does the previous
  cycle is still open on entry day, so that month gets skipped.)
- **Time**: any trading day (weekday, not in `NSE_HOLIDAYS`) between `--entry-time` (default `09:45`)
  and `--entry-end` (default `15:00`).
- **Retry policy**: an attempt that aborts before any order (missing quote/contract) retries next
  tick. An attempt where orders were placed but *nothing filled* retries up to 3 times per cycle, then
  skips the cycle. An attempt where *anything filled* is unwound and the cycle is skipped, so a failing
  leg can't cause repeated enter-and-unwind churn.
- **Sizing**: `--lots` (default `1`) applies equally to all four legs.
- **Strikes** (spot = current NIFTY LTP, `step` = `--strike-step`, default `50`). Each strike is spot
  minus a configurable point offset, rounded to the nearest step (**round, not floor** — unlike
  `volcano_calendar`'s ATM, there is no single ATM anchor here; each leg is independently offset from
  raw spot):
  | Leg | Side | Offset flag (points below spot) | Default |
  |---|---|---|---|
  | `pe_long_upper` | BUY | `--upper-long-offset` | 150 |
  | `pe_short_upper` | SELL | `--upper-short-offset` | 350 |
  | `pe_short_lower` | SELL | `--lower-short-offset` | 550 |
  | `pe_long_lower` | BUY | `--lower-long-offset` | 700 |

  Defaults reproduce the source's spacing (200 / 200 / 150 points between consecutive strikes) rather
  than its absolute strikes, since the absolute strikes only make sense at that one spot price.
  Offsets must be **strictly increasing** (`upper_long < upper_short < lower_short < lower_long`),
  checked both at config time (on the flags) and again after rounding at entry time (rounding to
  `--strike-step` can collapse two close offsets onto the same strike if the gap is smaller than the
  step) — a post-rounding collision aborts that entry attempt with a `[CONFIG ERROR]`-style log line
  rather than placing a 3-leg position by accident.
- Offsets must also step up by at least `--strike-step` each; that guarantees rounding can't
  collapse two legs onto one strike (the runtime collision check stays as a backstop).
- **Margin** is read from Dhan's multi-leg calculator *before* the first order, for the 4 legs as a
  standalone basket (`include_position=False, include_orders=False`), so it is neither netted against
  nor doubled by whatever is already open.
- **Entry order (protective legs before short legs)**: buy `pe_long_upper`, buy `pe_long_lower`, then
  sell `pe_short_upper`, then sell `pe_short_lower`. The position file is written with
  `status=UNWINDING` **before the first order**, and each leg is recorded **before its own order**, so
  a crash mid-entry leaves a book that a restart flattens rather than live legs with no record (the
  `flyagonal` pattern). Every fill is confirmed: on Dhan by order status (`wait_for_fill`); on
  Zerodha/Kotak, whose order ids are not Dhan ids, by waiting for that broker's own net quantity to
  move by the order size. An unconfirmed Dhan order is cancelled; if it reports `REJECTED` the leg is
  dropped, otherwise it stays tracked and the unwind sizes it off broker truth (0 if it never filled).
  Any failure unwinds every tracked leg, shorts first.
- No entry-quality gate beyond the quote check in v1 (no spread-width or liquidity filter, no IV or
  skew check on whether the current premium relationship still resembles the source's example).
- **Dashboard launcher caveat**: this strategy uses the generic `--lots`/`--target-profit`/`--stop-loss`
  launcher fields (no custom `StrategyCard`/`StrategyRowWide` branch beyond excluding the unused generic
  "Start Time" field, same as `volcano_calendar`). Those text fields default to `25%`/`25%` for every
  generic-branch strategy in the UI, which does **not** match this strategy's own `10%`/`4%` CLI
  defaults — a dashboard user must type the correct values into both fields before Start, or accept
  whatever they typed. CLI users get the correct defaults automatically. `--partial-booking-profit` has
  no dashboard field at all; it always uses its CLI default (`2.5%`) when launched from the UI.

## 4. Adjustment

**None in v1.** The source teases "minor adjustments... for part two" for the case the market rallies
against the view, but gives no rule, formula, or trigger — only that a future video would cover it.
Implementing a guess here would be inventing a rule the source never gave; see Section 8.

## 5. Exit

Checked in this order each tick, first match wins. Nothing is decided on a tick where any open leg
has no quote (`total_pnl()` returns `None`): a leg missing from the sum would fake a target or stop.
Unlike every other strategy in this repo, this one has a **two-stage profit exit** because the source
explicitly describes booking half the position early.

1. **Target**: `total_pnl >= target_rs`, `--target-profit` (default `10%` of deployed margin — a
   deliberately conservative reading of the source's own worked-example ratio, ₹11,000 max profit on
   ~₹80,000 margin ≈ 13.75%; picking a round number below that theoretical max rather than assuming
   the position can be held to the very edge of its payoff curve).
2. **Stop**: `total_pnl <= stop_rs`, `--stop-loss` (default `4%` of deployed margin, always applied
   as a loss). **With the default offsets this is a backstop that normally cannot fire.** The upper
   spread (200 pts, higher strikes) is always worth at least as much as the lower one (150 pts), so the
   book is never worth less than zero, before or at expiry, and the worst case is the net debit paid.
   Dry run 2026-09-28 at spot 23140: debit 31.85 pts, 2 lots, max loss ₹4,141 = 2.6% of ₹159,181
   margin. Only slippage, bad quotes, or offsets that make the lower spread *wider* than the upper one
   (warned at startup) can push the loss past the debit. That matches the source's point that the
   capped loss lets you hold without panic. The entry log and state file carry the computed payoff
   (`net_debit_pts`, `max_loss_rs`, `max_profit_rs`, `crash_pnl_rs`, `breakeven`).
3. **Expiry-day EOD**: on the position's own monthly expiry, flatten everything at `--eod-exit-time`
   (default `15:17`).
4. **Partial profit booking** (once per cycle): when `total_pnl >= partial_rs`, close **half the
   entry lots** (integer division: 3 → close 1, keep 2) on every leg, keep the rest at the original
   entry prices and target/stop. `partial_rs` is `--partial-booking-profit` (default `2.5%` of deployed
   margin, the source's "2-3% returns on margin"; must be below the target). With 1 lot there is
   nothing to halve, so it is marked done and skipped. Mechanics: **shorts first, longs only after
   both shorts' partial closes are confirmed**, each leg reduced exactly once (`partial_done` per leg,
   persisted). A leg whose partial close fails keeps its quantity and is retried next tick, and once
   any leg has been reduced the remaining legs keep being retried even if P&L has since fallen back
   below `partial_rs`, so the book never stays at mismatched sizes. `--lots` itself is never modified;
   the halving uses `entry_lots`, persisted with the position.
5. Otherwise the position holds untouched. A dashboard Stop flattens it (nothing else supervises a
   live short), like `overnight_fly`. `--max-consecutive-stops` (default `3`) pauses new entries
   without closing an open position; to resume, set `consecutive_stops` to 0 in the position file.

**Every exit closes shorts first** and holds the longs as the hedge until no short remains, so a
rejected close never leaves a naked short. A leg leaves tracking only once its close is confirmed;
otherwise the status stays `FLATTENING` (or `UNWINDING` for a failed entry) and the exit is retried
every tick with its original reason, so a stop that completes on a retry still counts toward
`--max-consecutive-stops`.

`realized_pnl` and `total_pnl` are **per cycle**: `realized_pnl` resets at every entry (it includes
the partial-booking close), and completed cycles accumulate into `lifetime_realized`. Target/stop are
resolved once at entry and never re-based against the smaller post-partial position.

## 6. Failure modes

| Failure | Tracked state |
|---|---|
| Quote/contract missing for any leg before entry | No orders placed; retried next tick |
| A placement returns no order id and nothing has filled | Flat; retried up to 3 attempts per cycle, then the cycle is skipped |
| Any leg fails after earlier legs filled | Every tracked leg unwound, shorts first; `UNWINDING` until all confirm; cycle skipped |
| Entry order placed but never confirms | Dhan: cancelled; dropped if `REJECTED`, else tracked and unwound against broker truth. Zerodha/Kotak: tracked and unwound against broker truth |
| A short's close fails during an exit | Longs are held as the hedge; `FLATTENING`, retried every tick with the original reason |
| A partial-booking close fails | That leg keeps its qty; longs are not reduced while a short is pending; retried next tick regardless of P&L |
| Broker holds less than tracked (sibling or manual close) | Close clamped by `resolve_exit_qty_broker`; the untracked remainder's P&L is not booked (logged) |
| Position lookup fails while closing | `resolve_exit_qty_broker` returns 0 on a failed lookup; a second direct read must succeed before the leg is called flat, else it stays tracked |
| Any open leg has no quote | No exit/partial decision that tick |
| Margin call fails | `--fallback-margin-per-lot` x lots, logged `WARNING` |
| Process killed mid-entry | Position file was written before the first order with `UNWINDING`; restart flattens the tracked legs |
| Process killed mid-position | Restart reloads, resubscribes, reconciles (refuses on a broker shortfall) |
| Stop pressed but a close fails | State shows `STOPPED (EXIT INCOMPLETE - VERIFY MANUALLY)`; position file keeps `FLATTENING` so a restart finishes the exit |
| Position still tracked after its expiry | Live: refuses to start / exits with `ERROR`; contracts have settled, verify manually. Paper: discarded on load |
| Corrupt position file | Refuses to start |

## 7. Restart behaviour

- `debug/nifty_put_condor_position.json` (atomic write) is the source of truth: `expiry`,
  `last_cycle_expiry`, `entry_attempts`, `entry_lots`, all 4 legs (`{id, strike, opt_type, expiry,
  side, avg_price, qty, partial_done}` or `null`), `realized_pnl`, `lifetime_realized`,
  `partial_booked`, `partial_rs`, `target_rs`, `stop_rs`, `margin`, `exit_reason`,
  `consecutive_stops`, `dry_run`.
- Open position: resubscribe every leg, then reconcile. The broker net can include a sibling instance
  on the same strike, so only a **shortfall** (broker holds less than tracked, in our direction)
  refuses to start. Reconcile is skipped when resuming `UNWINDING`/`FLATTENING`, because an
  unconfirmed entry leg may legitimately not exist; the retry path sizes every close off broker truth.
- Paper and live position files are not interchangeable; a mode mismatch refuses to start.
- No `exit_if_market_closed()` at startup: a restart outside market hours waits for the open (Stop
  still works while waiting) instead of exiting and leaving a month-long position unsupervised.

## 8. Deliberately not done in this version

- **Rally-side adjustment**: the source's own teased "part two" adjustment for an adverse rally has no
  rule in the evidence available; nothing was guessed here. The structural max loss plus the software
  `--stop-loss` are the only downside controls in v1.
- **Backtest**: no historical validation run. The options SQLite DB could support one against expired
  monthly chains; not done for v1.
- **Entry-quality gate**: no bid/ask spread or liquidity filter, no check that the current
  premium/margin relationship still resembles a "small defined loss, larger defined profit" shape
  before entering — a change in IV skew could make the source's numbers not hold at entry time.
- **Roll-forward at expiry**: the position closes flat at expiry-day EOD; the next cycle is a fresh
  entry on the next trading day (DTE window), not a roll.
- **Unconfirmed-but-filled closes on Zerodha/Kotak**: confirmation there waits for that broker's net
  to move by exactly the order size. If a sibling instance trades the same strike in that window, a
  filled close can read as unconfirmed and the retry, clamped only by broker net, could close the
  sibling's quantity. Don't run two instances on the same strikes with a non-Dhan broker.
- **`--max-consecutive-stops`**: a repo-side safety default (3), not a source rule — same caveat as
  `volcano_calendar`.

## CLI Reference

```
python strategies/put_condor/nifty_put_condor.py [--live --i-understand-this-is-unvalidated]
    [--lots N] [--strike-step N]
    [--upper-long-offset PTS] [--upper-short-offset PTS]
    [--lower-short-offset PTS] [--lower-long-offset PTS]
    [--partial-booking-profit INR|%] [--target-profit INR|%] [--stop-loss INR|%]
    [--fallback-margin-per-lot INR]
    [--min-dte DAYS] [--max-dte DAYS]
    [--entry-time HH:MM] [--entry-end HH:MM] [--eod-exit-time HH:MM]
    [--max-consecutive-stops N]
    [--instance-id ID] [--broker {dhan,zerodha,kotak}]
```

Dry run by default. See `--help` for full flag documentation and defaults.

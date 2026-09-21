# Nifty Flyagonal: call broken-wing butterfly + put diagonal

`nifty_flyagonal.py`: positional (multi-day carry, `MARGIN`), defined-risk, five option legs.

> **NOT VALIDATED. Dry-run by default.** The idea is adapted from a US-SPX video (58/60 winners in 10
> weeks, self-reported). There is no Nifty evidence: options ideas here are forward-tested only.
> `--live` places real orders (no extra confirmation flag).
> Research, gaps and reasoning: vault page `wiki/strategies/nifty-flyagonal-bwb-put-diagonal.md`
> (its proposed 20-cycle forward-test gate was waived by the owner, so it is not a precondition).

## 1. Edge hypothesis
The butterfly makes money if Nifty drifts up and vol falls; the put diagonal makes money if Nifty falls
and vol rises; short-dated shorts decay faster than the longs. Mechanism unconfirmed, sample is one
regime. Rule set is a reconstruction, every default that the video left open is marked **(A)** below.

## 2. Instruments and product
NIFTY index options (European, cash-settled), lot from `helper.get_lot_size("NIFTY")`, product
`MARGIN`. Underlying id for orders resolves through `ExecutionBroker`; spot is
`get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")`.

## 3. Entry
- Any weekday (or `--entry-weekday`) from `--entry-time` (09:30 **(A)**), market open, no open position.
- Front expiry F: first listed expiry with `--entry-dte-min..max` (8-10) calendar days out. Back
  expiry B: first later expiry with at least `--back-dte-min` (15) days **(A)**.
- Strikes from spot, rounded to `--strike-step` (50): call K1 spot+0.0%, body K2 +0.9%, K3 +1.9% (wings
  200/250 at 23,346); short put Ps -3.0%, long back put Ps - `--diag-offset` (50) **(A)**, so the pair is
  risk-defined at F's expiry. Shape is validated at startup (ascending calls, broken wing up, `Pl < Ps < K1`).
- Legs: BUY K1 (F), BUY K3 (F), BUY Pl (B), then SELL 2x K2 (F), SELL Ps (F). Longs first so the
  shorts are always covered.
- Skip the tick (no orders) if any of the five prices is missing or 0, spot is 0, or net debit exceeds
  `--max-net-debit` (optional). Size is fixed `--lots` (default 1, capped by `--max-lots`).
- Max loss at F's expiry per unit = `max(wing gap, put gap) + net debit`; times units = `max_loss_rs`,
  the base for percent targets.

## 4. Adjustment (one numeric rule, capped) **(A)**
The video's adjustments are discretionary (chart reading). The only coded rule: net position delta per
lot `<= -(--adjust-delta)` (0.10, see note) means the market ran up, so roll the short front put **up**
`--adjust-step` (50) points to add positive delta. At most `--max-adjustments` (1) per cycle; 0 disables.
After an adjustment the profit target drops to `--adjusted-target` (5%, the video says "lower my
expectations" without a number). The reverse case (net delta high on a fall) has no rule. Adjustment
skips if the new strike is not strictly between the long put and spot.

Calibration note: a Black-Scholes check (13% vol, 5-8 DTE) puts this book's net delta per lot between
about -0.13 and +0.12 across the whole tent, so a 0.30 trigger could never fire; 0.10 fires only in the
upper-wing zone. It is an uncalibrated assumption: tune it against dry-run logs (`net_delta_per_lot`).
The video's other adjustment (buy back one short call and roll it) and its "phase out one fly/calendar"
exit are discretionary and not coded.

## 5. Exit (checked in this order each poll)
1. Stop: `total_pnl <= -stop` (`--stop-loss`, INR or % of max loss; default none, the source has none).
2. Target: `total_pnl >= --target-profit` (default 10% of max loss).
3. Time: front DTE `< --exit-dte` (4), or `==` it at/after `--exit-time` (15:15).
Exits close shorts first, then longs. `total_pnl = realized_pnl + unrealized` (gross of charges).
After each cycle `last_cycle_expiry` blocks re-entering the same front. `--max-cumulative-loss`
(optional) halts new entries; HALTED persists and is cleared only by editing `status` in the portfolio file.

## 6. Failure modes
| Failure | Resulting tracked state |
|---|---|
| First entry order fails (nothing placed) | stays flat `IDLE`, retried next poll |
| A later entry order fails / does not confirm | placed legs tracked, `UNWINDING`, rollback via `exit_all()`; unconfirmed Dhan order is cancelled first |
| Rollback or exit close does not confirm | that leg stays tracked, `FLATTENING`, retried every poll, nothing else runs |
| Adjustment close unconfirmed | short put unchanged, retried next poll |
| Adjustment re-sell fails | short put left flat, long back put remains (defined risk), alert raised |
| Any price 0/missing for a held leg | stop/target/adjust skipped that tick (no decision on stale data); the time exit still runs |
| Position lookup fails while closing | leg stays tracked, not assumed flat |
| Process killed mid-entry | book is persisted as UNWINDING from before the first order; restart flattens it |
| Stop pressed with market closed (live) | nothing sent (it would queue as an AMO); position kept, card says POSITION LEFT OPEN |
| Broker already flat on a leg | counts as closed, booked at last mark |
| Process killed mid-cycle | portfolio file restores legs; live restart reconciles vs broker |
| Order resolves to no contract | treated as a failed order (rollback) |

Note: a rolled-back entry still sets `last_cycle_expiry`, so a failed entry needs a human look before
the same expiry is retried (clear `last_cycle_expiry` in the portfolio file to retry).

## 7. Restart behaviour
`debug/<key>_portfolio.json` (atomic) holds legs, expiries, lots, lot size, max loss, realized and
cumulative P&L, adjustment count, `dry_run`. Refuses to start on a corrupt file, and on a paper file in
a live run (or the reverse) while a position is open. Live restart cross-checks each leg with
`broker.get_owned_net_qty()`; a mismatch needs `--force-reconcile`. Exits are sized by
`resolve_exit_qty_broker()` only.

## 8. Stop button
Stop (or Ctrl-C) **flattens** the position (nothing else supervises the time exit). If the exit is not
confirmed the card shows `STOPPED (EXIT INCOMPLETE - VERIFY MANUALLY)` and the portfolio file keeps the
open legs. `--keep-on-stop` leaves the position and lets a restart reconcile.

## 9. Deliberately not done
- No margin-based sizing (fixed lots), no freeze-quantity slicing (`--max-lots 5` stays under it).
- No resting broker stop orders; Dhan/Zerodha/Kotak all rely on the 60 s poll.
- No holiday-aware DTE (calendar days); an expiry shifted off Tuesday is handled only through the window.
- No charges/slippage in P&L. No rule for a downside adjustment. No overlapping cycles in one process
  (run a second `--instance-id`). No WebSocket: legs are priced from the option chain each poll.
- Dashboard: `components/FlyagonalConfig.tsx` (shared by both launcher cards) exposes every flag except `--instance-id` (set by the Add-run button), `--broker` (broker selector) and `--force-reconcile` (recovery, CLI only). Inputs are validated client-side like `parse_args()`; an empty optional box means the script default / none.

## 10. CLI reference
```
venv/bin/python strategies/flyagonal/nifty_flyagonal.py [--live]
  --broker {dhan,zerodha,kotak}  --instance-id ID  --lots N (1)  --max-lots N (5)
  --entry-dte-min N (8)  --entry-dte-max N (10)  --back-dte-min N (15)  --entry-weekday 0-6
  --entry-time HH:MM (09:30)  --strike-step N (50)
  --fly-lower-pct P (0.0)  --fly-body-pct P (0.9)  --fly-upper-pct P (1.9)
  --put-pct P (3.0)  --diag-offset N (50)  --max-net-debit PTS
  --target-profit INR|NN% (10%)  --adjusted-target INR|NN% (5%)  --stop-loss INR|NN% (none)
  --exit-dte N (4)  --exit-time HH:MM (15:15)
  --max-adjustments N (1)  --adjust-delta D (0.10)  --adjust-step N (50)
  --max-cumulative-loss INR  --keep-on-stop  --force-reconcile  --poll-interval SECS (60)
```
Tests: `venv/bin/python tests/test_flyagonal.py` (offline, stub broker).

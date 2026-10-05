# Nifty timed iron condor

`nifty_timed_condor.py` sells one defined-risk iron condor a day at a fixed time and manages it on total P&L.
It is a **worked example of `lib/algo_kit`**: everything that is not the idea itself (confirmed entry, rollback, a
close sized by broker truth, position file, trailing stop, CLI flags, logging, quote parsing, shutdown-aware
waits) comes from the kit, so the file holds only the strike choice, the entry gate and the exit rules.

## Validation status

**UNVALIDATED.** No backtest, no forward test. The 200-point offsets, the 50% target and the 100% stop are
placeholders. Dry-run is the default; `--live` additionally needs `--i-understand-this-is-unvalidated`.
It is not registered in the dashboard (no `strategyRegistry.ts` entry, not in the logs route's `STRATEGY_LOG_DIRS`);
run it from a terminal.

## Instruments and product

NIFTY options, nearest expiry, `INTRADAY` (flat at `--eod-time`). Lot size comes from `helper.get_lot_size()`.
Market data from Dhan; orders through `ExecutionBroker` (Dhan, Zerodha or Kotak).

## Entry

At or after `--start-time` (default 09:30) and before `--eod-time`, once per calendar day:

- shorts at ATM +/- `--short-offset` (default 200), wings `--wing-width` (default 200) beyond them
- all four quotes must be positive and the net credit must be positive, else it skips the tick
- order: **wings first** (BUY long CE, BUY long PE), then the shorts, so there is never a naked short
- an entry attempt counts as the day's entry whether or not it succeeds, and that is persisted: a restart
  never re-enters a day it already traded

## Adjustment

None. It does not roll, repair or re-enter.

## Exit (first rule that fires; all read total P&L = realised + open)

1. trailing stop: arms at `--trail-start-rs`, exits on a `--trail-gap-rs` giveback from the best
2. target: `--target-profit`, rupees or a percent of the entry credit in rupees (default 50%)
3. stop: `--stop-loss`, rupees or a percent of the entry credit (default 100%)
4. `--eod-time` (default 15:17)

## Failure modes

| Failure | What happens |
|---|---|
| a quote is zero or missing | no orders placed; retried on the next tick |
| first wing's order fails | nothing placed, flat; the day is consumed |
| a later leg fails | the legs already placed are closed (shorts before wings); flat; the day is consumed |
| that rollback's close fails or is unconfirmed | the leg stays tracked, status `UNWINDING`, retried every tick |
| process dies between legs | the book was saved before the order, so a restart finds it `UNWINDING` and flattens it; a leg that was never placed reads flat |
| a close is not confirmed | the leg stays tracked, status `FLATTENING`, retried; never reported closed |
| broker net is smaller than tracked | the close is clamped to what the broker shows (a sibling instance may share the strike) |

## Restart behaviour

State is in `debug/<key>_position.json` (atomic, written before each order and after each close). On start it
resubscribes every tracked leg and checks the broker still shows them (refuses to start if a leg is missing),
except while `UNWINDING`/`FLATTENING`, where the close path reads broker truth itself. It refuses to start on an
unreadable file, a paper position in a live run (or the reverse), or a live position whose expiry has passed.

## Deliberately not done

Re-entry, rolling, delta-based strikes, a VIX or IV gate, per-leg stops, position sizing from margin.

## CLI

```
python strategies/timed_condor/nifty_timed_condor.py [--live --i-understand-this-is-unvalidated]
    [--lots N] [--broker dhan|zerodha|kotak] [--instance-id ID]
    [--target-profit INR|%] [--stop-loss INR|%] [--trail-start-rs INR] [--trail-gap-rs INR]
    [--start-time HH:MM] [--eod-time HH:MM] [--short-offset POINTS] [--wing-width POINTS]
```

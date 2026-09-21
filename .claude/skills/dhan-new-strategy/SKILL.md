---
name: dhan-new-strategy
description: Build, extend, review or debug a live trading strategy in strategies/ (options selling, spreads, MCX crude futures, cash-equity, positional). Use whenever the user wants to create a new algo/strategy, port a strategy idea or video into code, add a flag/adjustment/exit rule to an existing strategy, wire one into the dashboard Start/Stop/Strategies pages, or asks why a strategy left a naked leg, double-booked P&L, lost track of a position after restart, or shows STOPPED on the dashboard while running. Carries the standard feature kit every strategy in this repo must have (dry-run default, state bridge, shutdown trigger, own-quantity exits, confirmed fills, restart recovery, guards, registration) plus the strategy-spec template. Not for backtests under scripts/analysis/.
---

# Building a Dhan Algo Strategy

Every strategy here is a standalone script run by the dashboard as a detached process, trading real
money unsupervised. The trading idea is the easy part; almost every loss and outage in this repo's
history came from the *plumbing around* the idea: an order that failed and was walked past, an exit
sized off the wrong quantity, a restart that forgot a live leg, a state file the dashboard couldn't
read. This skill is the standard kit that closes those holes, and the workflow for applying it.

## Workflow

1. **Read the sibling first.** Pick the closest existing strategy from
   `references/strategy-families.md` and read its `strategy.md` and script. Copy its shape, not the
   toy in `templates/strategy_template.py` (that template has no state bridge, no shutdown check and
   no restart recovery; use `assets/strategy_skeleton.py` from this skill instead).
2. **Write the spec before the code** (see "Strategy spec" below), as `strategies/<family>/strategy.md`.
   Forcing the failure-mode table onto paper is what finds the missing rollback.
3. **Put decision logic in pure functions** (signal, strike choice, stop levels) that take plain values
   and return plain values, so they can be unit-tested without a broker. Keep I/O in the class.
4. **Copy `assets/strategy_skeleton.py`**, fill in the `TODO(strategy)` hooks, and keep its plumbing intact.
5. **Wire the dashboard** (`references/dashboard-wiring.md`): several registries, all must agree.
6. **Verify dry-run** end to end (checklist at the bottom), then have the read-only
   `dhan-strategy-auditor` agent review the file before any `--live` run.

## The Standard Feature Kit

A strategy is not done until every item below is present. Each exists because its absence cost money
or hid a running process; the incident is named so you can judge how strict to be.

### 1. Dry run by default
`--live` is a `store_true` flag defaulting to False; without it no order is placed and the strategy
*simulates* the fills (paper price = current LTP), so P&L, state and exits still exercise the real
code path. Log `Mode: LIVE|DRY` at startup. `exit_if_market_closed(helper, dry_run)` must receive the
flag so dry runs work after hours (`2b6a433`). A strategy whose rule set failed its backtest stays
dry-run only and demands an explicit `--i-understand-the-backtest-failed` for `--live`
(`intraday_equity`); state validation status in the module docstring.

### 2. CLI contract
- `argparse` with `RawDescriptionHelpFormatter` and an `epilog` of runnable examples (dry run and live).
- Every flag has a unit and default in its help text (`INR`, `HH:MM`, `fraction`, `%`).
- `--instance-id` (suffix isolating state/log files; `[A-Za-z0-9_-]{1,20}`) on **every** strategy, and
  `--broker {dhan,zerodha,kotak}` on every options strategy.
- `--target-profit` / `--stop-loss` accept rupees or `NN%` through `parse_target_spec()`. A percent
  resolves **once** against the day's first entry value, not each roll's premium, and thresholds that
  are still `None` must be guarded before comparison (`466e225`: a `None` compare crashed the first
  flat tick).
- Validate all args after `parse_args()`, collect every problem into an `_errors` list, log each as
  `[CONFIG ERROR]` and `sys.exit(1)` once; do not fail on the first and make the user re-run.
- A flag the dashboard sends must exist in argparse, or the process exits 2 at spawn and the card
  sits at STOPPED with no explanation (`82f56a4`).

### 3. Identity and files
`STRATEGY_KEY_DEFAULT = "nifty_my_strategy"`; `state_key = f"{KEY}_{args.instance_id}"` if an id is
given, else the bare key. That key must match byte for byte across the script, `strategyRegistry.ts`,
the state/trigger filenames and the logs registry. Files a strategy owns:

| File | Written by | Purpose |
|---|---|---|
| `debug/<key>_state.json` | `save_strategy_state()` | what the dashboard shows (async, ~0.5 s behind) |
| `debug/<key>_position.json` (or `_portfolio.json`) | the strategy, atomically | restart truth for anything held across a crash |
| `debug/<key>_shutdown.trigger` | dashboard | Stop button; consumed by `check_shutdown_trigger()` |
| `debug/logs/<folder>/YYYYMMDD[_<id>].log` | logging | flushed per record, `instance_log_suffix()` in the name |

Logging is configured at import time, before `argparse` runs, so the log filename uses
`instance_log_suffix()` (it sniffs `sys.argv`). Use a `FlushingFileHandler` so a crash doesn't lose
the last lines. Log via `logger`, never `print`, so the dashboard log viewer sees it.

### 4. Startup sequence (order matters)
1. Parse and validate args, build `state_key`.
2. `get_dhan_client()`; fail loudly if it returns None.
3. `ExecutionBroker.create(...)` inside `try/except ExecutionBrokerError` then `sys.exit(1)`;
   never trade with no working broker. Market data always comes from `DhanHelper`.
4. `exit_if_market_closed(helper, dry_run)` (NSE strategies); MCX has its own session wait.
5. Start the WebSocket for the index/underlying and subscribe every leg you will monitor. Lot size
   comes from `helper.get_lot_size()`, never a constant.
6. **Load persisted position, subscribe its legs again** (subscriptions are per process), reconcile
   against the broker (`references/state-and-recovery.md`).

### 5. Main loop skeleton
```
while True:
    shutdown trigger?  -> exit_all (check result) -> save STOPPED / "EXIT INCOMPLETE" -> exit
    market closed?     -> save WAITING/HOLDING, wait_for_market_open(shutdown_check=...) ; continue
    read spot/ltps     -> skip the tick if a price is <= 0 (stale), never act on 0
    flat?              -> entry gate (time window, guards) -> enter ; save state ; sleep ; continue
    in position        -> compute total_pnl ; save state ; per-leg SL / roll ; trail ; target/SL ;
                          signal exit ; EOD exit
    sleep 1-2 s
```
`check_shutdown_trigger()` runs at the top of the loop **and** inside every wait/sleep helper (pass
`shutdown_check=lambda: check_shutdown_trigger(self.state_key)`), or Stop hangs until the wait ends.
Wrap `run()` in `try/except KeyboardInterrupt` that does the same exit-and-save as the trigger.
Intraday strategies flatten at **15:17 IST** (`--eod-time`); MCX at 23:30; positional strategies
document their exception loudly (`overnight_fly`, `momentum_investing`).

### 6. Orders: every call is checked, every fill is confirmed
This is where the money is lost. The rules, each with its incident, are in
`references/order-safety.md`; the short form:
- A `broker.buy/sell` that returns falsy means **stop and undo**, never log-and-continue (`c51eff6`).
- `wait_for_fill()` returns a **bool**, not a price; read the fill price from `get_order_by_id()` and
  fall back to LTP (`466e225`: a bool booked as Rs 1 entry price tripped the SL instantly).
- Multi-leg entries are all-or-nothing: if leg 2 fails, close leg 1 and return flat. Buy the hedge
  before or with the short, and treat "could not hedge" as an emergency unwind.
- Exits use `resolve_exit_qty()` / `resolve_exit_qty_broker()`, never `get_net_quantity()` directly:
  Dhan nets by security id, so an instance that sizes off the broker net flattens its sibling's
  leg (`2c874d5`, the 2026-07-30 loss).
- A leg leaves tracking only after its close is confirmed; `exit_all()` returns a bool and the caller
  keeps a retry status (`UNWINDING` / `FLATTENING`) until it is True (`6f0a778`).
- Product type is explicit and constant per strategy: `INTRADAY` for same-day, `MARGIN` for
  carry-forward, `CNC` for delivery. A wrong product is force-squared by the broker's RMS.
- Zerodha/Kotak have no resting stop order here; SL and targets are software-polled, so the loop must
  stay alive and responsive.

### 7. P&L accounting
- `realized_pnl` accumulates on **every** close (roll, leg SL, full exit), priced at the actual fill.
- `total_pnl = realized_pnl + unrealized`, so it is continuous across rolls. Targets, stops and
  trailing stops all read `total_pnl`; nothing keeps its own baseline that a roll can invalidate
  (`2c874d5`: the trail was mathematically dead after the first roll).
- Book a close **once**: change state to flat first, then charge the roll, then re-enter (`2b6a433`
  re-booked the same close every second until the fake P&L hit the target).
- Trailing stop = rupee MTM: arm at `--trail-start-rs`, exit on a `--trail-gap-rs` giveback from
  `best_pnl`. Re-derive `total_pnl` after any roll in the same tick before deciding.
- Daily caps must survive a restart: restore cumulative P&L from today's state file on startup
  (`4aa3242`), otherwise a crash resets the loss limit.
- Write `total_pnl` (the dashboard badge reads that key, `b70fba0`), not only `daily_pnl`.

### 8. Guards every strategy considers
Include the ones that apply; leaving one out should be a decision, not an oversight.
- Strike inversion `CE strike > PE strike` after entry and every adjustment; violation means
  emergency exit plus a 5-minute pause (`nifty_delta_neutral` is the sanctioned exception).
- Caps that stop compounding into a trend: `--max-rolls`, `--max-trades-per-day`, `--max-lots`,
  loss-streak pause, per-symbol cooldown.
- Re-entry and flip guards: cooldown candles/minutes, `--min-hold-minutes` so a signal computed from
  session-old data cannot exit seconds after entry (`3366b49`).
- Entry-quality gates: premium balance, bid/ask spread cap, VWAP warm-up bars, ATM-shift hysteresis
  (`9c0b8b2`), skipping a zero or stale quote.
- API discipline: the quote API allows ~1 req/s account-wide. Batch with `helper.get_ltps()`, use the
  WebSocket, and refresh candles/indicators once per candle interval, not once per second
  (`466e225`). Check `helper.last_api_error` before deciding "no data".

### 9. State file contract
Call `save_strategy_state(self.state_key, {...})` after every meaningful change and before any
crash-exit (`c7660bf`: exiting without it left the dashboard showing RUNNING for a dead process).
Minimum keys: `strategy`, `status`, `dry_run`, `broker`, `lots`, `spot`, `total_pnl`,
`realized_pnl`, the leg dict(s) with strikes populated (a never-assigned `short_strike` showed as
null for a whole position, `466e225`), and the config the UI echoes. `pid` and `last_update` are
injected for you. Status vocabulary: `WAITING`, `RUNNING`, `BALANCING`, `UNWINDING`, `FLATTENING`,
`STOPPED`, `STOPPED (EXIT INCOMPLETE - VERIFY MANUALLY)`, `HOLDING OVERNIGHT`, `ERROR`. Publish a
heartbeat status for long waits so the dashboard can tell "balancing" from "hung".

### 10. Notifications
`from lib.telegram_alert import notify` for stop, emergency exit and large P&L events; it no-ops
when unconfigured and never raises, so it is safe on the trading path. Keep messages prefixed with
`[{state_key}]`.

## Strategy spec (`strategy.md`)
Write it first; keep it at the depth of `strategies/overnight_fly/strategy.md`. Sections:
1. **Why / edge hypothesis**, the source if it is from a video or paper, and validation status
   (backtested? over how many sessions? result?). If unvalidated, say so at the top.
2. **Instruments and product** (underlying, expiry rule, lot source, `INTRADAY`/`MARGIN`/`CNC`).
3. **Entry**: time window, signals with their exact thresholds, sizing, strike selection.
4. **Adjustment**: each trigger, the action, the cap, and what happens past the cap.
5. **Exit**: target, stop, trail, signal, time; which is checked first when several fire together.
6. **Failure modes table**: one row per order or data failure (entry leg 2 fails, hedge fails, close
   rejected, quote is 0, process killed mid-roll) and the resulting tracked state.
7. **Restart behaviour**: what is persisted, what is reconciled, when it refuses to start.
8. **Deliberately not done** in this version.
9. **CLI reference** block (also mirrored into `GEMINI.md`).

## Verification before `--live`
- [ ] `python <script>` (no flag) runs after hours, writes `debug/<key>_state.json`, and updates it.
- [ ] Dashboard lists it, Start launches it with only flags argparse defines, Stop exits it cleanly
      (also while it is inside a wait), and its log opens in the log viewer.
- [ ] `--instance-id x` produces separate `_x` state and log files; no-id filenames are unchanged.
- [ ] Kill the process mid-position and restart: the legs are restored, resubscribed, reconciled, and
      it does not re-enter. Corrupt the position file: it refuses to start.
- [ ] Simulate each row of the failure-mode table (make `broker.buy` return `None`) and confirm the
      tracked state matches reality afterwards (adapt `assets/smoke_test_skeleton.py`).
- [ ] A paper position file cannot be picked up by a live run (persist `dry_run`; refuse a mismatch).
- [ ] Unit tests for the pure decision functions and for any new exit-sizing path.
- [ ] Run `dhan-strategy-auditor` on the file; fix its findings.
- [ ] First live session: 1 lot, watched in the broker app.

## References
- `references/order-safety.md`: entry/exit/roll patterns with the incident behind each rule.
- `references/state-and-recovery.md`: position file, atomic writes, restore, reconcile, status machine.
- `references/dashboard-wiring.md`: every registry and UI branch a new strategy touches.
- `references/strategy-families.md`: which existing strategy to copy for which kind of idea, and each
  family's specific traps (MCX segments, CNC, equity).
- `assets/strategy_skeleton.py`: runnable dry-run-first skeleton implementing the kit.
- `assets/smoke_test_skeleton.py`: stub-broker test (no network, no orders) that proves the failure paths
  above; copy and point it at your strategy. Run: `venv/bin/python <file> [strategy.py]`.

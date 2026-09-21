# State, Persistence and Restart Recovery

A strategy process can die at any moment (crash, machine sleep, Stop button, a deploy). The broker
position outlives it. This file covers the three separate pieces of state and how a restart rebuilds
trust in them.

## Contents
1. Three kinds of state
2. Atomic writes
3. Restore on startup
4. Reconcile against the broker
5. Paper vs live positions
6. Status machine
7. Daily counters that must survive a restart
8. What `save_strategy_state()` does and does not do

## 1. Three kinds of state
| Kind | File | Read by | Loss means |
|---|---|---|---|
| Dashboard state | `debug/<key>_state.json` | dashboard | a stale card; harmless |
| Position truth | `debug/<key>_position.json` / `_portfolio.json` | this strategy on restart | it forgets a live leg: re-enters on top, or never exits a hedge |
| Broker truth | the broker | reconcile only | n/a (ground truth) |

Never use the dashboard state file as the restart source: `save_strategy_state()` rewrites it every
cycle with only the fields the loop currently tracks and it is written asynchronously.

Only strategies that can hold a position across a process death need a position file. In practice: all
positional ones (`overnight_fly`, `delta_strangle`, `momentum_investing`), and any intraday strategy
where a crash mid-day would strand a live leg. For an intraday strategy the minimum is restoring
cumulative daily P&L (`crudeoil`, `4aa3242`).

## 2. Atomic writes
```python
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
os.replace(tmp, path)        # atomic on Windows and Linux
```
A torn position file is the one thing that can lose a live hedge. Save the position file at every
change to legs, quantities, roll counts, `best_pnl`/trail flags and realized P&L, and include a
`version` field, `updated_at`, `lots`, `lot_size` and `dry_run`.

## 3. Restore on startup
```python
if not os.path.exists(path):  start flat
try: data = json.load(f)
except Exception: logger.error("FATAL ... refusing to trade blind"); raise
```
- **Refuse to start on a corrupt file.** Starting flat with a live overnight hedge either re-enters a
  second straddle or abandons the hedge that makes the strategy defined-risk.
- Restore `lot_size` from the file while a position is open; a fresh entry re-fetches it.
- **Resubscribe every held leg** to the WebSocket (`helper.subscribe_instruments`); subscriptions are
  per process, so a restart leaves live legs with no ticks and `get_ltp()` falling back to slow REST.
- Restore trail state (`trail_active`, `best_pnl`) and roll counts so caps are not reset by a restart.
- Log one line summarising what was restored (strikes, expiry, realized P&L).

## 4. Reconcile against the broker
After restoring an open position in live mode, compare each leg's expected net quantity with
`broker.get_owned_net_qty()`:
- Mismatch means someone squared it off manually, or another instance touched it. Log the exact
  expected vs actual per leg.
- Default is to **refuse to start** and require a human decision. `delta_strangle` adds
  `--force-reconcile` to continue anyway.
- Reconcile is diagnostic. It must never be used to size an exit; `resolve_exit_qty_broker()` owns that.
- A reconcile read that throws is logged and skipped for that leg, not treated as a mismatch.

## 5. Paper vs live positions
Both `overnight_fly` and `delta_strangle` write their position file in dry-run too, and neither
currently refuses to load a paper position into a live run (`delta_strangle` stores `dry_run` but the
restore does not check it; `overnight_fly` does not store it). A paper run followed by `--live` would
then "restore" a position that does not exist at the broker and try to exit it. New strategies should:
- store `dry_run` in the position file;
- on restore, if `data["dry_run"] != self.dry_run` and a position is open, log an error and refuse to
  start (or discard the paper file after an explicit confirmation flag).

## 6. Status machine
Model status as an explicit small state machine and persist it when it can matter after a restart.
`delta_strangle` is the reference:

```
IDLE --entry ok--> ENTERED --scheduled/emergency exit--> IDLE
                     |  \--exit only partly confirmed--> FLATTENING --retry until flat--> IDLE
                     \--entry leg 2 failed, leg 1 stuck--> UNWINDING --retry until flat--> IDLE
```
- `UNWINDING` and `FLATTENING` are retry states: each poll re-attempts the close and nothing else.
  `monitor()` must not run in them, or it will refill the just-cleared side while the other leg is
  still stuck open.
- Restore all three of `ENTERED`, `UNWINDING`, `FLATTENING` as "position open" on restart.
- The dashboard shows the status string verbatim, so keep the vocabulary stable and human-readable.

## 7. Daily counters that must survive a restart
`cumulative_pnl`, `trades_today`, `loss_streak`, `last_exit_time` for cooldowns, per-symbol trade
counts. If a limit exists to cap a day's damage, a restart must not reset it. Restore from today's
`_state.json` only when its `last_update` date is today, otherwise start from zero.

## 8. What `save_strategy_state()` does and does not do
- Enqueues a deep-copied snapshot; a daemon thread coalesces and writes at most every ~0.5 s. It is
  cheap on the hot loop and safe to call every tick.
- Injects `last_update` and `pid` for you.
- Registers an `atexit` flush, but a hard kill can lose the last half second. Call `flush_state()`
  yourself before a deliberate `sys.exit()`.
- It does not write your position file and it swallows its own exceptions (logged, never raised).

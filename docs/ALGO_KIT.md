# algo_kit: plug-and-play strategy building blocks

`lib/algo_kit/` holds the plumbing every strategy used to copy-paste (state files, fills, quotes,
trailing stops, CLI flags). Each module is independent, imports no broker SDK, and has unit tests in
`tests/test_algo_kit.py`. A strategy keeps its own `run()` loop and imports only what it needs.

```python
from lib.algo_kit import (
    setup_strategy_logging, PositionStore, load_today_state, confirmed_fill_price,
    is_quote_invalid, extract_quote_fields, fetch_named_ltps, interruptible_sleep,
    TargetSpec, TrailingStop, Cooldown, in_window, past_time, cli,
)
```

## Modules

| Module | Use it for | Replaces |
|---|---|---|
| `files` | `setup_strategy_logging(root, LOG_FOLDER, instance_log_suffix(), name=__name__)`, `atomic_write_json`, `FlushingFileHandler` (UTF-8, so rupee lines are not dropped on Windows), `find_project_root`; `force=True` replaces handlers a library already installed; `log_file=` overrides the whole path for a legacy log location | the 15-line logging block and `FlushingFileHandler` pasted into every strategy |
| `position_store` | `PositionStore(path, dry_run, version=N, enforce_mode=True)` `.save(payload)` / `.load()`; `load_today_state(state_path)` for daily caps | per-strategy `save_position` / `load_position` / `_restore_daily_pnl` |
| `confirm` | `confirm_order_fill(helper, broker, broker_name, oid, strike, expiry, opt_type, signed_qty, net_before)`: Dhan order status, or the broker's own net position for Zerodha/Kotak | bare `helper.wait_for_fill()` on a non-Dhan order id |
| `legs` | `LegExecutor(broker, helper, broker_name, product, dry_run, ltp_fn)` `.open_all(specs, checkpoint=)` / `.close_all(legs, on_closed=)` / `.close_leg(leg)`: confirmed entry, rollback of a partly built book, shorts-before-hedges close sized by `resolve_exit_qty_broker` | the entry/unwind/exit blocks copied into each multi-leg strategy |
| `fills` | `confirmed_fill_price(helper, order_id, fallback)` (wait, then read); `read_order_fill_price(...)` (read only, fill already confirmed); both take `raise_errors` and `paper_id`. Dhan order ids only | `get_execution_price` / `_fill_price` |
| `quotes` | `is_quote_invalid(q, strict=)`, `extract_quote_fields(q, lot, expiry, symbol)`, `extract_flat_chain_fields(row, ce_or_pe, ...)`, `fetch_named_ltps(helper, {"ce": (seg, id), ...})` | `is_quote_invalid`, `_extract_quote_fields`, `fetch_ltps` |
| `waits` | `interruptible_sleep(seconds, shutdown_check, on_tick)` returns False on shutdown | `sleep_cooldown` |
| `risk` | `TargetSpec` (rupee or % resolved once), `TrailingStop`, `Cooldown`, `in_window`, `past_time` | inline trail / cooldown / time-window code |
| `cli` | `add_execution_args`, `add_exit_args`, `add_window_args`, matching `validate_*`, `build_state_key`, `exit_on_errors` | `build_parser` / `validate` boilerplate |

Not part of the kit (already shared, keep using): `lib/strategy_state_helper.py` (dashboard state,
shutdown trigger, `parse_target_spec`), `lib/strategy_risk.py` (`resolve_exit_qty*`,
`detect_phantom_leg*`), `lib/execution_broker.py`, `lib/options_pricing.py`, `lib/trade_stops.py`.

## Compose a strategy

```python
# bootstrap: the project root must be on sys.path BEFORE lib is importable, so these 9 lines stay
# in the strategy file (copy from the skeleton)
project_root = _find_project_root(os.path.dirname(__file__)); sys.path.insert(0, project_root)

from lib.algo_kit import PositionStore, TrailingStop, TargetSpec, confirmed_fill_price, setup_strategy_logging
logger = setup_strategy_logging(project_root, LOG_FOLDER, instance_log_suffix(), name=__name__)

class Strategy:
    def __init__(...):
        self.store = PositionStore(self.position_path, dry_run, log=logger)
        self.trail = TrailingStop(trail_start_rs, trail_gap_rs)
        self.target = TargetSpec.from_parsed(parse_target_spec("4000"))
        self.load_position()

    def save_position(self):
        self.store.save({"position_open": ..., "legs": self.legs, **self.trail.to_dict()})

    def load_position(self):
        data = self.store.load(expiry_field="expiry")     # None = start flat
        ...
    # in the loop:  if self.trail.update(total_pnl): self.exit_all("Trailing SL")
```

## Contracts worth knowing

- **A checkpointed leg is `pending` until its order resolves** (2026-10-06). `open_all` sets `leg["pending"]=True` before the
  checkpoint and clears it when `open_leg` returns. `close_leg` on a pending leg (a restart after a crash mid-entry) calls it
  flat only when the broker shows nothing in its direction; if the broker shows a position it could be a sibling instance's,
  so the leg stays tracked and a human decides. A UNWINDING book must keep that status when an entry rollback leaves stuck legs
  (the strategy loop must not overwrite it, or the retry branch never runs).
- **No order without a baseline** (2026-10-06): `open_leg` raises `BaselineUnavailable` internally and sends nothing when the
  pre-order broker read fails, because a default of 0 makes the later confirmation compare against the wrong net.
- **A paper close with no quote closes at the entry price** (zero P&L), never at 0 and never deferred forever.
- **`LegExecutor` never reports a leg closed it did not confirm.** `open_all` calls your `checkpoint(tracked_legs)`
  BEFORE each order (a crash mid-entry then leaves a tracked, restartable book), confirms every fill (Dhan status, or
  the broker's own net for Zerodha/Kotak), cancels an unconfirmed Dhan order (only a REJECTED one is known unfilled),
  and on a failure closes what it placed. Read `result.stuck`: anything in it is still live at the broker and must
  stay tracked (status UNWINDING). `close_all` closes shorts first and holds a hedge while any short is open, sizes
  each close with `resolve_exit_qty_broker`, and keeps a leg tracked if the lookup fails or the close is unconfirmed.
  It does not book P&L or unsubscribe: use `on_closed(name, leg, exit_price, qty_closed)` to do that per leg.

- **`PositionStore.load()` raises `PositionFileError`** for an unreadable file, an open position saved
  by the other mode (paper vs live), and an open LIVE position whose `expiry_field` has passed. Let it
  propagate: the process exits non-zero and never trades blind. A flat file is returned as-is, so
  cross-cycle memory (`entry_month`, `consecutive_stops`, lifetime P&L) survives and is not blocked by a
  mode mismatch. An expired PAPER position is discarded: you get `position_open=False,
  discarded_expired=True` and the file is rewritten flat. Pass `expiry_field=None` to skip the expiry check.
- **`confirmed_fill_price` never returns the `wait_for_fill` bool.** Paper and empty ids return the fallback.
- **`TargetSpec.resolve(entry_value)` returns `None` while a percent has no base yet.** Guard before
  comparing. A percent is resolved once, against the day's first entry value.
- **`interruptible_sleep` returns False on shutdown;** the caller does its own exit-and-save.
- **`is_quote_invalid` is lenient by default** (a non-`CONTRACT_INFO` dict passes, as the spread
  strategies always allowed); `strict=True` is the `st_oi_bearcall` behaviour.

## Migration status

Every duplicate that existed as an EXACT variant has been moved onto the kit, and each move was checked
against the pre-migration code with a differential run (same inputs through the original and the migrated
method; fill, quote, persistence and restore cases compared field by field).

| Kit part | Strategies on it |
|---|---|
| `setup_strategy_logging` (UTF-8, flushed, dashboard-matching folder) | all 26 |
| `PositionStore` | volcano_calendar, put_condor, condor_to_ratio, diagonal_call, overnight_fly, delta_strangle |
| `load_today_state` (daily P&L / brakes restore) | crudeoilm_ema_supertrend, _orb, _renko_sar, _supertrend, _vwap_supertrend, intraday_equity |
| `confirmed_fill_price` / `read_order_fill_price` | vix_straddle, vwap_1min_straddle, spread_trend, st_oi_bearcall, advanced_imbalance, delta_neutral, value_imbalance_straddle/strangle, rolling_straddle, winner_roll_straddle, overnight_fly, condor_to_ratio, flyagonal, put_condor, volcano_calendar |
| `is_quote_invalid`, `extract_quote_fields`, `extract_flat_chain_fields`, `fetch_named_ltps` | spread_trend, st_oi_bearcall, advanced_imbalance, delta_neutral, value_imbalance_straddle/strangle, rolling_straddle, winner_roll_straddle |
| `interruptible_sleep` | delta_neutral, rolling_straddle, value_imbalance_straddle/strangle, winner_roll_straddle |
| `confirm_order_fill` | volcano_calendar (close path), put_condor |
| `update_trail` | condor_to_ratio, strategy_skeleton |

Where a migrated strategy's original differed from the kit's default, the call passes the switch that keeps the
original behaviour: `raise_errors=True` (original raised on a failed order lookup), `paper_id=None` (original had
no "PAPER" shortcut), `enforce_mode=False` (overnight_fly never refused a paper/live mismatch). These are
decisions waiting to be taken, not bugs; flipping one is a behaviour change to review on its own.

Deliberate differences from the originals (everything else compared identical):
- `volcano_calendar`: refuses an open LIVE position whose near expiry passed; non-Dhan fill price is the LTP and a
  non-Dhan close is confirmed from the broker's net position (the old code stranded the leg).
- `overnight_fly` and `delta_strangle`: the position file now records `dry_run` (no refusal yet), and its log is UTF-8 and flushed.
- `put_condor`, `volcano_calendar`: log files are UTF-8 (they used the system codepage).
- `st_oi_bearcall`: none beyond the shared plumbing.

## Not migrated (and why)

- **Inline trailing stops** (`value_imbalance/*`, `overnight_fly`, `rolling_straddle`, `winner_roll`, ...): the trail is
  interleaved with logging and exit actions inside the main loop. Replacing it restructures live control flow and
  those loops have no tests. `TrailingStop` is ready; adopt it per strategy with a test first.
- **CLI flag groups** (`algo_kit.cli`): flag names differ per strategy (`--eod-exit-time`, `--eod-time`) and the
  dashboard sends specific names. The skeleton uses the groups; existing strategies keep theirs.
- **`advanced_imbalance.sleep_cooldown`** (calls its own `_stop_if_requested`) and **`rolling_straddle.fetch_ltps`**
  (delegates to `_fetch_ltps_for`): different shapes, left as they are.
- **Inline fill parsing** still in `crudeoilm_*` (5), `oi_directional`, `vwap_1min_straddle` (exit leg),
  `vix_straddle`, `diagonal_call`, `intraday_equity`: embedded in their order flows (each with its own fallback)
  rather than in a helper method, so there is no exact copy to swap.
- **Persistence that does not fit `PositionStore`**: `flyagonal` decides "open" from a status string (the store
  checks a `position_open` flag), `adaptive_strangle` ignores a mismatched file instead of refusing it, and
  `momentum_investing` persists `Position` objects and a nested config.

## Variants that are not copies

Several helpers look duplicated but differ on purpose; migrating them means choosing, not deleting.
- Fill price has two shapes: `confirmed_fill_price` waits then reads; `read_order_fill_price` only reads
  (put_condor confirms through its own `_confirm`, which also handles Zerodha/Kotak by net position).
- `_extract_quote_fields` exists in five forms (default lot size source, expiry fallback, symbol format,
  empty-quote return). `extract_quote_fields` takes those as parameters; check each caller's defaults.
- CLI flag names differ (`--eod-exit-time` in the monthly strategies, `--eod-time` in the skeleton).
  The dashboard sends specific flag names, so do not rename a flag during a migration.

## Known gaps (found while migrating; not fixed)

Broker-aware confirmation. `helper.wait_for_fill()` polls Dhan, so for `--broker zerodha|kotak` it cannot confirm that
broker's order id. `volcano_calendar` was fixed and `put_condor` uses `confirm_order_fill`; `flyagonal`,
`delta_strangle` and `diagonal_call` already guard on the broker. These broker-selectable strategies still call
`helper.wait_for_fill` with no Dhan guard: `condor_to_ratio`, `adaptive_strangle`, `value_imbalance/*`,
`st_oi_bearcall`, `spread_trend`, `oi_directional`, `overnight_fly`, `vwap_1min_straddle`, `vix_straddle`.
UNCONFIRMED against the live Dhan API: read from the code, not reproduced with a real non-Dhan order.
Fix pattern: `confirm_order_fill` with `net_before` read first.

`st_oi_bearcall`: exits are sized `lot_size * lots` (not clamped by `resolve_exit_qty_broker`); a non-Dhan short close
hits `_halt("did not fill")`; non-Dhan entry prices come back as 0.0; there is no position file, so no restart recovery.

`overnight_fly`: a paper position file can be resumed by a live run (no mode check; see `enforce_mode`).

`volcano_calendar`: entry orders are not fill-confirmed (a truthy order id is treated as filled); fixing it needs the
UNWINDING handling `put_condor` has.

`overnight_fly` and `intraday_equity` write logs the dashboard log viewer cannot show: `overnight_fly` logs to
`debug/nifty_overnight_fly.log` and neither is in `STRATEGY_LOG_DIRS`
(`rs_dashboard/app/api/strategies/logs/route.ts`). `tests/test_strategy_kit_invariants.py` keeps every other
strategy's log folder in step with that registry.

## Runtime checks (dry-run, 2026-10-05)

Sixteen strategies were started for ~40 s each in dry-run (no `--live`, `--instance-id randtest`, Telegram blanked,
stopped with the dashboard's `shutdown.trigger`): both crude strategies ran their live loop on real MCX candles
(one took and closed a simulated trade), and the NSE strategies, with NSE closed, started, resolved contracts,
subscribed, and honoured the trigger. Every run exited 0 and the order book was unchanged. `--instance-id` isolates
state, position and log files, so a test run cannot touch a real instance's files.

`oi_directional` used to spin at full CPU in dry-run after 15:17 (about 6,000 log lines/s): the inner session loop
breaks at 15:17 and the outer loop restarted at once because dry-run bypasses the market-hours wait. Fixed with
`_wait_out_session_end()` (dry-run waits shutdown-aware until the clock passes midnight; live mode already waited);
`tests/test_oi_directional_session_end.py`. Check any other strategy that bypasses the wait in dry-run the same way.

## Running the tests safely

Only run the stubbed suites: `tests/test_algo_kit.py`, `tests/test_strategy_kit_invariants.py`, the strategy tests
(`test_put_condor.py`, `test_condor_ratio.py`, ...) and `smoke_test_skeleton.py`. Never run `tests/test_*.py` with a
wildcard (`test_11_maintenance.py` also OVERWRITES `master_list.csv` with only the NSE_EQ/NSE_FNO segments, which
breaks every MCX and BSE/SENSEX lookup until `helper.fetch_security_list()` is run with its default segments): the numbered tests (01-19) and several others talk to the real account, and `test_06_orders.py` places AMO
orders while `test_11` / `test_13` call `cancel_all_orders()`.

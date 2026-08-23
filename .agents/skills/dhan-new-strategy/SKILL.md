---
name: dhan-new-strategy
description: Use when creating a new live trading strategy script in strategies/, wiring it into the dashboard's start/stop controls, or reviewing an existing strategy for missing dry-run/shutdown/state-bridge wiring.
---

# Dhan New Strategy Scaffold

## Overview
Every strategy in this repo is a standalone script with its own CLI, main loop, and
`--live`/dry-run switch — but they all share three integration points with the
dashboard. Missing any one of them makes the strategy invisible or unstoppable
from `rs_dashboard`, even if the trading logic itself is correct.

## When to Use
- Adding a new file under `strategies/<family>/`.
- Reviewing a strategy someone else wrote and it doesn't show up as running, or
  the dashboard's Stop button does nothing.
- Not for one-off backtest/analysis scripts under `scripts/analysis/` — those don't
  need the state bridge.

## The Three Integration Points

1. **State file** — call `save_strategy_state(STRATEGY_KEY, {...})` every loop
   iteration. Writes `debug/<STRATEGY_KEY>_state.json` atomically (temp file +
   `os.replace`). The dashboard's `/api/strategies` reads this file and cross-checks
   the `pid` field (auto-injected) against `tasklist` to show running/stopped.
2. **Shutdown trigger** — call `check_shutdown_trigger(STRATEGY_KEY)` inside the
   loop (and inside any inner wait loops) and break/exit cleanly when it returns
   `True`. The dashboard's Stop button writes `debug/<STRATEGY_KEY>_shutdown.trigger`;
   the helper deletes it after detecting it, so check it from every sleep point,
   not just the outer loop.
3. **Dashboard registration** — add an entry to `STRATEGIES_METADATA` in
   `rs_dashboard/app/api/strategies/route.ts` mapping `STRATEGY_KEY` → display name
   + absolute script path (`path.join(PROJECT_ROOT, 'strategies', ...)`). Without
   this the script runs fine standalone but the dashboard never lists it.

`STRATEGY_KEY` must be identical (byte-for-byte) across the Python file, the
`route.ts` metadata key, and the `debug/*_state.json` / `*_shutdown.trigger`
filenames — a mismatch silently breaks the bridge with no error.

## Quick Reference

| Need | Call |
|---|---|
| Import | `from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger, exit_if_market_closed` |
| Bail out-of-hours (unless `--dry-run`) | `exit_if_market_closed(helper, dry_run=args.dry_run)` |
| Persist state | `save_strategy_state(STRATEGY_KEY, {"status": ..., "positions": ..., ...})` |
| Check for Stop button | `if check_shutdown_trigger(STRATEGY_KEY): break` |
| Client + helper | `dhan = get_dhan_client(); helper = DhanHelper(dhan)` |

## Implementation

1. Copy `templates/strategy_template.py` as a starting point — it already has the
   `DhanHelper` init, market-hours check, and a try/except main loop.
2. Add CLI args with `argparse` (`--live` default `False` so every strategy is
   dry-run by default; see `strategies/oi_directional/nifty_oi_directional.py`
   bottom-of-file `if __name__ == "__main__":` block for the standard shape —
   `RawDescriptionHelpFormatter` + an `epilog` with runnable examples).
3. Define `STRATEGY_KEY = "nifty_my_new_strategy"` near the top of the file.
4. In the main loop: check `check_shutdown_trigger(STRATEGY_KEY)` at the top of
   the loop AND inside any inner polling/sleep helper; call
   `save_strategy_state(STRATEGY_KEY, {...})` after every meaningful state change
   (not just once at start).
5. Register the strategy in `rs_dashboard/app/api/strategies/route.ts`'s
   `STRATEGIES_METADATA` map.
6. Add a CLI reference block to `GEMINI.md` and a `strategy.md` next to the script
   if the logic is non-trivial (see `strategies/oi_directional/strategy.md` for
   the expected depth).
7. Dry-run it first: `venv\Scripts\python.exe strategies/<family>/<script>.py`
   (no `--live`) and confirm `debug/<STRATEGY_KEY>_state.json` appears and updates.

## Common Mistakes

- Forgetting `exit_if_market_closed`/`is_market_open()` guard → strategy throws
  API errors when run after-hours instead of idling.
- Checking the shutdown trigger only in the outer `while True` — if the strategy
  blocks in `wait_for_next_day_market_open()` or a long poll sleep, Stop appears
  to hang until that inner wait finishes. Pass `shutdown_check=lambda: check_shutdown_trigger(STRATEGY_KEY)` into helper wait functions that accept it.
- `STRATEGY_KEY` typo mismatch between the Python file and `route.ts` — dashboard
  shows the strategy as permanently stopped even though the process is running.
- Using `ltp()` / bare `exchange_segment=` instead of `get_ltp(..., exchange=...)` —
  see project AGENTS.md "Critical API Conventions" for the full DhanHelper pitfall list.
- Sizing an exit off `helper.get_net_quantity()` directly. Dhan nets positions by
  security ID, so if this strategy can ever share a strike/security ID with another
  running instance, the first one to exit will flatten the other's leg too. Use
  `lib/strategy_risk.py`'s `resolve_exit_qty(helper, security_id, own_qty, side)`,
  which clamps to what *this* strategy opened.

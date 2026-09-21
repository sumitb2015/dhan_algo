# Dashboard Wiring for a New Strategy

The script runs fine standalone. It is invisible, unstartable or unstoppable from the dashboard until
every place below agrees on the same `STRATEGY_KEY`. (The previous version of this skill said the
registry lives in `app/api/strategies/route.ts`; it now lives in `lib/strategyRegistry.ts`.)

## Contents
1. Checklist
2. `lib/strategyRegistry.ts`
3. Logs registry
4. Launcher config UI (the one that silently breaks)
5. Instances and the Exit-All sweep
6. Docs
7. Known gaps at the time of writing

## 1. Checklist
| # | Where | What |
|---|---|---|
| 1 | script | `STRATEGY_KEY_DEFAULT`, `--instance-id`, `save_strategy_state`, `check_shutdown_trigger` |
| 2 | `rs_dashboard/lib/strategyRegistry.ts` `STRATEGIES_METADATA` | name, underlying, `logicGroup`, `timeframe`, absolute `path`, `execBrokerEligible` |
| 3 | `rs_dashboard/app/api/strategies/logs/route.ts` `STRATEGY_LOG_DIRS` | key to log folder name |
| 4 | `components/StrategyCard.tsx` **and** `components/StrategyRowWide.tsx` | a per-key branch that builds argv and renders its config fields |
| 5 | `GEMINI.md` | CLI reference block |
| 6 | `strategies/<family>/strategy.md` | the spec |
| 7 | `tests/` | pure-logic tests; `tests/test_strategy_risk.py` shape for exit sizing |

## 2. `lib/strategyRegistry.ts`
- `underlying` groups rows on `/strategies-plus`; group order follows the object's key order, so insert
  the entry beside its siblings.
- `logicGroup` must be a key of `LOGIC_GROUPS` (`harvest`, `rotation`, `volatility`, `directional`,
  `futures_trend`, `momentum`, `overnight_hedge`). A genuinely new kind of edge needs a new group added
  there and in the `app/strategies-plus/page.tsx` group table (icon + accent).
- `timeframe`: `intraday` or `positional`.
- `execBrokerEligible: true` only if the script accepts `--broker` and routes orders through
  `ExecutionBroker`. It turns on the dashboard's broker selector, which appends `--broker`.
- Every consumer (`/api/strategies`, `/api/exit-all`, instance discovery) reads this one object, so
  the entry also enrols the strategy in the Exit-All sweep.
- The start route strips any client-supplied `--instance-id` and appends its own; do not send one.

## 3. Logs registry
`STRATEGY_LOG_DIRS` is a **second** registry and the key does not derive from the first: the key is
`nifty_rolling_straddle`, the folder is `rolling_straddle`. Missing here, the strategy launches fine
and then fails with "Invalid or missing strategy key" the first time anyone opens its logs
(`210dfc8`). The script must write to `debug/logs/<folder>/YYYYMMDD[_<id>].log`.

## 4. Launcher config UI
`StrategyCard.tsx` and `StrategyRowWide.tsx` are **two copies** of the launcher and each has its own
`if (meta.key === '...') { args.push(...) }` chain. Any key without a branch falls through to the
generic `else`, which sends `--lots`, `--target-profit`, `--stop-loss` (and for some keys `--start-time`).
If the script's argparse does not define all of those, it exits 2 at spawn, the card sits at STOPPED,
and nothing explains why (`82f56a4`, `nifty_delta_strangle`).

For a new strategy:
1. Add a branch in **both** files pushing exactly the flags the script defines.
2. Add the key to the exclusion lists that hide the generic Target/Stop-Loss/Lots fields when your
   strategy does not use them (the long `meta.key !== ...` chains near the config panel).
3. Mirror the edit identically in both files; they drift otherwise.
4. Commit-on-blur for free-typed fields (`dhan-commit-on-blur`), tooltips for every non-obvious flag.
5. Verify by pressing Start and checking the process is still alive after 5 seconds, not by reading
   the code.

## 5. Instances and the Exit-All sweep
- `+ Add run` on `/strategies-plus` starts another copy with `--instance-id`. State/trigger/log files
  get the `_<id>` suffix; the primary's filenames must stay byte-identical to before the feature.
- Two instances on one security id share one broker position: exits must use `resolve_exit_qty*`.
- Stop writes `debug/<key>_shutdown.trigger`; `force_stop` is the dashboard's separate hard-kill path.
  A strategy that ignores the trigger inside a wait loop will appear to hang until forced.

## 6. Docs
- `strategy.md` per family (spec template in SKILL.md).
- `GEMINI.md`: add the flag reference; project `CLAUDE.md` maps each family in one line, so extend its
  "Per-strategy trading logic" sentence when adding a family.

## 7. Known gaps at the time of writing (verify before relying on them)
- `nifty_overnight_fly` has a registry entry but no `StrategyCard`/`StrategyRowWide` branch, so the
  generic branch would send `--target-profit`/`--stop-loss`, which its argparse does not define: expect
  exit 2 when launched from the Strategies UI. It also logs to `debug/nifty_overnight_fly.log` rather
  than `debug/logs/<folder>/`, and is absent from `STRATEGY_LOG_DIRS`, so its log viewer fails.
- `templates/strategy_template.py` has no state bridge, shutdown check, `--live`/dry-run split or
  restart recovery. `assets/strategy_skeleton.py` in this skill is the working replacement.

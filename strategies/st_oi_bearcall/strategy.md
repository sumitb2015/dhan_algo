# Nifty Supertrend + OI Short-Buildup Bear Call Spread

`nifty_st_oi_bearcall.py` sells a Bear Call Spread on Nifty, but only after the dual Supertrend
confirmation lines up — it will not enter on index weakness alone. An optional fourth
confirmation (short buildup) can be turned on for a stricter filter.

## Entry logic — state machine

```
IDLE ──(index 3m Supertrend bearish)──► WATCHING ──(all 3 confirmed)──► ENTERED
  ▲                                        │  │                            │
  └──────────(index flips bullish,─────────┘  └──(max-wait exceeded)───────┘
              or max-wait exceeded,                     │
              cooldown)                                 ▼
                                                        IDLE (cooldown)
```

- **IDLE** — every loop tick, fetch the index's 1-min candles, resample to `--index-interval`
  minutes (Dhan's intraday API only natively supports 1/5/15/25/60m, so a "3-minute" chart is
  built by resampling 1-min bars with pandas), and compute Supertrend(`--index-st-period`,
  `--index-st-multiplier`). If the last completed bar is bearish, lock a candidate strike —
  `ATM + --ce-offset` (a fixed OTM points offset, not a percentage or delta) — and move to
  **WATCHING**.
- **WATCHING** — polled every `--poll-interval` seconds:
  1. Re-check the index Supertrend. If it has flipped bullish/neutral, abandon the cycle and
     return to IDLE (cooldown).
  2. If `--max-wait-minutes` has elapsed since the candidate was locked without an entry,
     abandon the cycle and return to IDLE (cooldown) — this also protects against holding a
     stale ATM+offset strike while spot has since drifted away. **Keep this above
     `(--option-st-period + 2) * --option-interval` minutes** — the candidate option's own
     Supertrend needs that much same-day candle history before it can be computed at all (candles
     are session-filtered to today only), so a lower value can make a bearish signal near market
     open impossible to ever act on. The strategy logs a startup warning if the configured value
     looks too low for the chosen `--option-st-period`/`--option-interval`.
  3. Fetch the candidate CE's own 1-min candles, resample to `--option-interval` minutes, and
     compute its own Supertrend(`--option-st-period`, `--option-st-multiplier`). If the option
     is not yet below its own Supertrend, keep waiting — no state change.
  4. Once the option's Supertrend does turn bearish, **re-confirm the index is still bearish**
     right before acting (time has passed while waiting for the option).
  5. **Optional** — if `--require-short-buildup` is passed, additionally check the candidate's
     short buildup: a fresh `get_option_chain_df()` snapshot's `ce_price_change_pct` (vs previous
     day's close) must be `<= --min-price-drop-pct`, and `ce_oi_change_pct` (vs previous day's OI)
     must be `>= --min-oi-rise-pct` — the standard NSE short-buildup definition (price down + OI
     up). If not yet met, keep waiting. **This check is disabled by default** — if
     `--require-short-buildup` is not passed, entry proceeds as soon as the dual Supertrend
     confirmation (steps 1-4) holds, and `--min-price-drop-pct`/`--min-oi-rise-pct` are ignored.
  6. When all required conditions hold simultaneously, enter the spread.
- **ENTERED** — standard bear call spread monitoring (target/stop-loss/EOD, plus optional
  early-exit triggers) until the position is closed, then back to IDLE with a cooldown.

## Execution sequence (same as `spread_trend`)

- **Entry**: buy the long (higher-strike) CE hedge first, confirm the fill, then sell the short
  (candidate) CE — never sells the naked short before the hedge is on.
- **Exit**: buy back the short CE first, confirm the fill, then sell the long CE hedge — halts
  the strategy (`sys.exit(1)`) rather than risk a naked leg if either leg's close order fails to
  fill.

## Exit conditions (while ENTERED)

1. EOD square-off at `--eod-time` (hard backstop at 15:17 regardless of the configured value).
2. Market closed (live mode only).
3. Daily profit target reached (`--target-profit`).
4. Daily stop loss hit (`--stop-loss`).
5. Short option's own Supertrend flips back bullish (`--no-exit-on-option-st-flip` to disable),
   gated by `--min-hold-minutes`.
6. Index Supertrend flips back bullish (`--no-exit-on-signal-flip` to disable), gated by
   `--min-hold-minutes` — bypasses cooldown for an immediate re-scan since this is a genuine
   trend reversal, not a risk exit.

## CLI reference

| Flag | Default | Description |
|---|---|---|
| `--live` | off | Live orders; default is dry run |
| `--broker` | `dhan` | Execution broker (`dhan`, `zerodha`, `kotak`). Market data remains on Dhan |
| `--symbol` | `NIFTY` | Underlying (also accepts `BANKNIFTY`) |
| `--index-interval` | `3` | Index candle timeframe in minutes (resampled from 1-min) |
| `--index-st-period` | `10` | Index Supertrend length |
| `--index-st-multiplier` | `2.0` | Index Supertrend multiplier |
| `--option-interval` | `3` | Candidate option candle timeframe in minutes (resampled from 1-min) |
| `--option-st-period` | `10` | Option Supertrend length |
| `--option-st-multiplier` | `2.0` | Option Supertrend multiplier |
| `--ce-offset` | `100` | Fixed OTM points above ATM for the candidate/short CE strike |
| `--spread-width` | `100` | Points between short and long CE strikes |
| `--require-short-buildup` | disabled | Also require the short-buildup filter below before entry |
| `--min-price-drop-pct` | `-0.5` | (Only with `--require-short-buildup`) CE price change vs prev close must be `<=` this |
| `--min-oi-rise-pct` | `5.0` | (Only with `--require-short-buildup`) CE OI change vs prev OI must be `>=` this |
| `--poll-interval` | `30` | Seconds between WATCHING-phase checks |
| `--max-wait-minutes` | `45` | Abandon a watch cycle after this long without entry (see warmup note above) |
| `--lots` | `1` | Lots per spread leg |
| `--target-profit` | `2000.0` | Daily profit target (INR) |
| `--stop-loss` | `2000.0` | Daily stop loss (INR, sign-agnostic) |
| `--no-exit-on-signal-flip` | enabled | Disable early exit on index Supertrend flip |
| `--no-exit-on-option-st-flip` | enabled | Disable early exit on option Supertrend flip |
| `--eod-time` | `15:15` | Square-off time (HH:MM) |
| `--cooldown-minutes` | `5` | Cooldown after an exit or an abandoned watch cycle |
| `--min-hold-minutes` | `5` | Minimum hold before ST-flip exits can trigger |
| `--product-type` | `INTRADAY` | Order product type (`INTRADAY`/`MARGIN`/`CNC`) |

## Run examples

```powershell
# Dry run, defaults
venv\Scripts\python.exe strategies/st_oi_bearcall/nifty_st_oi_bearcall.py

# Live, 2 lots, wider OTM offset, stricter buildup thresholds
venv\Scripts\python.exe strategies/st_oi_bearcall/nifty_st_oi_bearcall.py --live --lots 2 --ce-offset 150 --min-price-drop-pct -1.0 --min-oi-rise-pct 8.0

# Faster polling (max-wait left at a safe default above the option ST warmup time)
venv\Scripts\python.exe strategies/st_oi_bearcall/nifty_st_oi_bearcall.py --poll-interval 15
```

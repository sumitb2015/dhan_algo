# Spread Trend — Configurable Timeframe & Selectable Indicators

**Date:** 2026-06-30
**Scope:** `strategies/spread_trend/nifty_spread_trend.py` + `rs_dashboard/components/StrategyCard.tsx`

---

## Goals

1. Restrict timeframe choices to 1 min, 3 min, and 5 min (add missing 3 min option).
2. Make EMA and Supertrend individually toggleable via CLI flags and UI checkboxes.
3. Remove VWAP — it is not valid for index instruments (Nifty 50 / BankNifty have no meaningful volume).

---

## Python Strategy Changes

### File: `strategies/spread_trend/nifty_spread_trend.py`

#### Constructor

Add two new parameters:

```python
def __init__(self, ..., use_ema=True, use_supertrend=True):
    self.use_ema = use_ema
    self.use_supertrend = use_supertrend
```

#### `get_signal()`

- Build the `indicators` list dynamically — only include `EMA{period}` if `use_ema`, only include supertrend dict if `use_supertrend`.
- Remove VWAP from indicators list and remove all VWAP column lookups and conditions.
- Signal evaluation:
  - Collect individual boolean votes from each enabled indicator.
  - **Bullish** if all enabled votes are bullish.
  - **Bearish** if all enabled votes are bearish.
  - **NEUTRAL** otherwise, including when no indicators are enabled (log a warning in that case).

#### `save_state()`

Add `use_ema` and `use_supertrend` to the state dict so the dashboard can display which indicators are active.

#### CLI flags

```
--no-ema            Disable EMA filter (default: enabled)
--no-supertrend     Disable Supertrend filter (default: enabled)
```

Both use `action="store_false"` with `dest="use_ema"` / `dest="use_supertrend"`.

The `--interval` argument docstring gains `"3"` as a valid value. No validation change needed — the helper already accepts any string.

---

## UI Changes

### File: `rs_dashboard/components/StrategyCard.tsx`

#### New state

```ts
const [useEma, setUseEma] = useState<boolean>(true);
const [useSupertrend, setUseSupertrend] = useState<boolean>(true);
```

#### Timeframe select

Replace the existing 5-option list (1 / 5 / 15 / 30 / 60) with:

```
1 Min | 3 Min | 5 Min
```

Default remains `"5"`.

#### Indicator section (inside spread trend config block)

Two inline rows, each with: checkbox → label → parameter inputs (conditionally rendered).

```
[ ✓ ] EMA         Period: [20]
[ ✓ ] Supertrend  Period: [7]   Multiplier: [3.0]
```

- EMA unchecked → hide EMA Period input.
- Supertrend unchecked → hide ST Period + ST Multiplier inputs.
- Both unchecked → show warning chip *"Enable at least one indicator"* and disable the Launch button.

#### Args building (`handleStart`)

```ts
if (!useEma) args.push('--no-ema');
if (!useSupertrend) args.push('--no-supertrend');
```

#### Running stats strip

Add small indicator badges next to the spread type display while the strategy is running, sourced from `state.use_ema` / `state.use_supertrend`.

Example: `BEAR_CALL  EMA · ST`

---

## Edge Cases

| Situation | Behaviour |
|---|---|
| Both indicators disabled at launch | UI blocks launch with warning |
| Both disabled via CLI | `get_signal()` always returns NEUTRAL, strategy logs a warning each loop |
| 3 min interval | Passed as `"3"` string; helper already handles it |
| Existing running state files without `use_ema`/`use_supertrend` | UI defaults to showing both as active (undefined → truthy fallback) |

---

## Out of Scope

- Adding new indicator types (RSI, MACD, etc.) — future enhancement.
- Changing spread width, offsets, or SL/target logic — no changes.
- `strategy.md` doc update — can be done separately.

# Pivot High / Pivot Low Detection

Reusable swing-point detection: [lib/pivots.py](../lib/pivots.py).

This is a **library module, not a strategy**. Nothing in `strategies/` uses it yet — it is
the shared definition of "swing high" / "swing low" that backtests, screeners, and live
strategies can all import so they agree on what a pivot is.

Pure Python: `pandas` + `numpy` only. It never imports `DhanHelper`, never places orders,
never writes files. Keep it that way.

---

## 1. What counts as a pivot

A **pivot high** is a peak. Candle `i` is a pivot high when its `High` is strictly greater
than the highs of the `n` candles before it *and* the `n` candles after it.

With `n = 3`:

```
High[i] > High[i-1], High[i-2], High[i-3]
High[i] > High[i+1], High[i+2], High[i+3]
```

A **pivot low** is the mirror image on `Low`:

```
Low[i] < Low[i-1], Low[i-2], Low[i-3]
Low[i] < Low[i+1], Low[i+2], Low[i+3]
```

Larger `n` → fewer, more structurally significant swings. `n=3` on 5-minute candles is a
sensible intraday default.

**Ties are not pivots.** Comparison is strict `>` / `<`, so a flat double top at the same
price reports nothing until one side breaks. Pass `strict=False` for `>=` / `<=` if you
want both bars of a flat top reported.

---

## 2. The confirmation lag — read this before going live

**A pivot cannot be identified when it forms.** To know candle `i` is a peak you need
candles `i+1 … i+n` to exist. They haven't happened yet.

So detection lags price by `n` candles. This is inherent to the definition, not a
limitation of the implementation.

`PivotTracker` adds one more candle of lag by default: the newest row of a live frame is
the *in-progress* candle whose high can still rise, so it is discarded (`drop_forming=True`).
This matches the repo-wide `df.iloc[-2]` convention used in
[strategies/crudeoil/crudeoilm_supertrend.py](../strategies/crudeoil/crudeoilm_supertrend.py).

> **Total lag with `n=3`: 4 closed candles.** On a 5-minute chart you learn about a peak
> ~20 minutes after it printed.

The consequence for your logic: the last `n` bars of any frame return no pivots. That does
**not** mean "no pivots there" — it means *not knowable yet*. Feed more candles and they
appear, with the same timestamp and price they always had.

---

## 3. Quick start

### One-shot (backtests, screeners, ad-hoc analysis)

```python
from lib.pivots import find_pivots

df = helper.get_latest_candles("NIFTY", interval="5", days=5)
for p in find_pivots(df, n=3):
    print(p.type, p.price, p.timestamp)
```

### Fetch + detect in one call

```python
from lib.pivots import get_pivots

pivots = get_pivots(helper, "NIFTY", interval="5", n=3, days=5)
```

`get_pivots` drops the forming candle for you. Note the caveat in §7 about empty results.

### Live loop

```python
from lib.pivots import PivotTracker

tracker = PivotTracker(n=3, maxlen=5)          # on strategy init
tracker.prime(helper.get_latest_candles(SYMBOL, interval="5", days=5))   # once, at startup

while True:
    df = helper.get_latest_candles(SYMBOL, interval="5", days=5)
    for p in tracker.update(df):               # ONLY newly confirmed pivots
        log(f"new {p.type} @ {p.price} ({p.timestamp})")

    swing_high = tracker.latest_high()
    if swing_high and helper.get_ltp(...) > swing_high.price:
        ...  # breakout
```

---

## 4. API reference

### `Pivot`

Frozen dataclass. One confirmed swing point.

| Field | Meaning |
|---|---|
| `timestamp` | Candle open time (tz-naive IST). **The canonical identity of a pivot.** |
| `index` | Positional row offset. **Informational only** — see §6. Excluded from `==` and `hash()`. |
| `price` | `High[i]` for a HIGH, `Low[i]` for a LOW. |
| `type` | `"HIGH"` or `"LOW"` — constants `PIVOT_HIGH` / `PIVOT_LOW`. |

Also: `.is_high`, `.is_low`, `.to_dict()` (JSON-safe), `Pivot.from_dict(d)`.

### `find_pivots(df, n=3, *, kind="both", strict=True, high_col="High", low_col="Low")`

Every confirmed pivot in `df`, oldest first, HIGHs and LOWs interleaved by time.

| Arg | Notes |
|---|---|
| `n` | Bars required on each side. Default 3. |
| `kind` | `"both"` / `"high"` / `"low"`. Case-insensitive, so `PIVOT_HIGH` works. Anything else raises `ValueError`. |
| `strict` | `True` (default) rejects ties. See §1. |
| `high_col` / `low_col` | Column names. Default Title Case, matching `get_latest_candles()`. Use lowercase if your frame went through `calculate_ta_indicators()`, which adds lowercase duplicates. |

Returns `[]` — never raises — for `None`, an empty frame, `n < 1`, fewer than `2n+1` rows,
or missing columns. Bad *data* degrades quietly; a bad *argument* (`kind`) raises.

Convenience wrappers: `find_pivot_highs(df, n)`, `find_pivot_lows(df, n)`.

### `PivotTracker(n=3, maxlen=5, *, drop_forming=True, strict=True, high_col="High", low_col="Low")`

Stateful wrapper for live loops. Raises `ValueError` if `n < 1` or `maxlen < 1`.

| Method | Returns |
|---|---|
| `update(df)` | Newly confirmed pivots only, oldest first. Safe and cheap to call every poll. |
| `prime(df)` | Absorbs history **without** emitting it; returns the count. Call once at startup — see §5. |
| `latest_high()` / `latest_low()` | Most recent `Pivot` of that type, or `None`. |
| `high_prices()` / `low_prices()` | Retained prices, oldest first. |
| `reset()` | Clear buffers and watermarks (e.g. new session). |
| `to_dict()` / `from_dict(state)` | JSON round-trip for `save_strategy_state()` — see §8. |

`tracker.highs` and `tracker.lows` are `collections.deque(maxlen=maxlen)`. The 6th pivot
evicts the 1st automatically, so you always hold the most recent 5 of each type.

**Thread-safe.** All mutation and every accessor take an internal lock, so a background
refresh thread can call `update()` while the main loop reads `latest_low()`.

### `get_pivots(helper, symbol, interval="5", n=3, days=5, **kwargs)`

Fetch candles and detect in one call. `helper` is duck-typed — anything exposing
`get_latest_candles()`. Drops the forming candle before scanning.

---

## 5. Starting a strategy mid-session

A cold `PivotTracker`'s first `update()` reports **every** pivot in the lookback window as
new. Launch at 13:00 and you'll get ~60 "new pivot" signals for swings that formed hours
ago — and a naive strategy will act on them.

`prime()` fixes this. It populates the buffers and advances the internal watermarks exactly
as `update()` would, but returns a count instead of the pivots:

```python
tracker = PivotTracker(n=3, maxlen=5)
absorbed = tracker.prime(helper.get_latest_candles(SYMBOL, interval="5", days=5))
log(f"primed {absorbed} historical pivots")
# levels are available NOW via latest_high()/latest_low(),
# but nothing was reported as a tradeable signal
```

Verified against live NIFTY 5-minute data: 66 pivots absorbed silently, the next
`update()` on the same frame returned `[]`.

---

## 6. Identity is the timestamp, never the index

Your candle window slides forward all day. The peak that was row 372 this morning is row
340 this afternoon — same peak, different number.

So the tracker dedups by **timestamp**, via a per-type high-water mark. `Pivot.index` is
stored for debugging only and is deliberately excluded from `__eq__` / `__hash__`, so the
same swing seen through two different windows compares equal and a `set`-based dedup won't
re-fire on a pivot you've already traded.

**Follow the same rule in your own code.** If you persist "last pivot I acted on", persist
the timestamp.

One deliberate consequence: a pivot *older* than the watermark is ignored even if it is
genuinely new to the tracker — e.g. a later `update()` supplies deeper history than the
first did. Backfilling history mid-session must not fire stale signals.

---

## 7. Empty results can mean an API failure

Dhan's historical endpoints return empty on error rather than raising (see the
`last_api_error` convention in [CLAUDE.md](../CLAUDE.md)). So `[]` from `get_pivots()` means
either "no swings formed" or "the data API is down."

`get_pivots()` logs a warning when `helper.last_api_error` is set, but **check it yourself**
before concluding there are no pivots:

```python
pivots = get_pivots(helper, "NIFTY", interval="5", n=3)
if not pivots and helper.last_api_error:
    log(f"data API failed, not acting: {helper.last_api_error}")
```

Other reasons `find_pivots` returns `[]`, none of them errors:

- Fewer than `2n+1` rows — a 3-side pivot needs at least 7 candles.
- Every candidate sits in the first `n` or last `n` rows.
- `high_col` / `low_col` aren't in the frame (case mismatch is the usual cause).
- NaN in a comparison window — gaps are skipped rather than producing a bogus pivot.

---

## 8. Wiring into a strategy

Full pattern, following [templates/strategy_template.py](../templates/strategy_template.py)
and the state bridge in [lib/strategy_state_helper.py](../lib/strategy_state_helper.py):

```python
from lib.pivots import PivotTracker
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger

class MyStrategy:
    def __init__(self, helper, dry_run=True):
        self.helper = helper
        self.tracker = PivotTracker(n=3, maxlen=5)
        self._primed = False

    def refresh_pivots(self):
        df = self.helper.get_latest_candles("NIFTY", interval="5", days=5)
        if df.empty:
            if self.helper.last_api_error:
                print(f"[WARN] candle fetch failed: {self.helper.last_api_error}")
            return []
        if not self._primed:
            n = self.tracker.prime(df)          # absorb history, emit nothing
            self._primed = True
            print(f"[INIT] primed {n} pivots")
            return []
        return self.tracker.update(df)          # only what's new

    def run(self):
        while True:
            if check_shutdown_trigger("my_strategy"):
                break

            for p in self.refresh_pivots():
                print(f"[PIVOT] new {p.type} @ {p.price} ({p.timestamp})")

            swing_high = self.tracker.latest_high()
            swing_low = self.tracker.latest_low()
            ltp = self.helper.get_ltp("NIFTY", instrument="INDEX")

            if swing_high and ltp > swing_high.price:
                ...   # breakout entry
            if swing_low:
                ...   # stop just under the last swing low

            save_strategy_state("my_strategy", {
                "ltp": ltp,
                "pivots": self.tracker.to_dict(),      # JSON-safe
            })
            time.sleep(30)
```

### Surviving a restart

`to_dict()` / `from_dict()` preserve the buffers *and* the watermarks, so a restarted
strategy does not re-emit pivots it already traded:

```python
state = json.load(open("debug/my_strategy_state.json"))
tracker = PivotTracker.from_dict(state["pivots"])
```

### If you refresh from a background thread

The `crudeoilm_supertrend.py` pattern — a thread that recomputes only when the candle
bucket changes — works as-is. It still receives a frame whose last row is forming, so
`drop_forming=True` remains correct. The tracker's internal lock makes concurrent
`update()` / `latest_high()` safe.

Set `drop_forming=False` **only** when you have already sliced (`df.iloc[:-1]`) or are
replaying closed historical bars. Otherwise you silently discard one real candle per call.

---

## 9. Tests

34 offline unit tests, no broker session or network required:

```powershell
venv\Scripts\python.exe -m unittest tests.test_pivots -v
```

[tests/test_pivots.py](../tests/test_pivots.py) covers `n=1`/`n=3` windows, ties both ways,
first/last-`n` unconfirmability, NaN gaps, custom column case, JSON round-trips,
exactly-once emission across incremental slices, ring-buffer eviction, the `drop_forming`
delay, index-shifts-but-timestamp-stable, and a threaded writer/reader race check.

Deliberately **not** registered in `tests/run_all_tests.py` — that orchestrator builds a
live `DhanHelper` and its modules place real orders. These tests must stay runnable
offline. Same reasoning as `tests/test_premium_mode.py`.

---

## 10. Design constraints worth preserving

- **No broker coupling.** `lib/pivots.py` must never import `DhanHelper`. That is what
  keeps it usable in unit tests and backtests without OAuth.
- **Not a `calculate_ta_indicators` entry.** Pivots are *events*, not a per-row column.
  Forcing them into a column re-introduces the confirmation-lag ambiguity this module
  exists to make explicit.
- **One detection function.** `find_pivots()` holds all the math; `PivotTracker` calls it
  and filters. Don't fork the comparison logic.

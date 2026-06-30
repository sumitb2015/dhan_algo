# Spread Trend — Configurable Timeframe & Selectable Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove VWAP from the spread trend strategy, make EMA and Supertrend individually toggleable via CLI flags, restrict UI timeframe to 1/3/5 min, and expose indicator toggles in the dashboard config panel.

**Architecture:** Two independent changes — (1) Python strategy file gets new constructor params, refactored `get_signal()`, and new CLI flags; (2) React component gets new state vars, updated select options, inline checkboxes that show/hide parameter inputs, and updated args builder.

**Tech Stack:** Python 3 (argparse, pandas_ta), Next.js App Router, React, Tailwind CSS, shadcn/ui components.

## Global Constraints

- Python file lives at `strategies/spread_trend/nifty_spread_trend.py` — do not move or rename it.
- Dashboard component is `rs_dashboard/components/StrategyCard.tsx` — spread-trend config is inside the existing `meta.key === 'nifty_spread_trend'` block; do not restructure the overall component.
- Follow existing CLAUDE.md table header style and no text-color opacity modifiers.
- Both indicators default to **enabled** — the flags are `--no-ema` / `--no-supertrend` (opt-out, not opt-in).
- Timeframe UI restricted to `"1"`, `"3"`, `"5"` only; default stays `"5"`.
- No new files needed — all changes are edits to existing files.

---

### Task 1: Python — Remove VWAP and add indicator toggle flags

**Files:**
- Modify: `strategies/spread_trend/nifty_spread_trend.py`

**Interfaces:**
- Produces: `--no-ema` and `--no-supertrend` CLI flags; `use_ema: bool` and `use_supertrend: bool` written to state JSON.

- [ ] **Step 1: Add `use_ema` and `use_supertrend` to the constructor signature and body**

  In `NiftySpreadTrendStrategy.__init__`, add the two new params (after `cooldown_minutes`) and store them:

  ```python
  def __init__(self, dry_run=True, symbol="NIFTY", interval="5",
               ema_period=20, supertrend_period=7, supertrend_multiplier=3.0,
               ce_offset=100, pe_offset=100, spread_width=100, lots=1,
               target_profit=2000.0, stop_loss=2000.0, exit_on_signal_change=True,
               eod_time="15:15", cooldown_minutes=5,
               use_ema=True, use_supertrend=True):   # ← new
      ...
      self.use_ema = use_ema
      self.use_supertrend = use_supertrend
  ```

  Place the two `self.use_*` lines right after `self.cooldown_minutes = cooldown_minutes` (around line 59).

- [ ] **Step 2: Add `use_ema` / `use_supertrend` to `save_state()`**

  Inside `save_state()`, add two keys to `state_dict`:

  ```python
  state_dict = {
      ...
      "interval": self.interval,
      "use_ema": self.use_ema,           # ← new
      "use_supertrend": self.use_supertrend,  # ← new
      "lots": self.lots,
      ...
  }
  ```

- [ ] **Step 3: Rewrite `get_signal()` — remove VWAP, make indicators conditional**

  Replace the entire body of `get_signal()` with the version below. Key changes:
  - `indicators` list built dynamically from flags.
  - VWAP entirely gone (no fetch, no column lookup, no condition).
  - Signal votes collected per enabled indicator; all votes must agree.
  - Both disabled → NEUTRAL + warning.

  ```python
  def get_signal(self) -> Tuple[str, float]:
      """
      Fetch enabled indicators and determine signal from the last completed candle.
      Returns (signal, spot_close) where signal is "BULLISH", "BEARISH", or "NEUTRAL".
      """
      try:
          if not self.use_ema and not self.use_supertrend:
              logger.warning("No indicators enabled — returning NEUTRAL.")
              return "NEUTRAL", 0.0

          indicators = []
          if self.use_ema:
              indicators.append(f"EMA{self.ema_period}")
          if self.use_supertrend:
              indicators.append({
                  "kind": "supertrend",
                  "length": self.supertrend_period,
                  "multiplier": self.supertrend_multiplier,
              })

          df = self.helper.get_indicators_ta(
              symbol=self.symbol,
              interval=self.interval,
              indicators=indicators,
              days=5,
          )

          if df.empty or len(df) < 2:
              logger.warning("Empty or insufficient data for indicator calculations.")
              return "NEUTRAL", 0.0

          row = df.iloc[-2]
          close = float(row["Close"])

          bullish_votes = []
          bearish_votes = []

          if self.use_ema:
              ema_col = f"EMA_{self.ema_period}"
              if ema_col not in df.columns:
                  ema_cols = [c for c in df.columns if "EMA" in c]
                  if not ema_cols:
                      logger.error(f"EMA column not found. Columns: {df.columns.tolist()}")
                      return "NEUTRAL", 0.0
                  ema_col = ema_cols[0]
              ema_val = float(row[ema_col])
              bullish_votes.append(close > ema_val)
              bearish_votes.append(close < ema_val)

          if self.use_supertrend:
              st_dir_cols = [c for c in df.columns if c.startswith("SUPERTd_")]
              if not st_dir_cols:
                  logger.error(f"Supertrend direction column not found. Columns: {df.columns.tolist()}")
                  return "NEUTRAL", 0.0
              st_dir = float(row[st_dir_cols[0]])
              bullish_votes.append(st_dir == 1)
              bearish_votes.append(st_dir == -1)

          candle_time = row.get("Datetime") or df.index[-2]
          if candle_time != self.last_processed_candle_time:
              active = []
              if self.use_ema:
                  active.append(f"EMA({self.ema_period})={ema_val:.2f}")
              if self.use_supertrend:
                  active.append(f"ST_dir={st_dir:.1f}")
              logger.info(
                  f"[SIGNAL CHECK] Candle: {candle_time} | Close: {close:.2f} | "
                  + " | ".join(active)
              )
              self.last_processed_candle_time = candle_time

          if all(bullish_votes):
              return "BULLISH", close
          if all(bearish_votes):
              return "BEARISH", close
          return "NEUTRAL", close

      except Exception as e:
          logger.error(f"Error checking indicators/signal: {e}")
          return "NEUTRAL", 0.0
  ```

  Note: `ema_val` and `st_dir` are referenced in the log block — they are guaranteed to be assigned when the respective flag is True, so no NameError can occur.

- [ ] **Step 4: Add `--no-ema` and `--no-supertrend` CLI flags**

  In the `__main__` block, after the existing `--supertrend-multiplier` argument, add:

  ```python
  parser.add_argument(
      "--no-ema",
      action="store_false",
      dest="use_ema",
      default=True,
      help="Disable the EMA filter (default: enabled)",
  )
  parser.add_argument(
      "--no-supertrend",
      action="store_false",
      dest="use_supertrend",
      default=True,
      help="Disable the Supertrend filter (default: enabled)",
  )
  ```

  Update the log banner lines (around line 683) to show active indicators:

  ```python
  active_indicators = []
  if args.use_ema:
      active_indicators.append(f"EMA({args.ema_period})")
  if args.use_supertrend:
      active_indicators.append(f"Supertrend({args.supertrend_period}, {args.supertrend_multiplier})")
  logger.info(f"Indicators: {' + '.join(active_indicators) if active_indicators else 'NONE (will not trade)'}")
  ```

  Pass the new args to the constructor:

  ```python
  strat = NiftySpreadTrendStrategy(
      ...
      cooldown_minutes=args.cooldown_minutes,
      use_ema=args.use_ema,           # ← new
      use_supertrend=args.use_supertrend,  # ← new
  )
  ```

- [ ] **Step 5: Verify with a dry run (no live orders)**

  ```powershell
  # Both indicators on (default) — should behave as before minus VWAP
  venv\Scripts\python.exe strategies/spread_trend/nifty_spread_trend.py

  # EMA only
  venv\Scripts\python.exe strategies/spread_trend/nifty_spread_trend.py --no-supertrend

  # Supertrend only
  venv\Scripts\python.exe strategies/spread_trend/nifty_spread_trend.py --no-ema

  # Both off — should log "No indicators enabled" and never enter a trade
  venv\Scripts\python.exe strategies/spread_trend/nifty_spread_trend.py --no-ema --no-supertrend
  ```

  Expected output for the last case: repeated `[SIGNAL CHECK]` lines with "No indicators enabled — returning NEUTRAL."

- [ ] **Step 6: Commit**

  ```bash
  git add strategies/spread_trend/nifty_spread_trend.py
  git commit -m "feat(spread-trend): remove VWAP, add --no-ema / --no-supertrend flags"
  ```

---

### Task 2: UI — Timeframe restriction and indicator toggles in StrategyCard

**Files:**
- Modify: `rs_dashboard/components/StrategyCard.tsx`

**Interfaces:**
- Consumes: `state.use_ema: boolean | undefined`, `state.use_supertrend: boolean | undefined` from running state JSON.
- Produces: `--no-ema` / `--no-supertrend` in the `args` array sent to `/api/strategies` POST.

- [ ] **Step 1: Add `useEma` and `useSupertrend` state variables**

  In the "Spread Trend" state block (around line 124), add two new state vars directly after `const [cooldownMinutes, ...]`:

  ```tsx
  const [useEma, setUseEma] = useState<boolean>(true);
  const [useSupertrend, setUseSupertrend] = useState<boolean>(true);
  ```

- [ ] **Step 2: Update the timeframe `<Select>` to show only 1 / 3 / 5 min**

  Find the Timeframe `<Select>` block inside the `meta.key === 'nifty_spread_trend'` section (around line 349) and replace its `<SelectContent>`:

  ```tsx
  <SelectContent>
    <SelectItem value="1">1 Min</SelectItem>
    <SelectItem value="3">3 Min</SelectItem>
    <SelectItem value="5">5 Min</SelectItem>
  </SelectContent>
  ```

- [ ] **Step 3: Replace the EMA Period input with a toggle + conditional input**

  Find the existing EMA Period field:

  ```tsx
  <div className={fieldCls}>
    <label className={lbl}>EMA Period</label>
    <Input type="number" value={emaPeriod} onChange={(e) => setEmaPeriod(parseInt(e.target.value) || 20)} className={inputCls} />
  </div>
  ```

  Replace it with:

  ```tsx
  <div className={fieldCls}>
    <div className="flex items-center gap-2 h-5">
      <input
        type="checkbox"
        id={`use-ema-${meta.key}`}
        checked={useEma}
        onChange={(e) => setUseEma(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 accent-emerald-500"
      />
      <label htmlFor={`use-ema-${meta.key}`} className={lbl}>EMA</label>
    </div>
    {useEma && (
      <Input
        type="number"
        value={emaPeriod}
        onChange={(e) => setEmaPeriod(parseInt(e.target.value) || 20)}
        className={inputCls}
        placeholder="Period"
      />
    )}
  </div>
  ```

- [ ] **Step 4: Replace the ST Period + ST Multiplier inputs with a toggle + conditional inputs**

  Find the existing ST Period field:

  ```tsx
  <div className={fieldCls}>
    <label className={lbl}>ST Period</label>
    <Input type="number" value={supertrendPeriod} onChange={(e) => setSupertrendPeriod(parseInt(e.target.value) || 7)} className={inputCls} />
  </div>
  <div className={fieldCls}>
    <label className={lbl}>ST Multiplier</label>
    <Input type="number" step="0.5" value={supertrendMultiplier} onChange={(e) => setSupertrendMultiplier(parseFloat(e.target.value) || 3.0)} className={inputCls} />
  </div>
  ```

  Replace both fields with:

  ```tsx
  <div className={fieldCls}>
    <div className="flex items-center gap-2 h-5">
      <input
        type="checkbox"
        id={`use-st-${meta.key}`}
        checked={useSupertrend}
        onChange={(e) => setUseSupertrend(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 accent-emerald-500"
      />
      <label htmlFor={`use-st-${meta.key}`} className={lbl}>Supertrend</label>
    </div>
    {useSupertrend && (
      <>
        <Input
          type="number"
          value={supertrendPeriod}
          onChange={(e) => setSupertrendPeriod(parseInt(e.target.value) || 7)}
          className={inputCls}
          placeholder="Period"
        />
        <Input
          type="number"
          step="0.5"
          value={supertrendMultiplier}
          onChange={(e) => setSupertrendMultiplier(parseFloat(e.target.value) || 3.0)}
          className={inputCls}
          placeholder="Multiplier"
        />
      </>
    )}
  </div>
  ```

- [ ] **Step 5: Add both-disabled warning and Launch button guard**

  Add a derived variable near the top of the component body (after the state declarations):

  ```tsx
  const spreadTrendNoIndicators =
    meta.key === 'nifty_spread_trend' && !useEma && !useSupertrend;
  ```

  Inside the spread trend config block, after the Supertrend field, add the warning chip:

  ```tsx
  {spreadTrendNoIndicators && (
    <div className="col-span-full px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-400 font-medium">
      Enable at least one indicator to launch.
    </div>
  )}
  ```

  Update the Launch button (the full-width one in the config-open footer, around line 808) to also disable on `spreadTrendNoIndicators`:

  ```tsx
  <Button
    onClick={handleStart}
    disabled={submitting || spreadTrendNoIndicators}
    className="flex-1 h-8 gap-1.5 bg-gradient-to-tr from-emerald-600 to-teal-500 text-white font-bold rounded-lg shadow-md shadow-emerald-500/10 hover:from-emerald-500 hover:to-teal-400 active:scale-[0.98] transition-all duration-150 text-xs border-0 disabled:opacity-50 disabled:cursor-not-allowed"
  >
    {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-white" />}
    {submitting ? 'Launching…' : 'Launch Algorithm'}
  </Button>
  ```

  Also disable the inline compact Launch button (the one visible when `!showConfig`, around line 614):

  ```tsx
  <Button
    onClick={handleStart}
    disabled={submitting || spreadTrendNoIndicators}
    className="h-6 px-2.5 gap-1 bg-emerald-600/80 hover:bg-emerald-500/80 text-white font-bold rounded-md text-[10px] border-0 shadow-none active:scale-95 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
  >
    <Play className="h-2.5 w-2.5 fill-white" />
    Launch
  </Button>
  ```

- [ ] **Step 6: Pass `--no-ema` / `--no-supertrend` in `handleStart`**

  Inside the `meta.key === 'nifty_spread_trend'` args block (around line 197), add after the existing spread trend args:

  ```tsx
  if (!useEma) args.push('--no-ema');
  if (!useSupertrend) args.push('--no-supertrend');
  ```

- [ ] **Step 7: Show active indicator badges in the running stats strip**

  Find the spread trend running stats block (the one that shows `Spread` / `S:` / `L:`, around line 693). After the `<span className="font-mono font-bold text-sky-400">{state.active_spread || '—'}</span>` line, add indicator badges:

  ```tsx
  <div className="flex gap-1 mt-0.5">
    {(state.use_ema !== false) && (
      <span className="text-[9px] font-bold px-1 rounded bg-indigo-500/15 text-indigo-400">EMA</span>
    )}
    {(state.use_supertrend !== false) && (
      <span className="text-[9px] font-bold px-1 rounded bg-violet-500/15 text-violet-400">ST</span>
    )}
  </div>
  ```

  Note: `state.use_ema !== false` treats `undefined` (old state files without the field) as truthy, so existing running strategies show both badges.

- [ ] **Step 8: Verify in the browser**

  Start the dashboard:

  ```powershell
  cd rs_dashboard
  npm run dev
  ```

  Open `http://localhost:3000/strategies` and expand the **Nifty Spread Trend-Following** card config:

  - Timeframe dropdown shows only: `1 Min`, `3 Min`, `5 Min`.
  - Two checkbox rows: **EMA** (checked, Period input visible) and **Supertrend** (checked, Period + Multiplier inputs visible).
  - Uncheck EMA → Period input disappears.
  - Uncheck Supertrend → Period + Multiplier inputs disappear.
  - Uncheck both → amber warning chip appears, Launch button dims and is unclickable.
  - Re-check one → warning disappears, Launch re-enables.

- [ ] **Step 9: Commit**

  ```bash
  git add rs_dashboard/components/StrategyCard.tsx
  git commit -m "feat(dashboard): spread trend — restrict timeframe to 1/3/5 min, add indicator toggles"
  ```

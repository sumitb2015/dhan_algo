# Strategy Params Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a distilled, strategy-facing JSON export (`by_weekday`/`by_dte` avg premium + seller win rate + sample count, `post_sep2025` regime only) alongside each existing straddle/strangle analysis script's full output, so live strategy code can load simple numeric params directly instead of parsing the full analysis JSON.

**Architecture:** Both `scripts/analysis/straddle_premium_analysis.py` and `scripts/analysis/strangle_premium_analysis.py` already compute a `post_sep2025` regime stats dict in memory (each `by_weekday`/`by_dte` entry has `avg`, `seller_win_pct`, `count`, plus other fields not needed here). Add a small pure function to each script that maps that dict down to `{avg_premium, seller_win_pct, count}` per segment, then write the distilled result to a new JSON file right after the script's existing full-output write. No new dependencies, no DB queries, no dashboard/API changes.

**Tech Stack:** Python 3, stdlib `json`/`pathlib` only (no new deps). Existing venv at `c:\dhan_algo\dhan_algo\venv`.

## Global Constraints

- Distilled output only covers the `post_sep2025` regime — per spec, `pre_sep2025`/`all` are not included.
- Per-segment fields are exactly `avg_premium`, `seller_win_pct`, `count` — no other `DteStats` fields (median, std, min, max, p10/p25/p75/p90, avg_decay_pct, avg_range, avg_range_pct) are carried over.
- Output paths: `debug/straddle_strategy_params.json` and `debug/strangle_strategy_params.json` (both under `PROJECT_ROOT / "debug"`, same `PROJECT_ROOT` each script already resolves).
- No changes to `rs_dashboard/` (dashboard, API routes, UI) — these files are consumed directly by Python strategy code.
- If a `by_weekday`/`by_dte` segment has zero samples, `agg_stats()` returns only `{"count": 0}` (no `avg` key) and `compute_regime_stats()`'s per-segment loop `continue`s past it entirely — so every segment actually present in `by_weekday`/`by_dte` is guaranteed to have `avg`, `seller_win_pct`, and `count`. The distill helper does not need to handle a missing-`avg` case for segments that exist in the dict.

---

### Task 1: Distilled export from `straddle_premium_analysis.py`

**Files:**
- Modify: `scripts/analysis/straddle_premium_analysis.py`

**Interfaces:**
- Consumes: `regime_post: dict` — the existing local variable in `main()` (see current line `regime_post = compute_regime_stats(daily_post, merged_post)`), which has shape `{"by_weekday": {<day>: {"avg": float, "seller_win_pct": float, "count": int, ...}, ...}, "by_dte": {<label>: {...}, ...}, ...}`.
- Produces: `debug/straddle_strategy_params.json` with shape:
  ```json
  {
    "generated_at": "<iso timestamp>",
    "regime": "post_sep2025",
    "by_weekday": { "<Weekday>": { "avg_premium": float, "seller_win_pct": float, "count": int }, ... },
    "by_dte": { "<label>": { "avg_premium": float, "seller_win_pct": float, "count": int }, ... }
  }
  ```

- [ ] **Step 1: Add the distill helper and new output path constant**

  Add a new constant near the existing `OUTPUT_PATH`/`STATUS_PATH` constants (around line 24-25):

  ```python
  STRATEGY_PARAMS_PATH = PROJECT_ROOT / "debug" / "straddle_strategy_params.json"
  ```

  Add a new function directly after `compute_regime_stats` (after its closing, before `def main():`):

  ```python
  def distill_strategy_params(regime_stats: dict) -> dict:
      """Reduce a regime stats dict's by_weekday/by_dte entries to the fields a live
      strategy needs: avg_premium, seller_win_pct, count."""
      def _reduce(segment: dict) -> dict:
          return {
              key: {
                  "avg_premium":    entry["avg"],
                  "seller_win_pct": entry["seller_win_pct"],
                  "count":          entry["count"],
              }
              for key, entry in segment.items()
          }

      return {
          "by_weekday": _reduce(regime_stats.get("by_weekday", {})),
          "by_dte":     _reduce(regime_stats.get("by_dte", {})),
      }
  ```

- [ ] **Step 2: Write the distilled file in `main()` after the existing full-output write**

  In `main()`, immediately after this existing block (around line 396-399):

  ```python
      OUTPUT_PATH.parent.mkdir(exist_ok=True)
      OUTPUT_PATH.write_text(json.dumps(output, indent=2), encoding="utf-8")
      write_status("done", 100, f"Analysis complete. {len(daily):,} trading days processed.")
      print(f"Done. {len(daily):,} days -> {OUTPUT_PATH}")
  ```

  add:

  ```python
      strategy_params = {
          "generated_at": output["generated_at"],
          "regime": "post_sep2025",
          **distill_strategy_params(regime_post),
      }
      STRATEGY_PARAMS_PATH.write_text(json.dumps(strategy_params, indent=2), encoding="utf-8")
      print(f"Also wrote strategy params -> {STRATEGY_PARAMS_PATH}")
  ```

- [ ] **Step 3: Run the script**

  Run: `venv\Scripts\python.exe scripts/analysis/straddle_premium_analysis.py`

  Expected: script completes (as it did before this change) and prints an additional line `Also wrote strategy params -> ...debug\straddle_strategy_params.json`.

- [ ] **Step 4: Verify the distilled file's structure and values**

  Run:
  ```powershell
  venv\Scripts\python.exe -c "
  import json
  full = json.load(open('debug/straddle_premium_analysis.json'))
  distilled = json.load(open('debug/straddle_strategy_params.json'))
  assert distilled['regime'] == 'post_sep2025'
  assert set(distilled.keys()) == {'generated_at', 'regime', 'by_weekday', 'by_dte'}
  post = full['regimes']['post_sep2025']
  for day, entry in distilled['by_weekday'].items():
      assert set(entry.keys()) == {'avg_premium', 'seller_win_pct', 'count'}
      assert entry['avg_premium'] == post['by_weekday'][day]['avg']
      assert entry['seller_win_pct'] == post['by_weekday'][day]['seller_win_pct']
      assert entry['count'] == post['by_weekday'][day]['count']
  for label, entry in distilled['by_dte'].items():
      assert set(entry.keys()) == {'avg_premium', 'seller_win_pct', 'count'}
      assert entry['avg_premium'] == post['by_dte'][label]['avg']
  print('OK', len(distilled['by_weekday']), 'weekdays,', len(distilled['by_dte']), 'dte buckets')
  "
  ```

  Expected: prints `OK 5 weekdays, 6 dte buckets` (or fewer buckets if some DTE/weekday combos have zero samples in the current dataset) with no assertion errors.

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/analysis/straddle_premium_analysis.py
  git commit -m "$(cat <<'EOF'
  feat(analysis): export distilled straddle_strategy_params.json for algo consumption

  Adds a small avg_premium/seller_win_pct/count-only export (post_sep2025
  regime) alongside the existing full straddle analysis JSON, for strategy
  code to read directly without parsing the full stats file.
  EOF
  )"
  ```

---

### Task 2: Distilled export from `strangle_premium_analysis.py`

**Files:**
- Modify: `scripts/analysis/strangle_premium_analysis.py`

**Interfaces:**
- Consumes: `distill_strategy_params(regime_stats: dict) -> dict` — reused by duplicating the same function from Task 1 into this script (these two analysis scripts already duplicate `compute_regime_stats`/`agg_stats`/`npct`/`write_status` independently; this follows the same pattern). Also consumes `build_offset(df_all, offset)`'s return shape: `{"regimes": {"all": {...}, "pre_sep2025": {...}, "post_sep2025": {...}}}` (existing, unchanged).
- Produces: `debug/strangle_strategy_params.json` with shape:
  ```json
  {
    "generated_at": "<iso timestamp>",
    "regime": "post_sep2025",
    "offsets": {
      "1":  { "by_weekday": {...}, "by_dte": {...} },
      "2":  { ... },
      ...
      "10": { ... }
    }
  }
  ```

- [ ] **Step 1: Add the distill helper and new output path constant**

  Add a new constant near the existing `OUTPUT_PATH`/`STATUS_PATH` constants (around line 22-23):

  ```python
  STRATEGY_PARAMS_PATH = PROJECT_ROOT / "debug" / "strangle_strategy_params.json"
  ```

  Add this function directly after `compute_regime_stats` (before `def build_offset(...)`):

  ```python
  def distill_strategy_params(regime_stats: dict) -> dict:
      """Reduce a regime stats dict's by_weekday/by_dte entries to the fields a live
      strategy needs: avg_premium, seller_win_pct, count."""
      def _reduce(segment: dict) -> dict:
          return {
              key: {
                  "avg_premium":    entry["avg"],
                  "seller_win_pct": entry["seller_win_pct"],
                  "count":          entry["count"],
              }
              for key, entry in segment.items()
          }

      return {
          "by_weekday": _reduce(regime_stats.get("by_weekday", {})),
          "by_dte":     _reduce(regime_stats.get("by_dte", {})),
      }
  ```

- [ ] **Step 2: Accumulate distilled params per offset in `main()`'s existing loop**

  In `main()`, find the existing loop (around line 406-410):

  ```python
      for i, offset in enumerate(OFFSETS):
          pct_start = 10 + i * 8
          write_status("running", pct_start, f"Processing ATM+{offset}/ATM-{offset} strangle ({i+1}/10)...")
          output[f"offset_{offset}"] = build_offset(df_all, offset)
          write_status("running", pct_start + 7, f"Offset {offset} done.")
  ```

  Replace it with (adds `strategy_params` accumulation, keeping every existing line unchanged):

  ```python
      strategy_params: dict = {}
      for i, offset in enumerate(OFFSETS):
          pct_start = 10 + i * 8
          write_status("running", pct_start, f"Processing ATM+{offset}/ATM-{offset} strangle ({i+1}/10)...")
          output[f"offset_{offset}"] = build_offset(df_all, offset)
          strategy_params[str(offset)] = distill_strategy_params(
              output[f"offset_{offset}"]["regimes"]["post_sep2025"]
          )
          write_status("running", pct_start + 7, f"Offset {offset} done.")
  ```

- [ ] **Step 3: Write the distilled file after the existing full-output write**

  Find the existing block (around line 412-416):

  ```python
      OUTPUT_PATH.parent.mkdir(exist_ok=True)
      print(f"Writing text of length {len(json.dumps(output))} to {OUTPUT_PATH}...")
      OUTPUT_PATH.write_text(json.dumps(output, indent=2), encoding="utf-8")
      print(f"File exists right after write: {OUTPUT_PATH.exists()}, size: {OUTPUT_PATH.stat().st_size if OUTPUT_PATH.exists() else 0}")
      write_status("done", 100, "Strangle analysis complete for all 10 offsets.")
  ```

  Add immediately after it (before the end of `main()`):

  ```python
      strategy_params_output = {
          "generated_at": output["generated_at"],
          "regime": "post_sep2025",
          "offsets": strategy_params,
      }
      STRATEGY_PARAMS_PATH.write_text(json.dumps(strategy_params_output, indent=2), encoding="utf-8")
      print(f"Also wrote strategy params -> {STRATEGY_PARAMS_PATH}")
  ```

- [ ] **Step 4: Run the script**

  Run: `venv\Scripts\python.exe scripts/analysis/strangle_premium_analysis.py`

  Expected: script completes (as it did before this change, ~10 offsets processed) and prints an additional line `Also wrote strategy params -> ...debug\strangle_strategy_params.json`.

- [ ] **Step 5: Verify the distilled file's structure and values**

  Run:
  ```powershell
  venv\Scripts\python.exe -c "
  import json
  full = json.load(open('debug/strangle_premium_analysis.json'))
  distilled = json.load(open('debug/strangle_strategy_params.json'))
  assert distilled['regime'] == 'post_sep2025'
  assert set(distilled.keys()) == {'generated_at', 'regime', 'offsets'}
  assert set(distilled['offsets'].keys()) == {str(n) for n in range(1, 11)}
  for offset_key, offset_data in distilled['offsets'].items():
      assert set(offset_data.keys()) == {'by_weekday', 'by_dte'}
      post = full[f'offset_{offset_key}']['regimes']['post_sep2025']
      for day, entry in offset_data['by_weekday'].items():
          assert set(entry.keys()) == {'avg_premium', 'seller_win_pct', 'count'}
          assert entry['avg_premium'] == post['by_weekday'][day]['avg']
      for label, entry in offset_data['by_dte'].items():
          assert entry['count'] == post['by_dte'][label]['count']
  print('OK', len(distilled['offsets']), 'offsets')
  "
  ```

  Expected: prints `OK 10 offsets` with no assertion errors.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/analysis/strangle_premium_analysis.py
  git commit -m "$(cat <<'EOF'
  feat(analysis): export distilled strangle_strategy_params.json for algo consumption

  Adds a small avg_premium/seller_win_pct/count-only export per offset
  (1-10, post_sep2025 regime) alongside the existing full strangle
  analysis JSON, for strategy code to read directly.
  EOF
  )"
  ```

---

## Post-implementation note

Both distilled files regenerate automatically the next time someone clicks "Regenerate" on `/straddle-analysis` or `/strangle-analysis` (the existing dashboard POST routes just spawn these same scripts unchanged), or whenever the scripts are run manually.

# NIFTY Multi-Leg Options Strategy Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `/strategy-builder` dashboard page where a user picks one of 8 readymade neutral NIFTY options strategies, tunes strike offsets/lots, sees a payoff diagram + risk summary (Max Profit/Loss, breakeven, POP, margin), and — if marked "Positional" — saves the strategy to a new local SQLite store for later restore with live P&L.

**Architecture:** All payoff/POP/breakeven/time-value math runs client-side in a single pure TypeScript module (`rs_dashboard/lib/optionsStrategy.ts`), operating on chain data the page already fetches. Margin calculation and DB persistence run server-side in two new Python CLI scripts (following this repo's existing one-JSON-line-to-stdout convention), invoked by thin Next.js API routes that mirror the existing `/api/options/*` routes exactly.

**Tech Stack:** Next.js 16 / React 19 / TypeScript (rs_dashboard), Python 3 stdlib `sqlite3` + `argparse` (scripts/tools), existing `DhanHelper` class (`lib/dhan_helper.py`), Recharts for charting.

## Global Constraints

- No live order placement in this phase — this is a builder/analyzer only. "Save Strategy" persists a definition; it does not place broker orders.
- All 8 strategy templates ship now: Short Straddle, Short Strangle, Iron Butterfly, Iron Condor, Jade Lizard, Reverse Jade Lizard, Batman, Double Plateau — using the leg definitions in Task 3, with every offset user-adjustable (never hardcoded downstream).
- Persistence is a new SQLite DB at `debug/strategies.db`, accessed only via `scripts/tools/strategy_store.py` (stdlib `sqlite3`, no ORM). No DB npm package may be added to `rs_dashboard/package.json`.
- Restoring a saved strategy recomputes live P&L from current LTPs — it must never render only a static snapshot.
- POP uses the delta-based approximation `clamp(1 - effShortDelta, 0, 1)` — not a lognormal/IV distribution model.
- Every new Python script under `scripts/tools/` prints **exactly one JSON line to stdout**; all logging/errors that aren't the final result go to stderr; on exception, print `{"error": str(exc)}` and `sys.exit(0)` (mirrors `scripts/tools/options_data_fetch.py`).
- Every new Next.js API route is a thin proxy: `spawnSync`/`spawn` of `venv/Scripts/pythonw.exe` running the corresponding script, parsing the **last line** of stdout as JSON (mirrors `rs_dashboard/app/api/options/chain/route.ts`).
- `PROJECT_ROOT` in any new API route is `path.resolve(process.cwd(), '..')` (one level up from `rs_dashboard/`), matching every existing route.
- `rs_dashboard/AGENTS.md` warns this Next.js version has non-standard/breaking conventions — read the relevant guide under `rs_dashboard/node_modules/next/dist/docs/` before writing new route handlers if anything in Task 5/6 behaves unexpectedly.
- NIFTY strike step is fixed at 50 points (`STRIKE_STEP = 50`).
- The option chain's raw per-leg fields (confirmed from `lib/dhan_helper.py`'s Dhan API usage) are: `last_price` (number), `oi` (number), `implied_volatility` (number, may be absent), and a nested `greeks: { delta, theta, gamma, vega }` (numbers, may be absent). The chain is keyed as `chain.oc[strikeString].ce` / `.pe`, and the chain object also carries a top-level `last_price` for the underlying (not to be confused with a leg's `last_price`).
- **Path note (discovered during Task 5, resolved with the user):** the saved-strategies CRUD API lives at `/api/saved-strategies` and `/api/saved-strategies/[id]`, NOT `/api/strategies` — that path is already taken by the existing live strategy-process control API (`rs_dashboard/app/api/strategies/route.ts`, consumed by the production `/strategies` and `/strategies-plus` pages to start/stop trading bots). This plan originally specified `/api/strategies` for the new feature before the collision was caught; every task below already uses the corrected `/api/saved-strategies` path.

---

### Task 1: Strategy SQLite Store (Python CLI)

**Files:**
- Create: `scripts/tools/strategy_store.py`

**Interfaces:**
- Produces (consumed by Task 5's API routes via subprocess):
  - CLI subcommands: `init`, `save --json '<StrategyPayload JSON>'`, `list`, `get <id>`, `update <id> --status <open|closed>`, `delete <id>`
  - `save` prints `{"id": <int>}`
  - `list` prints `{"strategies": [<StrategyRow>, ...]}` (header rows only, no `legs_json` parsing needed by caller — raw string is fine to include or omit; include it as `legs_json` string field for consistency)
  - `get <id>` prints the full row as a dict, with `legs_json` and `params_json` returned as **parsed JSON objects/arrays** (not raw strings) so the Next.js route doesn't need a second parse
  - `update`/`delete` print `{"ok": true}` or `{"error": "not_found"}`
  - `StrategyPayload` (input to `save`) shape:
    ```json
    {
      "strategy_type": "short_straddle",
      "display_name": "Short Straddle",
      "underlying": "NIFTY",
      "expiry": "2026-07-30",
      "mode": "positional",
      "lots": 1,
      "lot_size": 75,
      "params": {"N": 2, "W": 5},
      "entry_spot": 25010.5,
      "entry_net_premium": 290.0,
      "legs": [
        {"strike": 25000, "option_type": "CE", "side": "SELL", "qty_lots": 1, "entry_price": 150.0, "entry_delta": -0.52, "security_id": "49081"},
        {"strike": 25000, "option_type": "PE", "side": "SELL", "qty_lots": 1, "entry_price": 140.0, "entry_delta": 0.48, "security_id": "49082"}
      ],
      "notes": null
    }
    ```

- [ ] **Step 1: Write the script**

Create `scripts/tools/strategy_store.py`:

```python
"""
CLI store for saved positional NIFTY options strategies, backed by SQLite.

Usage:
    python strategy_store.py init
    python strategy_store.py save   --json '<StrategyPayload JSON>'
    python strategy_store.py list
    python strategy_store.py get    <id>
    python strategy_store.py update <id> --status open|closed
    python strategy_store.py delete <id>

Prints a single JSON line to stdout. Logs go to stderr.
"""
import sys
import os
import json
import sqlite3
import argparse
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.path.join(ROOT, 'debug', 'strategies.db')

SCHEMA = """
CREATE TABLE IF NOT EXISTS strategies (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_type     TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    underlying        TEXT NOT NULL,
    expiry            TEXT NOT NULL,
    mode              TEXT NOT NULL,
    lots              INTEGER NOT NULL,
    lot_size          INTEGER NOT NULL,
    params_json       TEXT NOT NULL,
    entry_spot        REAL NOT NULL,
    entry_net_premium REAL NOT NULL,
    legs_json         TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'open',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    notes             TEXT
);

CREATE TABLE IF NOT EXISTS strategy_legs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id   INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
    strike        REAL NOT NULL,
    option_type   TEXT NOT NULL,
    side          TEXT NOT NULL,
    qty_lots      INTEGER NOT NULL,
    entry_price   REAL NOT NULL,
    entry_delta   REAL,
    security_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_legs_strategy ON strategy_legs(strategy_id);
"""


def get_connection() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def cmd_init() -> dict:
    get_connection().close()
    return {"ok": True, "db_path": DB_PATH}


def cmd_save(payload: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    conn = get_connection()
    try:
        cur = conn.execute(
            """INSERT INTO strategies
               (strategy_type, display_name, underlying, expiry, mode, lots, lot_size,
                params_json, entry_spot, entry_net_premium, legs_json, status, created_at, updated_at, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)""",
            (
                payload['strategy_type'], payload['display_name'], payload['underlying'],
                payload['expiry'], payload['mode'], int(payload['lots']), int(payload['lot_size']),
                json.dumps(payload.get('params', {})), float(payload['entry_spot']),
                float(payload['entry_net_premium']), json.dumps(payload['legs']),
                now, now, payload.get('notes'),
            ),
        )
        strategy_id = cur.lastrowid
        for leg in payload['legs']:
            conn.execute(
                """INSERT INTO strategy_legs
                   (strategy_id, strike, option_type, side, qty_lots, entry_price, entry_delta, security_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    strategy_id, float(leg['strike']), leg['option_type'], leg['side'],
                    int(leg['qty_lots']), float(leg['entry_price']),
                    leg.get('entry_delta'), leg.get('security_id'),
                ),
            )
        conn.commit()
        return {"id": strategy_id}
    finally:
        conn.close()


def _row_to_dict(row: sqlite3.Row, parse_json: bool) -> dict:
    d = dict(row)
    if parse_json:
        d['params_json'] = json.loads(d['params_json'])
        d['legs_json'] = json.loads(d['legs_json'])
    return d


def cmd_list() -> dict:
    conn = get_connection()
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT * FROM strategies ORDER BY created_at DESC").fetchall()
        return {"strategies": [_row_to_dict(r, parse_json=False) for r in rows]}
    finally:
        conn.close()


def cmd_get(strategy_id: int) -> dict:
    conn = get_connection()
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM strategies WHERE id = ?", (strategy_id,)).fetchone()
        if row is None:
            return {"error": "not_found"}
        return _row_to_dict(row, parse_json=True)
    finally:
        conn.close()


def cmd_update(strategy_id: int, status: str) -> dict:
    conn = get_connection()
    try:
        now = datetime.now(timezone.utc).isoformat()
        cur = conn.execute(
            "UPDATE strategies SET status = ?, updated_at = ? WHERE id = ?",
            (status, now, strategy_id),
        )
        conn.commit()
        if cur.rowcount == 0:
            return {"error": "not_found"}
        return {"ok": True}
    finally:
        conn.close()


def cmd_delete(strategy_id: int) -> dict:
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM strategies WHERE id = ?", (strategy_id,))
        conn.commit()
        if cur.rowcount == 0:
            return {"error": "not_found"}
        return {"ok": True}
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd')

    sub.add_parser('init')

    p_save = sub.add_parser('save')
    p_save.add_argument('--json', required=True, dest='json_payload')

    sub.add_parser('list')

    p_get = sub.add_parser('get')
    p_get.add_argument('id', type=int)

    p_update = sub.add_parser('update')
    p_update.add_argument('id', type=int)
    p_update.add_argument('--status', required=True, choices=['open', 'closed'])

    p_delete = sub.add_parser('delete')
    p_delete.add_argument('id', type=int)

    args = parser.parse_args()

    if args.cmd == 'init':
        result = cmd_init()
    elif args.cmd == 'save':
        result = cmd_save(json.loads(args.json_payload))
    elif args.cmd == 'list':
        result = cmd_list()
    elif args.cmd == 'get':
        result = cmd_get(args.id)
    elif args.cmd == 'update':
        result = cmd_update(args.id, args.status)
    elif args.cmd == 'delete':
        result = cmd_delete(args.id)
    else:
        result = {"error": "unknown command"}

    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(0)
```

- [ ] **Step 2: Run the full CLI round-trip to verify**

Run (from project root `c:\dhan_algo\dhan_algo`):
```powershell
venv\Scripts\python.exe scripts/tools/strategy_store.py init
```
Expected: `{"ok": true, "db_path": "...debug\\strategies.db"}` and the file `debug/strategies.db` now exists.

```powershell
venv\Scripts\python.exe -c "
import subprocess, json
payload = {
  'strategy_type':'short_straddle','display_name':'Short Straddle','underlying':'NIFTY',
  'expiry':'2026-07-30','mode':'positional','lots':1,'lot_size':75,
  'params':{}, 'entry_spot':25010.5, 'entry_net_premium':290.0,
  'legs':[
    {'strike':25000,'option_type':'CE','side':'SELL','qty_lots':1,'entry_price':150.0,'entry_delta':-0.52,'security_id':'49081'},
    {'strike':25000,'option_type':'PE','side':'SELL','qty_lots':1,'entry_price':140.0,'entry_delta':0.48,'security_id':'49082'}
  ], 'notes': None,
}
out = subprocess.run(['venv/Scripts/python.exe','scripts/tools/strategy_store.py','save','--json', json.dumps(payload)], capture_output=True, text=True)
print('save:', out.stdout.strip())
saved_id = json.loads(out.stdout.strip())['id']

out = subprocess.run(['venv/Scripts/python.exe','scripts/tools/strategy_store.py','list'], capture_output=True, text=True)
print('list:', out.stdout.strip())
assert any(s['id']==saved_id for s in json.loads(out.stdout)['strategies'])

out = subprocess.run(['venv/Scripts/python.exe','scripts/tools/strategy_store.py','get', str(saved_id)], capture_output=True, text=True)
got = json.loads(out.stdout.strip())
print('get:', got)
assert got['legs_json'][0]['strike'] == 25000
assert isinstance(got['params_json'], dict)

out = subprocess.run(['venv/Scripts/python.exe','scripts/tools/strategy_store.py','update', str(saved_id), '--status','closed'], capture_output=True, text=True)
print('update:', out.stdout.strip())
assert json.loads(out.stdout)['ok'] is True

out = subprocess.run(['venv/Scripts/python.exe','scripts/tools/strategy_store.py','delete', str(saved_id)], capture_output=True, text=True)
print('delete:', out.stdout.strip())
assert json.loads(out.stdout)['ok'] is True

out = subprocess.run(['venv/Scripts/python.exe','scripts/tools/strategy_store.py','get', str(saved_id)], capture_output=True, text=True)
print('get-after-delete:', out.stdout.strip())
assert json.loads(out.stdout)['error'] == 'not_found'
print('ALL OK')
"
```
Expected: each step prints its JSON, all `assert`s pass, final line `ALL OK`.

- [ ] **Step 3: Commit**

```bash
git add scripts/tools/strategy_store.py
git commit -m "feat(strategy-builder): add SQLite store CLI for saved positional strategies"
```

---

### Task 2: Margin Calculator Script (Python CLI)

**Files:**
- Create: `scripts/tools/options_margin.py`

**Interfaces:**
- Consumes: `lib/dhan_helper.py`'s `DhanHelper.find_option(underlying, expiry, strike, option_type, exchange="NSE", instrument="OPTIDX") -> Optional[Dict]` (returns a dict with `SECURITY_ID`, `LOT_SIZE`, `SEGMENT` keys among others), `DhanHelper.get_margin_calculator_multi(scripts: List[Dict], include_position=True, include_orders=True) -> Dict` (returns `{total_margin, span_margin, exposure_margin, equity_margin, fo_margin, commodity_margin, currency, hedge_benefit}` or `{}` on failure), `DhanHelper.get_available_funds() -> float`.
- Produces (consumed by Task 5's `margin/route.ts`):
  - CLI: `python options_margin.py --underlying NIFTY --expiry 2026-07-30 --legs-json '<LegsInput JSON>'`
  - `LegsInput` = `[{"strike": 25000, "type": "CE", "side": "SELL", "qtyLots": 1, "price": 150.0}, ...]`
  - stdout (success): `{"total_margin": 128400.0, "span_margin": ..., "exposure_margin": ..., "hedge_benefit": ..., "available_funds": 512000.0}`
  - stdout (any leg unresolvable): `{"error": "strike not found: 25000 CE @ 2026-07-30"}`
  - `build_margin_scripts(legs, underlying, expiry, helper) -> List[Dict]` — a separate, pure-ish helper function (still calls `helper.find_option`/`helper.get_lot_size` but has no other I/O) so its leg→`scripts`-entry mapping logic can be sanity-checked independently of a live broker session in Step 2 below.

- [ ] **Step 1: Write the script**

Create `scripts/tools/options_margin.py`:

```python
"""
One-off helper for the Next.js API to compute combined multi-leg margin via Dhan's
margin-calculator/multi endpoint, plus available account funds.

Usage:
    python options_margin.py --underlying NIFTY --expiry 2026-07-30 --legs-json '<json>'

--legs-json is a JSON array: [{"strike":25000,"type":"CE","side":"SELL","qtyLots":1,"price":150.0}, ...]

Prints a single JSON line to stdout. Logs go to stderr.
"""
import sys
import os
import json
import argparse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def build_margin_scripts(legs: list, underlying: str, expiry: str, helper: 'DhanHelper') -> list:
    """Resolve each leg to a Dhan margincalculator/multi 'scripts' entry.

    Raises ValueError with a descriptive message if any leg's contract can't be resolved
    via the master instrument list (find_option) — callers should catch this and surface
    it as {"error": str(exc)}.
    """
    scripts = []
    for leg in legs:
        strike = float(leg['strike'])
        option_type = leg['type'].upper()
        side = leg['side'].upper()
        qty_lots = int(leg['qtyLots'])
        price = float(leg['price'])

        contract = helper.find_option(underlying, expiry, strike, option_type)
        if not contract:
            raise ValueError(f"strike not found: {strike} {option_type} @ {expiry}")

        lot_size = int(contract['LOT_SIZE'])
        scripts.append({
            'exchangeSegment': 'NSE_FNO',
            'transactionType': side,
            'quantity': qty_lots * lot_size,
            'productType': 'MARGIN',
            'securityId': str(contract['SECURITY_ID']),
            'price': price,
        })
    return scripts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--underlying', default='NIFTY')
    parser.add_argument('--expiry', required=True)
    parser.add_argument('--legs-json', required=True, dest='legs_json')
    args = parser.parse_args()

    legs = json.loads(args.legs_json)

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth_failed — run login.py to refresh the access token'}))
        sys.exit(0)

    helper = DhanHelper(dhan)

    scripts = build_margin_scripts(legs, args.underlying.upper(), args.expiry, helper)

    margin = helper.get_margin_calculator_multi(scripts, include_position=True, include_orders=True)
    if not margin:
        print(json.dumps({'error': 'margin_calculator_failed'}))
        sys.exit(0)

    available_funds = helper.get_available_funds()

    print(json.dumps({
        'total_margin': margin.get('total_margin', 0.0),
        'span_margin': margin.get('span_margin', 0.0),
        'exposure_margin': margin.get('exposure_margin', 0.0),
        'hedge_benefit': margin.get('hedge_benefit', 0.0),
        'available_funds': available_funds,
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(0)
```

- [ ] **Step 2: Verify `build_margin_scripts`'s leg-mapping logic with a fake helper (no live broker session needed)**

Run:
```powershell
venv\Scripts\python.exe -c "
import sys, os
sys.path.insert(0, os.getcwd())
from scripts.tools.options_margin import build_margin_scripts

class FakeHelper:
    def find_option(self, underlying, expiry, strike, option_type):
        return {'SECURITY_ID': f'{underlying}-{expiry}-{strike}-{option_type}', 'LOT_SIZE': 75}

legs = [
    {'strike':25000,'type':'CE','side':'SELL','qtyLots':1,'price':150.0},
    {'strike':25000,'type':'PE','side':'SELL','qtyLots':2,'price':140.0},
]
scripts = build_margin_scripts(legs, 'NIFTY', '2026-07-30', FakeHelper())
assert scripts[0]['quantity'] == 75          # 1 lot * 75
assert scripts[1]['quantity'] == 150         # 2 lots * 75
assert scripts[0]['transactionType'] == 'SELL'
assert scripts[0]['exchangeSegment'] == 'NSE_FNO'
assert scripts[0]['productType'] == 'MARGIN'
print('OK', scripts)
"
```
Expected: prints `OK [...]` with two script dicts, no assertion errors.

Run the not-found path:
```powershell
venv\Scripts\python.exe -c "
import sys, os
sys.path.insert(0, os.getcwd())
from scripts.tools.options_margin import build_margin_scripts

class FakeHelperMissing:
    def find_option(self, underlying, expiry, strike, option_type):
        return None

try:
    build_margin_scripts([{'strike':99999,'type':'CE','side':'SELL','qtyLots':1,'price':1.0}], 'NIFTY', '2026-07-30', FakeHelperMissing())
    print('FAIL: expected ValueError')
except ValueError as e:
    print('OK raised:', e)
"
```
Expected: `OK raised: strike not found: 99999.0 CE @ 2026-07-30`.

**Note for whoever runs this against a live account:** the full `main()` path (actual `get_margin_calculator_multi`/`get_available_funds` HTTP calls) requires a valid Dhan session — run `venv\Scripts\python.exe login.py` first if the access token has expired, then manually run e.g. `venv\Scripts\python.exe scripts/tools/options_margin.py --underlying NIFTY --expiry <a real near expiry> --legs-json "[{\"strike\":25000,\"type\":\"CE\",\"side\":\"SELL\",\"qtyLots\":1,\"price\":150.0},{\"strike\":25000,\"type\":\"PE\",\"side\":\"SELL\",\"qtyLots\":1,\"price\":140.0}]"` and confirm one JSON line with a plausible `total_margin`. This live check does not block Task 2's completion (it needs real market hours/session) — note it as a concern in the report if it can't be run in this environment, and it will be exercised end-to-end in Task 9's browser verification instead.

- [ ] **Step 3: Commit**

```bash
git add scripts/tools/options_margin.py
git commit -m "feat(strategy-builder): add combined multi-leg margin calculator CLI"
```

---

### Task 3: Strategy Template Registry & Leg Resolution (TypeScript)

**Files:**
- Create: `rs_dashboard/lib/optionsStrategy.ts`

**Interfaces:**
- Produces (consumed by Task 4 in the same file, and by Task 6/9's UI components):
  - `STRIKE_STEP = 50`
  - `type OptType = 'CE' | 'PE'`, `type Side = 'BUY' | 'SELL'`
  - `interface ParamDef { key: string; label: string; default: number; min: number; max: number; step: number }`
  - `interface LegSpec { offsetStrikes: number; type: OptType; side: Side; qtyRatio: number }`
  - `interface StrategyTemplate { id: string; name: string; undefinedRisk: boolean; params: ParamDef[]; legs: (params: Record<string, number>) => LegSpec[] }`
  - `STRATEGY_TEMPLATES: StrategyTemplate[]` — the 8 templates
  - `interface ChainLegData { last_price: number; oi?: number; implied_volatility?: number; greeks?: { delta?: number; theta?: number; gamma?: number; vega?: number } }`
  - `interface ChainOc { [strike: string]: { ce?: ChainLegData; pe?: ChainLegData } }`
  - `interface ResolvedLeg { strike: number; type: OptType; side: Side; qtyLots: number; price: number; delta: number | null; iv: number | null }`
  - `function computeAtm(spot: number): number`
  - `function resolveLegs(specs: LegSpec[], atm: number, lots: number, oc: ChainOc): { legs: ResolvedLeg[]; missingStrikes: number[] }`
  - `function classifyExpiries(dates: string[]): { date: string; kind: 'weekly' | 'monthly' }[]`

- [ ] **Step 1: Write the module**

Create `rs_dashboard/lib/optionsStrategy.ts`:

```ts
/**
 * Core math + template registry for the multi-leg NIFTY options strategy builder.
 * Pure functions only — no fetch/DOM/React here so this file can be unit-verified
 * standalone (see docs/superpowers/plans/2026-07-06-nifty-strategy-builder.md, Task 3/4).
 */

export const STRIKE_STEP = 50; // NIFTY

export type OptType = 'CE' | 'PE';
export type Side = 'BUY' | 'SELL';

export interface ParamDef {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
}

export interface LegSpec {
  offsetStrikes: number; // signed, in strike steps from ATM
  type: OptType;
  side: Side;
  qtyRatio: number; // multiplied by lots
}

export interface StrategyTemplate {
  id: string;
  name: string;
  undefinedRisk: boolean; // true if any naked short leg exists at default params
  params: ParamDef[];
  legs: (params: Record<string, number>) => LegSpec[];
}

/**
 * Batman and Double Plateau leg shapes are best-effort standard definitions —
 * they vary across brokers/platforms. All offsets below are defaults only;
 * the settings panel (Task 6) always exposes them as user-adjustable params,
 * never hardcodes them past this registry.
 */
export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    id: 'short_straddle', name: 'Short Straddle', undefinedRisk: true, params: [],
    legs: () => [
      { offsetStrikes: 0, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: 0, type: 'PE', side: 'SELL', qtyRatio: 1 },
    ],
  },
  {
    id: 'short_strangle', name: 'Short Strangle', undefinedRisk: true,
    params: [{ key: 'N', label: 'OTM offset (strikes)', default: 2, min: 1, max: 10, step: 1 }],
    legs: (p) => [
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 },
    ],
  },
  {
    id: 'iron_butterfly', name: 'Iron Butterfly', undefinedRisk: false,
    params: [{ key: 'W', label: 'Wing width (strikes)', default: 5, min: 1, max: 15, step: 1 }],
    legs: (p) => [
      { offsetStrikes: 0, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: 0, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +p.W, type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -p.W, type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'iron_condor', name: 'Iron Condor', undefinedRisk: false,
    params: [
      { key: 'N', label: 'Short offset (strikes)', default: 3, min: 1, max: 10, step: 1 },
      { key: 'W', label: 'Wing width (strikes)', default: 3, min: 1, max: 10, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +(p.N + p.W), type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -(p.N + p.W), type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'jade_lizard', name: 'Jade Lizard', undefinedRisk: true,
    params: [
      { key: 'N', label: 'Short offset (strikes)', default: 2, min: 1, max: 10, step: 1 },
      { key: 'W', label: 'Call spread width (strikes)', default: 3, min: 1, max: 10, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 }, // naked put — no downside protection
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +(p.N + p.W), type: 'CE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'reverse_jade_lizard', name: 'Reverse Jade Lizard', undefinedRisk: true,
    params: [
      { key: 'N', label: 'Short offset (strikes)', default: 2, min: 1, max: 10, step: 1 },
      { key: 'W', label: 'Put spread width (strikes)', default: 3, min: 1, max: 10, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 }, // naked call — no upside protection
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -(p.N + p.W), type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'batman', name: 'Batman', undefinedRisk: false,
    params: [
      { key: 'N', label: 'Inner short offset (strikes)', default: 2, min: 1, max: 8, step: 1 },
      { key: 'W', label: 'Outer wing offset (strikes)', default: 5, min: 2, max: 15, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: 0, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: 0, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +p.W, type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -p.W, type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'double_plateau', name: 'Double Plateau', undefinedRisk: false,
    params: [
      { key: 'N1', label: 'Inner short offset (strikes)', default: 2, min: 1, max: 8, step: 1 },
      { key: 'N2', label: 'Outer short offset (strikes)', default: 4, min: 2, max: 12, step: 1 },
      { key: 'W', label: 'Wing width (strikes)', default: 3, min: 1, max: 8, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: +p.N1, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -p.N1, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +p.N2, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -p.N2, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +(p.N2 + p.W), type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -(p.N2 + p.W), type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
];

export function getTemplate(id: string): StrategyTemplate | undefined {
  return STRATEGY_TEMPLATES.find((t) => t.id === id);
}

export function defaultParams(template: StrategyTemplate): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of template.params) out[p.key] = p.default;
  return out;
}

export function computeAtm(spot: number): number {
  return Math.round(spot / STRIKE_STEP) * STRIKE_STEP;
}

// ── Chain data shapes (mirrors /api/options/chain's `data.chain.oc`) ───────────

export interface ChainLegData {
  last_price: number;
  oi?: number;
  implied_volatility?: number;
  greeks?: { delta?: number; theta?: number; gamma?: number; vega?: number };
}
export interface ChainOc {
  [strike: string]: { ce?: ChainLegData; pe?: ChainLegData };
}

export interface ResolvedLeg {
  strike: number;
  type: OptType;
  side: Side;
  qtyLots: number;
  price: number;
  delta: number | null;
  iv: number | null;
}

/**
 * Resolve LegSpecs (offsets from ATM) against a fetched option chain into concrete
 * strikes with current price/delta/IV. Strikes absent from the chain are reported
 * in `missingStrikes` rather than silently defaulted — callers must block Analyze
 * on a non-empty `missingStrikes`.
 */
export function resolveLegs(
  specs: LegSpec[],
  atm: number,
  lots: number,
  oc: ChainOc,
): { legs: ResolvedLeg[]; missingStrikes: number[] } {
  const legs: ResolvedLeg[] = [];
  const missingStrikes: number[] = [];

  for (const spec of specs) {
    const strike = atm + spec.offsetStrikes * STRIKE_STEP;
    const strikeKey = String(strike);
    const entry = oc[strikeKey];
    const legData = spec.type === 'CE' ? entry?.ce : entry?.pe;

    if (!legData || typeof legData.last_price !== 'number') {
      missingStrikes.push(strike);
      continue;
    }

    legs.push({
      strike,
      type: spec.type,
      side: spec.side,
      qtyLots: lots * spec.qtyRatio,
      price: legData.last_price,
      delta: legData.greeks?.delta ?? null,
      iv: legData.implied_volatility ?? null,
    });
  }

  return { legs, missingStrikes };
}

// ── Expiry classifier (client-side, no backend change) ─────────────────────────

export type ExpiryKind = 'weekly' | 'monthly';

/** The LAST expiry date within each calendar month is classified as 'monthly'; every other date is 'weekly'. */
export function classifyExpiries(dates: string[]): { date: string; kind: ExpiryKind }[] {
  const byMonth = new Map<string, string[]>();
  for (const d of dates) {
    const key = d.slice(0, 7); // 'YYYY-MM'
    const arr = byMonth.get(key);
    if (arr) arr.push(d);
    else byMonth.set(key, [d]);
  }
  const monthly = new Set<string>();
  for (const arr of byMonth.values()) {
    const sorted = [...arr].sort();
    monthly.add(sorted[sorted.length - 1]);
  }
  return dates.map((d) => ({ date: d, kind: monthly.has(d) ? 'monthly' : 'weekly' }));
}
```

- [ ] **Step 2: Verify with a temporary compiled check (no test framework exists in this repo — see Global Constraints)**

Create a temporary file `rs_dashboard/lib/__verify_task3.ts` (relative import, not the `@/` alias, so plain `tsc` can compile it standalone):

```ts
import { STRATEGY_TEMPLATES, getTemplate, defaultParams, computeAtm, resolveLegs, classifyExpiries, STRIKE_STEP } from './optionsStrategy';

// 1. All 8 templates present
console.assert(STRATEGY_TEMPLATES.length === 8, `expected 8 templates, got ${STRATEGY_TEMPLATES.length}`);

// 2. Iron Condor leg count and offsets at default params
const condor = getTemplate('iron_condor')!;
const condorLegs = condor.legs(defaultParams(condor));
console.assert(condorLegs.length === 4, `iron condor should have 4 legs, got ${condorLegs.length}`);
console.assert(condorLegs[0].offsetStrikes === 3 && condorLegs[0].side === 'SELL' && condorLegs[0].type === 'CE', 'condor short call offset wrong');
console.assert(condorLegs[2].offsetStrikes === 6 && condorLegs[2].side === 'BUY', 'condor long call offset wrong');

// 3. Jade Lizard has exactly one naked leg (3 legs total)
const jade = getTemplate('jade_lizard')!;
const jadeLegs = jade.legs(defaultParams(jade));
console.assert(jadeLegs.length === 3, `jade lizard should have 3 legs, got ${jadeLegs.length}`);

// 4. computeAtm rounds to nearest 50
console.assert(computeAtm(25012) === 25000, `computeAtm(25012) should be 25000, got ${computeAtm(25012)}`);
console.assert(computeAtm(25038) === 25050, `computeAtm(25038) should be 25050, got ${computeAtm(25038)}`);

// 5. resolveLegs: straddle against a fake chain
const straddle = getTemplate('short_straddle')!;
const straddleLegs = straddle.legs(defaultParams(straddle));
const fakeOc = {
  '25000': {
    ce: { last_price: 150, greeks: { delta: -0.52 }, implied_volatility: 0.13 },
    pe: { last_price: 140, greeks: { delta: 0.48 }, implied_volatility: 0.135 },
  },
};
const { legs, missingStrikes } = resolveLegs(straddleLegs, 25000, 1, fakeOc);
console.assert(legs.length === 2 && missingStrikes.length === 0, 'straddle resolution should find both legs');
console.assert(legs[0].price === 150 && legs[1].price === 140, 'resolved prices wrong');

// 6. resolveLegs: missing strike reported, not silently dropped/defaulted
const { missingStrikes: missing2 } = resolveLegs(straddleLegs, 30000, 1, fakeOc);
console.assert(missing2.length === 2, `expected 2 missing strikes, got ${missing2.length}`);

// 7. classifyExpiries: last date per month is 'monthly'
const kinds = classifyExpiries(['2026-07-09', '2026-07-16', '2026-07-30', '2026-08-06', '2026-08-27']);
console.assert(kinds.find(k => k.date === '2026-07-30')!.kind === 'monthly', 'last July date should be monthly');
console.assert(kinds.find(k => k.date === '2026-07-09')!.kind === 'weekly', 'non-last July date should be weekly');
console.assert(kinds.find(k => k.date === '2026-08-27')!.kind === 'monthly', 'last Aug date should be monthly');

console.log('TASK 3 VERIFY OK, STRIKE_STEP=', STRIKE_STEP);
```

Run:
```bash
cd rs_dashboard
npx tsc --module commonjs --target es2020 --moduleResolution node --esModuleInterop --outDir .tmp-verify lib/optionsStrategy.ts lib/__verify_task3.ts
node .tmp-verify/lib/__verify_task3.js
```
Expected: `TASK 3 VERIFY OK, STRIKE_STEP= 50` printed, with no `Assertion failed` lines before it (Node's `console.assert` prints `Assertion failed: <message>` to stderr but does not throw — visually confirm none of the assert messages appear).

- [ ] **Step 3: Clean up temp files (not committed)**

```bash
cd rs_dashboard
rm -rf .tmp-verify lib/__verify_task3.ts
```

- [ ] **Step 4: Commit**

```bash
git add rs_dashboard/lib/optionsStrategy.ts
git commit -m "feat(strategy-builder): add 8-strategy template registry and leg resolution"
```

---

### Task 4: Payoff & Risk Math Engine (TypeScript, extends Task 3's file)

**Files:**
- Modify: `rs_dashboard/lib/optionsStrategy.ts` (append to the file created in Task 3)

**Interfaces:**
- Consumes: `ResolvedLeg`, `OptType`, `Side` from Task 3 (same file).
- Produces (consumed by Task 7/8/9's UI components):
  - `function legPayoffAtExpiry(spot: number, leg: ResolvedLeg): number` — per-unit-of-lot payoff (not yet multiplied by lotSize)
  - `function buildPayoffCurve(legs: ResolvedLeg[], spot: number, lotSize: number): { spot: number; pnl: number }[]`
  - `interface PayoffStats { maxProfit: number | 'Unlimited'; maxLoss: number | 'Unlimited'; breakevensExpiry: number[]; rewardRisk: number | null; netPremium: number; intrinsicValue: number; timeValue: number; popPct: number | null }`
  - `function computePayoffStats(legs: ResolvedLeg[], spot: number, lotSize: number): PayoffStats`
  - `function bsPrice(type: OptType, S: number, K: number, t: number, iv: number, r?: number): number`
  - `function buildTargetPayoffCurve(legs: ResolvedLeg[], spot: number, lotSize: number, daysToExpiry: number): { spot: number; pnl: number }[]`
  - `function findBreakevens(curve: { spot: number; pnl: number }[]): number[]`

- [ ] **Step 1: Append the math engine to the same file**

Append to `rs_dashboard/lib/optionsStrategy.ts` (after the `classifyExpiries` function):

```ts
// ── Payoff engine ────────────────────────────────────────────────────────────

/** Per-unit-of-lot payoff at a given expiry spot price (not yet scaled by lotSize). */
export function legPayoffAtExpiry(spot: number, leg: ResolvedLeg): number {
  const intrinsic = leg.type === 'CE' ? Math.max(spot - leg.strike, 0) : Math.max(leg.strike - spot, 0);
  const perUnit = leg.side === 'SELL' ? (leg.price - intrinsic) : (intrinsic - leg.price);
  return perUnit * leg.qtyLots;
}

function netPnlAtExpiry(legs: ResolvedLeg[], spot: number, lotSize: number): number {
  return legs.reduce((sum, leg) => sum + legPayoffAtExpiry(spot, leg), 0) * lotSize;
}

/** Zero-crossings of a piecewise-linear {spot, pnl} curve, via linear interpolation between adjacent samples. */
export function findBreakevens(curve: { spot: number; pnl: number }[]): number[] {
  const breakevens: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const [s0, p0] = [curve[i - 1].spot, curve[i - 1].pnl];
    const [s1, p1] = [curve[i].spot, curve[i].pnl];
    if (p0 === 0) { breakevens.push(s0); continue; }
    if ((p0 < 0 && p1 > 0) || (p0 > 0 && p1 < 0)) {
      const be = s0 + (0 - p0) * (s1 - s0) / (p1 - p0);
      breakevens.push(Math.round(be * 100) / 100);
    }
  }
  return breakevens;
}

/**
 * Sample spot range covering all wings for a NIFTY strategy: +/-15% of spot, with
 * every leg's strike forced in as an exact sample point (piecewise-linear kinks
 * only occur at strikes, so max/min and breakevens must be evaluated exactly there).
 */
function buildSpotSamples(legs: ResolvedLeg[], spot: number): number[] {
  const lo = spot * 0.85;
  const hi = spot * 1.15;
  const samples = new Set<number>();
  const stepCount = 200;
  for (let i = 0; i <= stepCount; i++) {
    samples.add(Math.round((lo + ((hi - lo) * i) / stepCount) * 100) / 100);
  }
  for (const leg of legs) samples.add(leg.strike);
  return [...samples].sort((a, b) => a - b);
}

export function buildPayoffCurve(
  legs: ResolvedLeg[], spot: number, lotSize: number,
): { spot: number; pnl: number }[] {
  return buildSpotSamples(legs, spot).map((s) => ({ spot: s, pnl: netPnlAtExpiry(legs, s, lotSize) }));
}

export interface PayoffStats {
  maxProfit: number | 'Unlimited';
  maxLoss: number | 'Unlimited';
  breakevensExpiry: number[];
  rewardRisk: number | null;
  netPremium: number;      // per lot, credit(+)/debit(-)
  intrinsicValue: number;  // rupees, at current spot
  timeValue: number;       // rupees, at current spot
  popPct: number | null;
}

export function computePayoffStats(legs: ResolvedLeg[], spot: number, lotSize: number): PayoffStats {
  const curve = buildPayoffCurve(legs, spot, lotSize);

  // Net qty per side (signed lots): >0 means net SHORT that option type -> unbounded loss on that tail.
  const netCallQty = legs.filter(l => l.type === 'CE').reduce((s, l) => s + (l.side === 'SELL' ? l.qtyLots : -l.qtyLots), 0);
  const netPutQty  = legs.filter(l => l.type === 'PE').reduce((s, l) => s + (l.side === 'SELL' ? l.qtyLots : -l.qtyLots), 0);

  const upsideUnlimited = netCallQty > 0;
  const downsideUnlimited = netPutQty > 0;

  const pnls = curve.map(c => c.pnl);
  const maxProfit = Math.max(...pnls);
  const boundedMinLoss = Math.min(...pnls);
  const maxLoss: number | 'Unlimited' = (upsideUnlimited || downsideUnlimited) ? 'Unlimited' : boundedMinLoss;

  const rewardRisk = (maxLoss === 'Unlimited' || maxLoss === 0) ? null : Math.abs(maxProfit / maxLoss);

  const netPremium = legs.reduce((sum, leg) => sum + (leg.side === 'SELL' ? leg.price : -leg.price) * leg.qtyLots, 0);

  let intrinsicValue = 0;
  let timeValue = 0;
  for (const leg of legs) {
    const intrinsicNow = leg.type === 'CE' ? Math.max(spot - leg.strike, 0) : Math.max(leg.strike - spot, 0);
    const sideSign = leg.side === 'SELL' ? 1 : -1;
    intrinsicValue += sideSign * leg.qtyLots * intrinsicNow * lotSize;
    timeValue += sideSign * leg.qtyLots * (leg.price - intrinsicNow) * lotSize;
  }

  // POP: delta-based approximation. Net effective short delta = short legs' |delta| minus
  // hedge (long) legs' |delta| on the same side, floored at 0.
  const hasAllDeltas = legs.every(l => l.delta !== null);
  let popPct: number | null = null;
  if (hasAllDeltas) {
    const shortAbsDelta = legs.filter(l => l.side === 'SELL').reduce((s, l) => s + Math.abs(l.delta as number), 0);
    const longAbsDelta  = legs.filter(l => l.side === 'BUY').reduce((s, l) => s + Math.abs(l.delta as number), 0);
    const effShortDelta = Math.max(0, shortAbsDelta - longAbsDelta);
    popPct = Math.round(Math.min(1, Math.max(0, 1 - effShortDelta)) * 100);
  }

  return {
    maxProfit,
    maxLoss,
    breakevensExpiry: findBreakevens(curve),
    rewardRisk,
    netPremium,
    intrinsicValue,
    timeValue,
    popPct,
  };
}

// ── Minimal Black-Scholes pricer for "Target" (pre-expiry) breakevens ──────────

/** Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation (no external dependency). */
function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1) * t * Math.exp(-ax*ax);
  return 0.5 * (1 + sign * y);
}

/** Black-Scholes European option price. t in years, iv as a fraction (e.g. 0.13), r default 6.5%. */
export function bsPrice(type: OptType, S: number, K: number, t: number, iv: number, r = 0.065): number {
  if (t <= 0 || iv <= 0) {
    return type === 'CE' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  }
  const d1 = (Math.log(S / K) + (r + (iv * iv) / 2) * t) / (iv * Math.sqrt(t));
  const d2 = d1 - iv * Math.sqrt(t);
  if (type === 'CE') {
    return S * normCdf(d1) - K * Math.exp(-r * t) * normCdf(d2);
  }
  return K * Math.exp(-r * t) * normCdf(-d2) - S * normCdf(-d1);
}

/**
 * "Target" (pre-expiry, today) P&L curve using each leg's current IV and current DTE.
 * Falls back to intrinsic-only pricing for a leg with no IV (documented limitation,
 * surfaced by the caller via an InfoButton — see Task 8).
 */
export function buildTargetPayoffCurve(
  legs: ResolvedLeg[], spot: number, lotSize: number, daysToExpiry: number,
): { spot: number; pnl: number }[] {
  const t = Math.max(daysToExpiry, 0) / 365;
  return buildSpotSamples(legs, spot).map((s) => {
    const pnl = legs.reduce((sum, leg) => {
      const iv = leg.iv ?? 0;
      const price = iv > 0 ? bsPrice(leg.type, s, leg.strike, t, iv) : (leg.type === 'CE' ? Math.max(s - leg.strike, 0) : Math.max(leg.strike - s, 0));
      const perUnit = leg.side === 'SELL' ? (leg.price - price) : (price - leg.price);
      return sum + perUnit * leg.qtyLots;
    }, 0) * lotSize;
    return { spot: s, pnl };
  });
}
```

- [ ] **Step 2: Verify with a temporary compiled check**

Create `rs_dashboard/lib/__verify_task4.ts`:

```ts
import { getTemplate, defaultParams, resolveLegs, computePayoffStats, buildPayoffCurve, bsPrice, ResolvedLeg } from './optionsStrategy';

const LOT_SIZE = 75;

// Hand-computed short straddle: ATM=25000, CE=150, PE=140, 1 lot.
// Net credit = 290. Max profit at S=25000 = 290*75 = 21750.
// Breakevens = 25000 +/- 290 = 24710 / 25290.
const straddleLegs: ResolvedLeg[] = [
  { strike: 25000, type: 'CE', side: 'SELL', qtyLots: 1, price: 150, delta: -0.52, iv: 0.13 },
  { strike: 25000, type: 'PE', side: 'SELL', qtyLots: 1, price: 140, delta: 0.48, iv: 0.135 },
];
const straddleStats = computePayoffStats(straddleLegs, 25000, LOT_SIZE);
console.assert(Math.abs(straddleStats.maxProfit - 21750) < 1, `expected maxProfit ~21750, got ${straddleStats.maxProfit}`);
console.assert(straddleStats.maxLoss === 'Unlimited', `straddle maxLoss should be Unlimited, got ${straddleStats.maxLoss}`);
console.assert(straddleStats.breakevensExpiry.length === 2, `expected 2 breakevens, got ${straddleStats.breakevensExpiry.length}`);
const [lowerBE, upperBE] = straddleStats.breakevensExpiry;
console.assert(Math.abs(lowerBE - 24710) < 5, `expected lower BE ~24710, got ${lowerBE}`);
console.assert(Math.abs(upperBE - 25290) < 5, `expected upper BE ~25290, got ${upperBE}`);
console.assert(Math.abs(straddleStats.netPremium - 290) < 0.01, `expected netPremium 290, got ${straddleStats.netPremium}`);

// POP sanity: |delta_call|=0.16, |delta_put|=0.18 -> POP ~ 1-(0.16+0.18) = 0.66
const strangleLegs: ResolvedLeg[] = [
  { strike: 25200, type: 'CE', side: 'SELL', qtyLots: 1, price: 60, delta: -0.16, iv: 0.13 },
  { strike: 24800, type: 'PE', side: 'SELL', qtyLots: 1, price: 55, delta: 0.18, iv: 0.135 },
];
const strangleStats = computePayoffStats(strangleLegs, 25000, LOT_SIZE);
console.assert(strangleStats.popPct === 66, `expected POP 66, got ${strangleStats.popPct}`);

// Iron Condor: bounded on both sides, two breakevens.
const condor = getTemplate('iron_condor')!;
const condorSpecs = condor.legs(defaultParams(condor));
const fakeOc = {
  '25150': { ce: { last_price: 80, greeks: { delta: -0.30 }, implied_volatility: 0.13 } },
  '24850': { pe: { last_price: 75, greeks: { delta: 0.30 }, implied_volatility: 0.13 } },
  '25300': { ce: { last_price: 30, greeks: { delta: -0.12 }, implied_volatility: 0.13 } },
  '24700': { pe: { last_price: 28, greeks: { delta: 0.12 }, implied_volatility: 0.13 } },
} as const;
const { legs: condorLegs, missingStrikes: condorMissing } = resolveLegs(condorSpecs, 25000, 1, fakeOc as any);
console.assert(condorMissing.length === 0, `condor should resolve all legs, missing: ${condorMissing}`);
const condorStats = computePayoffStats(condorLegs, 25000, LOT_SIZE);
console.assert(typeof condorStats.maxLoss === 'number', `condor maxLoss should be bounded, got ${condorStats.maxLoss}`);
console.assert(condorStats.breakevensExpiry.length === 2, `condor should have 2 breakevens, got ${condorStats.breakevensExpiry.length}`);

// Jade Lizard: net short put with no long put hedge -> downside Unlimited.
const jade = getTemplate('jade_lizard')!;
const jadeSpecs = jade.legs(defaultParams(jade));
const jadeOc = {
  '24800': { pe: { last_price: 70, greeks: { delta: 0.20 }, implied_volatility: 0.13 } },
  '25200': { ce: { last_price: 55, greeks: { delta: -0.18 }, implied_volatility: 0.13 } },
  '25350': { ce: { last_price: 25, greeks: { delta: -0.09 }, implied_volatility: 0.13 } },
} as const;
const { legs: jadeLegs, missingStrikes: jadeMissing } = resolveLegs(jadeSpecs, 25000, 1, jadeOc as any);
console.assert(jadeMissing.length === 0, `jade should resolve all legs, missing: ${jadeMissing}`);
const jadeStats = computePayoffStats(jadeLegs, 25000, LOT_SIZE);
console.assert(jadeStats.maxLoss === 'Unlimited', `jade lizard maxLoss should be Unlimited (naked put), got ${jadeStats.maxLoss}`);

// bsPrice: at t->0 should converge to intrinsic value.
const tinyT = 0.0001;
const ceNearExpiry = bsPrice('CE', 25100, 25000, tinyT, 0.13);
console.assert(Math.abs(ceNearExpiry - 100) < 5, `CE near expiry should be ~intrinsic 100, got ${ceNearExpiry}`);

console.log('TASK 4 VERIFY OK');
```

Run:
```bash
cd rs_dashboard
npx tsc --module commonjs --target es2020 --moduleResolution node --esModuleInterop --outDir .tmp-verify lib/optionsStrategy.ts lib/__verify_task4.ts
node .tmp-verify/lib/__verify_task4.js
```
Expected: `TASK 4 VERIFY OK` printed, no `Assertion failed` lines.

- [ ] **Step 3: Clean up temp files (not committed)**

```bash
cd rs_dashboard
rm -rf .tmp-verify lib/__verify_task4.ts
```

- [ ] **Step 4: Commit**

```bash
git add rs_dashboard/lib/optionsStrategy.ts
git commit -m "feat(strategy-builder): add payoff curve, max P/L, breakeven, POP and BS pricer"
```

---

### Task 5: Next.js API Routes (margin + saved-strategies CRUD)

**Files:**
- Create: `rs_dashboard/app/api/options/margin/route.ts`
- Create: `rs_dashboard/app/api/saved-strategies/route.ts`
- Create: `rs_dashboard/app/api/saved-strategies/[id]/route.ts`

**Interfaces:**
- Consumes: `scripts/tools/options_margin.py` (Task 2) and `scripts/tools/strategy_store.py` (Task 1) via `spawnSync`.
- Produces (consumed by Task 9/10's components):
  - `POST /api/options/margin` body `{underlying, expiry, legs: [{strike, type, side, qtyLots, price}]}` → `{success: true, data: {total_margin, span_margin, exposure_margin, hedge_benefit, available_funds}}` or `{success: false, error}`.
  - `GET /api/saved-strategies` → `{success: true, data: StrategyRow[]}`.
  - `POST /api/saved-strategies` body = full `StrategyPayload` (Task 1's shape) → `{success: true, data: {id}}`.
  - `GET /api/saved-strategies/[id]` → `{success: true, data: StrategyRow}` (with `legs_json`/`params_json` as parsed objects) or `{success: false, error: 'not_found'}` (404).
  - `PATCH /api/saved-strategies/[id]` body `{status: 'open'|'closed'}` → `{success: true}`.
  - `DELETE /api/saved-strategies/[id]` → `{success: true}`.

- [ ] **Step 1: Write the margin route**

Create `rs_dashboard/app/api/options/margin/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE    = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const MARGIN_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_margin.py');

interface MarginLegInput { strike: number; type: 'CE' | 'PE'; side: 'BUY' | 'SELL'; qtyLots: number; price: number }

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as
    { underlying?: string; expiry?: string; legs?: MarginLegInput[] } | null;

  if (!body?.expiry || !body?.legs?.length) {
    return NextResponse.json({ success: false, error: 'expiry and legs are required' }, { status: 400 });
  }
  const underlying = (body.underlying ?? 'NIFTY').toUpperCase();

  const result = spawnSync(
    PYTHON_EXE,
    [MARGIN_SCRIPT, '--underlying', underlying, '--expiry', body.expiry, '--legs-json', JSON.stringify(body.legs)],
    { encoding: 'utf8', timeout: 45_000, windowsHide: true },
  );

  if (result.error) {
    console.error('[/api/options/margin] spawn error:', result.error);
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }

  try {
    const stdout = result.stdout ?? '';
    const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(jsonLine) as {
      total_margin?: number; span_margin?: number; exposure_margin?: number;
      hedge_benefit?: number; available_funds?: number; error?: string;
    };

    if (parsed.error) {
      const stderr = (result.stderr ?? '').slice(0, 500);
      console.error('[/api/options/margin] script error:', parsed.error, stderr);
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      data: {
        total_margin: parsed.total_margin ?? 0,
        span_margin: parsed.span_margin ?? 0,
        exposure_margin: parsed.exposure_margin ?? 0,
        hedge_benefit: parsed.hedge_benefit ?? 0,
        available_funds: parsed.available_funds ?? 0,
      },
    });
  } catch (err) {
    const stderr = (result.stderr ?? '').slice(0, 500);
    console.error('[/api/options/margin] parse error:', err, '\nstdout:', result.stdout, '\nstderr:', stderr);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}
```

- [ ] **Step 2: Write the strategies list/save route**

Create `rs_dashboard/app/api/saved-strategies/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT  = path.resolve(process.cwd(), '..');
const PYTHON_EXE    = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const STORE_SCRIPT  = path.join(PROJECT_ROOT, 'scripts', 'tools', 'strategy_store.py');

function runStore(args: string[]) {
  return spawnSync(PYTHON_EXE, [STORE_SCRIPT, ...args], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
}

function parseLastJsonLine(stdout: string | null): any {
  const jsonLine = (stdout ?? '').trim().split('\n').pop() ?? '{}';
  return JSON.parse(jsonLine);
}

export async function GET() {
  const result = runStore(['list']);
  if (result.error) {
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }
  try {
    const parsed = parseLastJsonLine(result.stdout);
    if (parsed.error) return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    return NextResponse.json({ success: true, data: parsed.strategies ?? [] });
  } catch (err) {
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ success: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const result = runStore(['save', '--json', JSON.stringify(body)]);
  if (result.error) {
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }
  try {
    const parsed = parseLastJsonLine(result.stdout);
    if (parsed.error) return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    return NextResponse.json({ success: true, data: parsed });
  } catch (err) {
    const stderr = (result.stderr ?? '').slice(0, 500);
    console.error('[/api/saved-strategies POST] parse error:', err, stderr);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}
```

- [ ] **Step 3: Write the single-strategy route**

Create `rs_dashboard/app/api/saved-strategies/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const STORE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'strategy_store.py');

function runStore(args: string[]) {
  return spawnSync(PYTHON_EXE, [STORE_SCRIPT, ...args], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
}

function parseLastJsonLine(stdout: string | null): any {
  const jsonLine = (stdout ?? '').trim().split('\n').pop() ?? '{}';
  return JSON.parse(jsonLine);
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = runStore(['get', id]);
  if (result.error) {
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }
  try {
    const parsed = parseLastJsonLine(result.stdout);
    if (parsed.error === 'not_found') return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 });
    if (parsed.error) return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    return NextResponse.json({ success: true, data: parsed });
  } catch (err) {
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { status?: string } | null;
  if (!body?.status) {
    return NextResponse.json({ success: false, error: 'status is required' }, { status: 400 });
  }
  const result = runStore(['update', id, '--status', body.status]);
  if (result.error) {
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }
  try {
    const parsed = parseLastJsonLine(result.stdout);
    if (parsed.error === 'not_found') return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 });
    if (parsed.error) return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = runStore(['delete', id]);
  if (result.error) {
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }
  try {
    const parsed = parseLastJsonLine(result.stdout);
    if (parsed.error === 'not_found') return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 });
    if (parsed.error) return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}
```

**Before writing these three files**, read at least one relevant guide under `rs_dashboard/node_modules/next/dist/docs/` covering route handlers and the dynamic-segment `params` API (per `rs_dashboard/AGENTS.md`'s warning that this Next.js version has breaking changes) — confirm whether `params` in a route handler's second argument is a plain object or a `Promise` to await in this installed Next.js version (16.2.9), and adjust the `[id]/route.ts` signatures above if the awaited-`Promise` form shown is not correct for this version.

- [ ] **Step 4: Verify by running the dev server and curling the routes**

```bash
cd rs_dashboard
npm run dev
```
In a second terminal, once the server is up on `http://localhost:3000`:
```bash
curl -s -X POST http://localhost:3000/api/saved-strategies -H "Content-Type: application/json" -d "{\"strategy_type\":\"short_straddle\",\"display_name\":\"Short Straddle\",\"underlying\":\"NIFTY\",\"expiry\":\"2026-07-30\",\"mode\":\"positional\",\"lots\":1,\"lot_size\":75,\"params\":{},\"entry_spot\":25010.5,\"entry_net_premium\":290.0,\"legs\":[{\"strike\":25000,\"option_type\":\"CE\",\"side\":\"SELL\",\"qty_lots\":1,\"entry_price\":150.0,\"entry_delta\":-0.52,\"security_id\":\"49081\"},{\"strike\":25000,\"option_type\":\"PE\",\"side\":\"SELL\",\"qty_lots\":1,\"entry_price\":140.0,\"entry_delta\":0.48,\"security_id\":\"49082\"}]}"
```
Expected: `{"success":true,"data":{"id":<some id>}}`. Then:
```bash
curl -s http://localhost:3000/api/saved-strategies
curl -s http://localhost:3000/api/saved-strategies/<id-from-above>
curl -s -X PATCH http://localhost:3000/api/saved-strategies/<id> -H "Content-Type: application/json" -d "{\"status\":\"closed\"}"
curl -s -X DELETE http://localhost:3000/api/saved-strategies/<id>
```
Expected: each returns `{"success":true,...}` matching the shapes above; the `GET /api/saved-strategies` list includes the saved row; the final `GET` after `DELETE` returns 404 with `{"success":false,"error":"not_found"}`.

The margin route requires a live Dhan session (see Task 2's note) — if one isn't available in this environment, confirm at minimum that a request with a clearly-bad expiry returns a clean `{"success":false,"error":...}` rather than a crash, and defer the full live check to Task 9's end-to-end browser verification.

Stop the dev server (Ctrl+C) when done.

- [ ] **Step 5: Commit**

```bash
git add rs_dashboard/app/api/options/margin/route.ts rs_dashboard/app/api/saved-strategies/route.ts "rs_dashboard/app/api/saved-strategies/[id]/route.ts"
git commit -m "feat(strategy-builder): add margin and saved-strategies API routes"
```

---

### Task 6: Page Shell, NavBar Entry, Strategy Card Grid & Settings Panel

**Files:**
- Create: `rs_dashboard/app/strategy-builder/page.tsx`
- Create: `rs_dashboard/components/strategy/StrategyCardGrid.tsx`
- Create: `rs_dashboard/components/strategy/StrategySettingsPanel.tsx`
- Modify: `rs_dashboard/components/NavBar.tsx` (add one entry to the `Derivatives` group, after the existing `links: [` array entry at line 46 `'/strangle-analysis'`)

**Interfaces:**
- Consumes: `STRATEGY_TEMPLATES`, `StrategyTemplate`, `ParamDef`, `defaultParams`, `classifyExpiries`, `ExpiryKind` from `@/lib/optionsStrategy` (Task 3).
- Produces (consumed by Task 9):
  - `StrategyCardGrid` props: `{ templates: StrategyTemplate[]; selectedId: string | null; onSelect: (id: string) => void }`
  - `StrategySettingsPanel` props:
    ```ts
    interface StrategySettingsPanelProps {
      template: StrategyTemplate;
      params: Record<string, number>;
      onParamsChange: (params: Record<string, number>) => void;
      lots: number;
      onLotsChange: (lots: number) => void;
      mode: 'intraday' | 'positional';
      onModeChange: (mode: 'intraday' | 'positional') => void;
      expiryKindFilter: 'weekly' | 'monthly' | 'all';
      onExpiryKindFilterChange: (k: 'weekly' | 'monthly' | 'all') => void;
      expiries: { date: string; kind: 'weekly' | 'monthly' }[];
      selectedExpiry: string;
      onExpiryChange: (expiry: string) => void;
      onAnalyze: () => void;
      onSave: () => void;
      canSave: boolean; // only enabled when mode === 'positional' and analysis has run
    }
    ```

- [ ] **Step 1: Create the page shell**

Create `rs_dashboard/app/strategy-builder/page.tsx`:

```tsx
import StrategyBuilder from '@/components/StrategyBuilder';

export const metadata = { title: 'Strategy Builder' };

export default function StrategyBuilderPage() {
  return <StrategyBuilder />;
}
```

- [ ] **Step 2: Create the strategy card grid**

Create `rs_dashboard/components/strategy/StrategyCardGrid.tsx`:

```tsx
'use client';

import { StrategyTemplate } from '@/lib/optionsStrategy';

interface StrategyCardGridProps {
  templates: StrategyTemplate[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function StrategyCardGrid({ templates, selectedId, onSelect }: StrategyCardGridProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {templates.map((t) => {
        const active = t.id === selectedId;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`text-left rounded-2xl border p-4 transition-colors ${
              active
                ? 'bg-sky-950 border-sky-600'
                : 'bg-zinc-900/60 border-zinc-800 hover:border-zinc-600'
            }`}
          >
            <div className="text-sm font-semibold text-white">{t.name}</div>
            {t.undefinedRisk && (
              <div className="mt-1 text-[10px] font-medium text-amber-400 uppercase tracking-wide">
                Undefined risk
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Create the settings panel**

Create `rs_dashboard/components/strategy/StrategySettingsPanel.tsx`:

```tsx
'use client';

import { StrategyTemplate } from '@/lib/optionsStrategy';

interface StrategySettingsPanelProps {
  template: StrategyTemplate;
  params: Record<string, number>;
  onParamsChange: (params: Record<string, number>) => void;
  lots: number;
  onLotsChange: (lots: number) => void;
  mode: 'intraday' | 'positional';
  onModeChange: (mode: 'intraday' | 'positional') => void;
  expiryKindFilter: 'weekly' | 'monthly' | 'all';
  onExpiryKindFilterChange: (k: 'weekly' | 'monthly' | 'all') => void;
  expiries: { date: string; kind: 'weekly' | 'monthly' }[];
  selectedExpiry: string;
  onExpiryChange: (expiry: string) => void;
  onAnalyze: () => void;
  onSave: () => void;
  canSave: boolean;
}

export default function StrategySettingsPanel({
  template, params, onParamsChange, lots, onLotsChange, mode, onModeChange,
  expiryKindFilter, onExpiryKindFilterChange, expiries, selectedExpiry, onExpiryChange,
  onAnalyze, onSave, canSave,
}: StrategySettingsPanelProps) {
  const visibleExpiries = expiries.filter((e) => expiryKindFilter === 'all' || e.kind === expiryKindFilter);

  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md overflow-hidden border border-zinc-700 text-xs">
          {(['weekly', 'monthly', 'all'] as const).map((k) => (
            <button
              key={k}
              onClick={() => onExpiryKindFilterChange(k)}
              className={`px-3 py-1 font-medium capitalize ${
                expiryKindFilter === k ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <select
          value={selectedExpiry}
          onChange={(e) => onExpiryChange(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2 py-1"
        >
          {visibleExpiries.map((e) => (
            <option key={e.date} value={e.date}>{e.date} ({e.kind})</option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        {template.params.map((p) => (
          <label key={p.key} className="flex flex-col gap-1 text-xs text-zinc-400">
            {p.label}
            <input
              type="number"
              min={p.min}
              max={p.max}
              step={p.step}
              value={params[p.key] ?? p.default}
              onChange={(e) => onParamsChange({ ...params, [p.key]: Number(e.target.value) })}
              className="bg-zinc-800 border border-zinc-700 rounded-md text-sm text-zinc-100 px-2 py-1 w-20"
            />
          </label>
        ))}

        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Lots
          <input
            type="number"
            min={1}
            step={1}
            value={lots}
            onChange={(e) => onLotsChange(Math.max(1, Number(e.target.value)))}
            className="bg-zinc-800 border border-zinc-700 rounded-md text-sm text-zinc-100 px-2 py-1 w-20"
          />
        </label>

        <div className="flex flex-col gap-1 text-xs text-zinc-400">
          Mode
          <div className="flex rounded-md overflow-hidden border border-zinc-700">
            {(['intraday', 'positional'] as const).map((m) => (
              <button
                key={m}
                onClick={() => onModeChange(m)}
                className={`px-3 py-1 text-xs font-medium capitalize ${
                  mode === m ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={onAnalyze}
          className="px-4 py-1.5 bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Analyze
        </button>

        {mode === 'positional' && (
          <button
            onClick={onSave}
            disabled={!canSave}
            className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            Save Strategy
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the NavBar entry**

In `rs_dashboard/components/NavBar.tsx`, find the `Derivatives` group's `links` array (confirmed at lines 39-47) and add one entry after the `/strangle-analysis` line:

```ts
      { href: '/strangle-analysis', label: 'Strangle Analysis', desc: 'OTM strangle premium patterns by offset, weekday, DTE & regime' },
      { href: '/strategy-builder', label: 'Strategy Builder', desc: 'Build & track multi-leg NIFTY options strategies' },
```

- [ ] **Step 5: Verify the page loads (component wiring completes in Task 9 — for now, confirm no build errors)**

```bash
cd rs_dashboard
npx tsc --noEmit
```
Expected: no new type errors introduced by these files (there will still be an error that `StrategyBuilder` doesn't exist yet — that's expected until Task 9; if so, confirm the error is ONLY the missing `@/components/StrategyBuilder` module and not a type error inside the files created in this task).

- [ ] **Step 6: Commit**

```bash
git add rs_dashboard/app/strategy-builder/page.tsx rs_dashboard/components/strategy/StrategyCardGrid.tsx rs_dashboard/components/strategy/StrategySettingsPanel.tsx rs_dashboard/components/NavBar.tsx
git commit -m "feat(strategy-builder): add page shell, nav entry, card grid and settings panel"
```

---

### Task 7: Payoff Diagram Component

**Files:**
- Create: `rs_dashboard/components/strategy/PayoffDiagram.tsx`

**Interfaces:**
- Consumes: `{ spot: number; pnl: number }[]` curves from `buildPayoffCurve`/`buildTargetPayoffCurve` (Task 4), `breakevens: number[]`.
- Produces (consumed by Task 9):
  ```ts
  interface PayoffDiagramProps {
    curve: { spot: number; pnl: number }[];
    currentSpot: number;
    breakevens: number[];
  }
  ```

- [ ] **Step 1: Write the component**

Create `rs_dashboard/components/strategy/PayoffDiagram.tsx`:

```tsx
'use client';

import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts';

interface PayoffDiagramProps {
  curve: { spot: number; pnl: number }[];
  currentSpot: number;
  breakevens: number[];
}

function PayoffTooltip({ active, payload }: { active?: boolean; payload?: { value: number; payload: { spot: number; pnl: number } }[] }) {
  if (!active || !payload?.length) return null;
  const { spot, pnl } = payload[0].payload;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs shadow-lg">
      <div className="text-zinc-300 font-semibold mb-1">Spot: {spot.toFixed(0)}</div>
      <div className={pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
        P&amp;L: {pnl >= 0 ? '+' : ''}{pnl.toFixed(0)}
      </div>
    </div>
  );
}

export default function PayoffDiagram({ curve, currentSpot, breakevens }: PayoffDiagramProps) {
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={curve} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="pnlPositive" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="pnlNegative" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#f43f5e" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
          <XAxis
            dataKey="spot" type="number" domain={['dataMin', 'dataMax']}
            tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false}
            tickFormatter={(v: number) => v.toFixed(0)}
          />
          <YAxis tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
          <Tooltip content={<PayoffTooltip />} />
          <ReferenceLine y={0} stroke="#71717a" />
          <ReferenceLine x={currentSpot} stroke="#0ea5e9" strokeDasharray="4 3"
            label={{ value: 'Spot', fill: '#0ea5e9', fontSize: 10, position: 'insideTopRight' }} />
          {breakevens.map((be) => (
            <ReferenceLine key={be} x={be} stroke="#f59e0b" strokeDasharray="3 3"
              label={{ value: be.toFixed(0), fill: '#f59e0b', fontSize: 9, position: 'insideBottom' }} />
          ))}
          <Area type="linear" dataKey="pnl" stroke="none" fill="url(#pnlPositive)" baseValue={0} isAnimationActive={false} />
          <Line type="linear" dataKey="pnl" stroke="#e4e4e7" strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2: Verify types compile**

```bash
cd rs_dashboard
npx tsc --noEmit
```
Expected: no new errors from `PayoffDiagram.tsx` (the pre-existing missing-`StrategyBuilder` error from Task 6 is still expected).

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/strategy/PayoffDiagram.tsx
git commit -m "feat(strategy-builder): add payoff diagram chart component"
```

---

### Task 8: Strategy Summary Panel Component

**Files:**
- Create: `rs_dashboard/components/strategy/StrategySummaryPanel.tsx`

**Interfaces:**
- Consumes: `PayoffStats` (Task 4), a margin data shape `{ total_margin: number; hedge_benefit: number; available_funds: number } | null` (loading state), current spot, lot size.
- Produces (consumed by Task 9):
  ```ts
  interface StrategySummaryPanelProps {
    stats: PayoffStats;
    targetBreakevens: number[] | null; // null while not yet computed
    breakevenMode: 'target' | 'expiry';
    onBreakevenModeChange: (m: 'target' | 'expiry') => void;
    margin: { total_margin: number; hedge_benefit: number; available_funds: number } | null;
    marginLoading: boolean;
    spot: number;
  }
  ```

- [ ] **Step 1: Write the component**

Create `rs_dashboard/components/strategy/StrategySummaryPanel.tsx`:

```tsx
'use client';

import { PayoffStats } from '@/lib/optionsStrategy';

interface StrategySummaryPanelProps {
  stats: PayoffStats;
  targetBreakevens: number[] | null;
  breakevenMode: 'target' | 'expiry';
  onBreakevenModeChange: (m: 'target' | 'expiry') => void;
  margin: { total_margin: number; hedge_benefit: number; available_funds: number } | null;
  marginLoading: boolean;
  spot: number;
}

function fmtRupee(n: number): string {
  return `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number, spot: number): string {
  return `${((n - spot) / spot * 100).toFixed(1)}%`;
}

export default function StrategySummaryPanel({
  stats, targetBreakevens, breakevenMode, onBreakevenModeChange, margin, marginLoading, spot,
}: StrategySummaryPanelProps) {
  const breakevens = breakevenMode === 'expiry' ? stats.breakevensExpiry : (targetBreakevens ?? []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
        <div className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Max Profit</div>
        <div className="text-xl font-bold text-emerald-400 tabular-nums">
          {stats.maxProfit === 'Unlimited' ? 'Unlimited' : `+${fmtRupee(stats.maxProfit)}`}
        </div>
        <div className="text-xs text-zinc-500 uppercase tracking-wide mt-3 mb-1">Max Loss</div>
        <div className="text-xl font-bold text-rose-400 tabular-nums">
          {stats.maxLoss === 'Unlimited' ? 'Unlimited' : fmtRupee(stats.maxLoss)}
        </div>
      </div>

      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-zinc-500 uppercase tracking-wide">Breakeven</span>
          <div className="flex rounded-md overflow-hidden border border-zinc-700 text-[10px]">
            {(['target', 'expiry'] as const).map((m) => (
              <button
                key={m}
                onClick={() => onBreakevenModeChange(m)}
                className={`px-2 py-0.5 font-medium capitalize ${
                  breakevenMode === m ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        {breakevenMode === 'target' && targetBreakevens === null ? (
          <div className="text-sm text-zinc-500">—</div>
        ) : breakevens.length === 0 ? (
          <div className="text-sm text-zinc-500">None</div>
        ) : (
          <div className="space-y-1">
            {breakevens.map((be) => (
              <div key={be} className="text-sm text-zinc-200 tabular-nums">
                {be.toFixed(0)} <span className="text-zinc-500">({fmtPct(be, spot)})</span>
              </div>
            ))}
          </div>
        )}
        <div className="text-xs text-zinc-500 uppercase tracking-wide mt-3 mb-1">Reward / Risk</div>
        <div className="text-sm text-zinc-200 tabular-nums">
          {stats.rewardRisk === null ? 'NA' : `1/${(1 / stats.rewardRisk).toFixed(1)}`}
        </div>
        <div className="text-xs text-zinc-500 uppercase tracking-wide mt-3 mb-1">POP</div>
        <div className="text-sm text-zinc-200 tabular-nums">{stats.popPct === null ? '—' : `${stats.popPct}%`}</div>
        <div className="text-xs text-zinc-500 uppercase tracking-wide mt-3 mb-1">Time Value</div>
        <div className="text-sm text-zinc-200 tabular-nums">{fmtRupee(stats.timeValue)}</div>
        <div className="text-xs text-zinc-500 uppercase tracking-wide mt-3 mb-1">Intrinsic Value</div>
        <div className="text-sm text-zinc-200 tabular-nums">{fmtRupee(stats.intrinsicValue)}</div>
      </div>

      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
        <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Funds &amp; Margins</div>
        {marginLoading ? (
          <div className="text-sm text-zinc-500 animate-pulse">Loading…</div>
        ) : margin === null ? (
          <div className="text-sm text-zinc-500">—</div>
        ) : (
          <div className="space-y-2">
            <div>
              <div className="text-xs text-zinc-500">Standalone Funds</div>
              <div className="text-sm text-zinc-200 tabular-nums">{fmtRupee(margin.total_margin + margin.hedge_benefit)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Margin Needed</div>
              <div className="text-sm text-zinc-200 tabular-nums">{fmtRupee(margin.total_margin)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Margin Available</div>
              <div className="text-sm text-zinc-200 tabular-nums">{fmtRupee(margin.available_funds)}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify types compile**

```bash
cd rs_dashboard
npx tsc --noEmit
```
Expected: no new errors from `StrategySummaryPanel.tsx`.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/strategy/StrategySummaryPanel.tsx
git commit -m "feat(strategy-builder): add strategy summary panel (P/L, breakeven, POP, margin)"
```

---

### Task 9: StrategyBuilder Main Orchestrator

**Files:**
- Create: `rs_dashboard/components/StrategyBuilder.tsx`

**Interfaces:**
- Consumes: everything from Tasks 3, 4, 6, 7, 8; existing `/api/options/expiries`, `/api/options/chain`, `/api/options/spot` routes; new `/api/options/margin`, `/api/saved-strategies` routes (Task 5).
- Produces: the default export rendered by `app/strategy-builder/page.tsx` (Task 6).

- [ ] **Step 1: Write the component**

Create `rs_dashboard/components/StrategyBuilder.tsx`:

```tsx
'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import NavBar from '@/components/NavBar';
import StrategyCardGrid from '@/components/strategy/StrategyCardGrid';
import StrategySettingsPanel from '@/components/strategy/StrategySettingsPanel';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';
import StrategySummaryPanel from '@/components/strategy/StrategySummaryPanel';
import SavedStrategiesTab from '@/components/strategy/SavedStrategiesTab';
import {
  STRATEGY_TEMPLATES, getTemplate, defaultParams, classifyExpiries, computeAtm,
  resolveLegs, computePayoffStats, buildPayoffCurve, buildTargetPayoffCurve, findBreakevens,
  ChainOc, ResolvedLeg, PayoffStats,
} from '@/lib/optionsStrategy';

const UNDERLYING = 'NIFTY';
const LOT_SIZE = 75;

type MarginData = { total_margin: number; hedge_benefit: number; available_funds: number };

export default function StrategyBuilder() {
  const [activeTab, setActiveTab] = useState<'builder' | 'saved'>('builder');

  const [expiries, setExpiries] = useState<{ date: string; kind: 'weekly' | 'monthly' }[]>([]);
  const [expiryKindFilter, setExpiryKindFilter] = useState<'weekly' | 'monthly' | 'all'>('all');
  const [selectedExpiry, setSelectedExpiry] = useState('');

  const [spot, setSpot] = useState(0);
  const [chainOc, setChainOc] = useState<ChainOc>({});

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, number>>({});
  const [lots, setLots] = useState(1);
  const [mode, setMode] = useState<'intraday' | 'positional'>('intraday');

  const [resolvedLegs, setResolvedLegs] = useState<ResolvedLeg[] | null>(null);
  const [missingStrikes, setMissingStrikes] = useState<number[]>([]);
  const [stats, setStats] = useState<PayoffStats | null>(null);
  const [curve, setCurve] = useState<{ spot: number; pnl: number }[]>([]);
  const [breakevenMode, setBreakevenMode] = useState<'target' | 'expiry'>('expiry');
  const [targetBreakevens, setTargetBreakevens] = useState<number[] | null>(null);

  const [margin, setMargin] = useState<MarginData | null>(null);
  const [marginLoading, setMarginLoading] = useState(false);

  const selectedTemplate = selectedId ? getTemplate(selectedId) : undefined;

  // Fetch expiries once on mount
  useEffect(() => {
    fetch(`/api/options/expiries?underlying=${UNDERLYING}`)
      .then((r) => r.json())
      .then((json) => {
        const dates: string[] = json?.data ?? [];
        const classified = classifyExpiries(dates);
        setExpiries(classified);
        if (classified.length > 0) setSelectedExpiry(classified[0].date);
      })
      .catch(() => {});
  }, []);

  // Fetch chain + spot whenever the expiry changes
  useEffect(() => {
    if (!selectedExpiry) return;
    fetch(`/api/options/spot?underlying=${UNDERLYING}`).then((r) => r.json()).then((json) => setSpot(json?.spot ?? 0)).catch(() => {});
    fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${selectedExpiry}`)
      .then((r) => r.json())
      .then((json) => setChainOc(json?.data?.chain?.oc ?? {}))
      .catch(() => {});
  }, [selectedExpiry]);

  const handleSelectStrategy = useCallback((id: string) => {
    setSelectedId(id);
    const t = getTemplate(id);
    if (t) setParams(defaultParams(t));
    setResolvedLegs(null);
    setStats(null);
    setMargin(null);
    setTargetBreakevens(null);
  }, []);

  const handleAnalyze = useCallback(() => {
    if (!selectedTemplate) return;
    const atm = computeAtm(spot);
    const specs = selectedTemplate.legs(params);
    const { legs, missingStrikes: missing } = resolveLegs(specs, atm, lots, chainOc);
    setMissingStrikes(missing);
    if (missing.length > 0) {
      setResolvedLegs(null);
      setStats(null);
      return;
    }
    setResolvedLegs(legs);
    const payoffStats = computePayoffStats(legs, spot, LOT_SIZE);
    setStats(payoffStats);
    setCurve(buildPayoffCurve(legs, spot, LOT_SIZE));
    setTargetBreakevens(null); // recomputed lazily below when breakevenMode === 'target'

    setMarginLoading(true);
    fetch('/api/options/margin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        underlying: UNDERLYING,
        expiry: selectedExpiry,
        legs: legs.map((l) => ({ strike: l.strike, type: l.type, side: l.side, qtyLots: l.qtyLots, price: l.price })),
      }),
    })
      .then((r) => r.json())
      .then((json) => setMargin(json?.success ? json.data : null))
      .catch(() => setMargin(null))
      .finally(() => setMarginLoading(false));
  }, [selectedTemplate, params, lots, spot, chainOc, selectedExpiry]);

  // Recompute target breakevens on demand when the toggle is switched to 'target'
  useEffect(() => {
    if (breakevenMode !== 'target' || !resolvedLegs || targetBreakevens !== null) return;
    const expiryDate = new Date(selectedExpiry);
    const daysToExpiry = Math.max(0, Math.round((expiryDate.getTime() - Date.now()) / 86_400_000));
    const targetCurve = buildTargetPayoffCurve(resolvedLegs, spot, LOT_SIZE, daysToExpiry);
    setTargetBreakevens(findBreakevens(targetCurve));
  }, [breakevenMode, resolvedLegs, targetBreakevens, selectedExpiry, spot]);

  const handleSave = useCallback(() => {
    if (!selectedTemplate || !resolvedLegs || !stats) return;
    const payload = {
      strategy_type: selectedTemplate.id,
      display_name: selectedTemplate.name,
      underlying: UNDERLYING,
      expiry: selectedExpiry,
      mode: 'positional',
      lots,
      lot_size: LOT_SIZE,
      params,
      entry_spot: spot,
      entry_net_premium: stats.netPremium,
      legs: resolvedLegs.map((l) => ({
        strike: l.strike, option_type: l.type, side: l.side, qty_lots: l.qtyLots,
        entry_price: l.price, entry_delta: l.delta, security_id: null,
      })),
      notes: null,
    };
    fetch('/api/saved-strategies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }, [selectedTemplate, resolvedLegs, stats, selectedExpiry, lots, params, spot]);

  const displayedCurve = useMemo(() => curve, [curve]);

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-300">
      <NavBar />

      <div className="sticky top-0 z-30 bg-zinc-900 border-b border-zinc-800 px-4 py-3">
        <div className="max-w-screen-xl mx-auto flex flex-wrap items-center gap-3">
          <h1 className="text-sm font-bold text-white mr-2">Strategy Builder</h1>
          <span className="text-xs font-mono bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">NIFTY</span>
          <span className="text-xs font-mono bg-zinc-800 text-emerald-400 px-2 py-0.5 rounded">Spot: {spot.toFixed(1)}</span>

          <div className="ml-auto flex rounded-md overflow-hidden border border-zinc-700 text-xs">
            {(['builder', 'saved'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={`px-3 py-1 font-medium capitalize ${
                  activeTab === t ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {t === 'builder' ? 'Builder' : 'Saved Strategies'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-screen-xl mx-auto px-4 py-6 space-y-6">
        {activeTab === 'saved' ? (
          <SavedStrategiesTab />
        ) : (
          <>
            <StrategyCardGrid templates={STRATEGY_TEMPLATES} selectedId={selectedId} onSelect={handleSelectStrategy} />

            {selectedTemplate && (
              <StrategySettingsPanel
                template={selectedTemplate}
                params={params}
                onParamsChange={setParams}
                lots={lots}
                onLotsChange={setLots}
                mode={mode}
                onModeChange={setMode}
                expiryKindFilter={expiryKindFilter}
                onExpiryKindFilterChange={setExpiryKindFilter}
                expiries={expiries}
                selectedExpiry={selectedExpiry}
                onExpiryChange={setSelectedExpiry}
                onAnalyze={handleAnalyze}
                onSave={handleSave}
                canSave={mode === 'positional' && stats !== null}
              />
            )}

            {missingStrikes.length > 0 && (
              <div className="bg-rose-950 border border-rose-800 text-rose-300 text-xs rounded-lg px-4 py-2.5">
                Chain data unavailable for strike(s): {missingStrikes.join(', ')}. Try a different expiry or offsets.
              </div>
            )}

            {stats && (
              <>
                <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
                  <PayoffDiagram
                    curve={displayedCurve}
                    currentSpot={spot}
                    breakevens={breakevenMode === 'expiry' ? stats.breakevensExpiry : (targetBreakevens ?? [])}
                  />
                </div>
                <StrategySummaryPanel
                  stats={stats}
                  targetBreakevens={targetBreakevens}
                  breakevenMode={breakevenMode}
                  onBreakevenModeChange={setBreakevenMode}
                  margin={margin}
                  marginLoading={marginLoading}
                  spot={spot}
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify types compile (SavedStrategiesTab doesn't exist yet — expected, built in Task 10)**

```bash
cd rs_dashboard
npx tsc --noEmit
```
Expected: the only remaining error should be the missing `@/components/strategy/SavedStrategiesTab` module — confirm no other type errors.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/StrategyBuilder.tsx
git commit -m "feat(strategy-builder): wire up main orchestrator component"
```

---

### Task 10: Saved Strategies Tab (restore with live P&L)

**Files:**
- Create: `rs_dashboard/components/strategy/SavedStrategiesTab.tsx`

**Interfaces:**
- Consumes: `GET /api/saved-strategies`, `GET /api/saved-strategies/[id]`, `PATCH /api/saved-strategies/[id]`, `DELETE /api/saved-strategies/[id]` (Task 5), `/api/options/chain` (existing), `computePayoffStats`/`buildPayoffCurve` (Task 4).
- Produces: default export used by `StrategyBuilder.tsx` (Task 9) as `<SavedStrategiesTab />`. It takes no props: each saved strategy carries its own `underlying`/`expiry`/`lot_size` in its DB record, since the saved-strategies list can span multiple underlyings/expiries, not just the one currently selected in the Builder tab.

- [ ] **Step 1: Write the component**

Create `rs_dashboard/components/strategy/SavedStrategiesTab.tsx`:

```tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';
import { computePayoffStats, buildPayoffCurve, ResolvedLeg, PayoffStats, ChainOc } from '@/lib/optionsStrategy';

interface StrategyRow {
  id: number;
  strategy_type: string;
  display_name: string;
  underlying: string;
  expiry: string;
  mode: string;
  lots: number;
  lot_size: number;
  entry_spot: number;
  entry_net_premium: number;
  status: string;
  created_at: string;
}

interface StrategyDetail extends StrategyRow {
  legs_json: { strike: number; option_type: 'CE' | 'PE'; side: 'BUY' | 'SELL'; qty_lots: number; entry_price: number; entry_delta: number | null }[];
}

export default function SavedStrategiesTab() {
  const [rows, setRows] = useState<StrategyRow[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<StrategyDetail | null>(null);
  const [liveLegs, setLiveLegs] = useState<ResolvedLeg[] | null>(null);
  const [liveSpot, setLiveSpot] = useState(0);
  const [liveStats, setLiveStats] = useState<PayoffStats | null>(null);
  const [liveCurve, setLiveCurve] = useState<{ spot: number; pnl: number }[]>([]);

  const refreshList = useCallback(() => {
    fetch('/api/saved-strategies').then((r) => r.json()).then((json) => setRows(json?.data ?? [])).catch(() => {});
  }, []);

  useEffect(() => { refreshList(); }, [refreshList]);

  const handleOpen = useCallback((id: number) => {
    setOpenId(id);
    setDetail(null);
    setLiveLegs(null);
    setLiveStats(null);

    fetch(`/api/saved-strategies/${id}`)
      .then((r) => r.json())
      .then(async (json) => {
        if (!json?.success) return;
        const d: StrategyDetail = json.data;
        setDetail(d);

        const [spotRes, chainRes] = await Promise.all([
          fetch(`/api/options/spot?underlying=${d.underlying}`).then((r) => r.json()),
          fetch(`/api/options/chain?underlying=${d.underlying}&expiry=${d.expiry}`).then((r) => r.json()),
        ]);
        const currentSpot = spotRes?.spot ?? d.entry_spot;
        const oc: ChainOc = chainRes?.data?.chain?.oc ?? {};

        const resolved: ResolvedLeg[] = d.legs_json.map((leg) => {
          const strikeKey = String(leg.strike);
          const chainLeg = leg.option_type === 'CE' ? oc[strikeKey]?.ce : oc[strikeKey]?.pe;
          return {
            strike: leg.strike,
            type: leg.option_type,
            side: leg.side,
            qtyLots: leg.qty_lots,
            price: chainLeg?.last_price ?? leg.entry_price,
            delta: chainLeg?.greeks?.delta ?? leg.entry_delta,
            iv: chainLeg?.implied_volatility ?? null,
          };
        });

        setLiveSpot(currentSpot);
        setLiveLegs(resolved);
        setLiveStats(computePayoffStats(resolved, currentSpot, d.lot_size));
        setLiveCurve(buildPayoffCurve(resolved, currentSpot, d.lot_size));
      })
      .catch(() => {});
  }, []);

  const handleClose = useCallback((id: number) => {
    fetch(`/api/saved-strategies/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    }).then(() => refreshList());
  }, [refreshList]);

  const handleDelete = useCallback((id: number) => {
    fetch(`/api/saved-strategies/${id}`, { method: 'DELETE' }).then(() => {
      refreshList();
      if (openId === id) { setOpenId(null); setDetail(null); }
    });
  }, [refreshList, openId]);

  const currentNetPremium = liveLegs
    ? liveLegs.reduce((sum, l) => sum + (l.side === 'SELL' ? l.price : -l.price) * l.qtyLots, 0)
    : null;
  const livePnl = detail && currentNetPremium !== null
    ? (detail.entry_net_premium - currentNetPremium) * detail.lot_size
    : null;

  return (
    <div className="space-y-4">
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-zinc-900">
              {['Strategy', 'Expiry', 'Lots', 'Status', 'Created', ''].map((h) => (
                <th key={h} className="px-3 py-2 text-left text-xs font-bold text-white whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className={i % 2 === 0 ? 'bg-zinc-800' : ''}>
                <td className="px-3 py-2">
                  <button onClick={() => handleOpen(r.id)} className="text-sky-400 hover:text-sky-300">{r.display_name}</button>
                </td>
                <td className="px-3 py-2 text-zinc-300">{r.expiry}</td>
                <td className="px-3 py-2 text-zinc-300 tabular-nums">{r.lots}</td>
                <td className="px-3 py-2 text-zinc-300 capitalize">{r.status}</td>
                <td className="px-3 py-2 text-zinc-500">{r.created_at.slice(0, 10)}</td>
                <td className="px-3 py-2 text-right space-x-2">
                  {r.status === 'open' && (
                    <button onClick={() => handleClose(r.id)} className="text-amber-400 hover:text-amber-300">Close</button>
                  )}
                  <button onClick={() => handleDelete(r.id)} className="text-rose-400 hover:text-rose-300">Delete</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-zinc-500">No saved strategies yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {openId !== null && detail && liveStats && (
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-sm font-bold text-white">{detail.display_name}</span>
            <span className="text-xs text-zinc-500">Entry spot {detail.entry_spot.toFixed(0)} → Live spot {liveSpot.toFixed(0)}</span>
            {livePnl !== null && (
              <span className={`text-sm font-semibold tabular-nums ${livePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                Live P&amp;L: {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(0)}
              </span>
            )}
          </div>
          <PayoffDiagram curve={liveCurve} currentSpot={liveSpot} breakevens={liveStats.breakevensExpiry} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify the full page compiles**

```bash
cd rs_dashboard
npx tsc --noEmit
```
Expected: no type errors anywhere in the new `strategy-builder`/`strategy` files.

- [ ] **Step 3: End-to-end browser verification**

```bash
cd rs_dashboard
npm run dev
```
Navigate to `http://localhost:3000/strategy-builder` and:
1. Confirm the "Strategy Builder" nav link appears under Derivatives.
2. Click each of the 8 cards; confirm the settings panel expands with the right offset inputs per template (0 for Short Straddle, N for Strangle, N+W for Iron Condor, etc.).
3. Pick an expiry, click Analyze on Short Straddle; confirm the payoff diagram renders a peak at the current spot and Max Loss shows "Unlimited".
4. Switch to Iron Condor; confirm Max Loss is a finite number and 2 breakevens are shown.
5. Toggle Target/Expiry breakeven; confirm the numbers change (Target should differ from Expiry unless very close to expiry).
6. Toggle Weekly/Monthly/All; confirm the expiry dropdown narrows correctly.
7. Set Mode to Positional, click Analyze, then Save Strategy; confirm no console errors.
8. Switch to the "Saved Strategies" tab; confirm the just-saved strategy appears, click it, confirm live spot/premium/P&L and the payoff diagram render (this exercises the full restore + live-recompute path).
9. Confirm the Funds & Margins panel populates (or shows a clear error if no live Dhan session is available in this environment — run `venv\Scripts\python.exe login.py` first if it shows an auth error).

Stop the dev server (Ctrl+C) when done. Report any of the above that didn't work as a concern.

- [ ] **Step 4: Commit**

```bash
git add rs_dashboard/components/strategy/SavedStrategiesTab.tsx
git commit -m "feat(strategy-builder): add saved-strategies tab with live P&L restore"
```

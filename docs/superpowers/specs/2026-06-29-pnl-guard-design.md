# P&L Guard — Design Spec
**Date:** 2026-06-29  
**Feature:** Automatic P&L-based exit configuration on the Strategies+ page

---

## Overview

Add a "P&L Guard" control to the Strategies+ page that lets users configure Dhan's native P&L-based exit rules at runtime. When cumulative profit or loss thresholds are breached, the broker automatically exits all applicable positions. Users can also optionally activate the kill switch simultaneously.

This maps to three Dhan API v2 endpoints: `POST /pnlExit`, `GET /pnlExit`, `DELETE /pnlExit`.

---

## Architecture

Four layers, following the existing project pattern exactly:

```
Strategies+ UI
    ↕ fetch
Next.js API route  /api/pnl-exit  (GET / POST / DELETE)
    ↕ execFileAsync
Python tool script  scripts/tools/pnl_exit.py
    ↕ DhanHelper methods
Dhan API v2  /pnlExit
```

---

## 1. Python — `lib/dhan_helper.py`

Add three methods to the existing `TRADER'S CONTROL` section (after `toggle_kill_switch` / `emergency_stop`).

### `get_pnl_exit() -> dict | None`

```
dhan_http.get('/pnlExit')
```

Returns the raw `data` dict on success (`{ pnlExitStatus, profit, loss, productType, enableKillSwitch }`), or `None` on failure.

### `set_pnl_exit(profit_value: float, loss_value: float, product_types: list[str], enable_kill_switch: bool) -> bool`

```
dhan_http.post('/pnlExit', {
    "profitValue": profit_value,
    "lossValue": loss_value,
    "productType": product_types,       # e.g. ["INTRADAY"] or ["INTRADAY", "DELIVERY"]
    "enableKillSwitch": enable_kill_switch
})
```

Returns `True` on success, `False` on failure.

### `delete_pnl_exit() -> bool`

```
dhan_http.delete('/pnlExit')
```

Returns `True` on success, `False` on failure.

**Error handling:** All three use `dhan_http = getattr(self.dhan, 'dhan_http', None)`, guard against `None`, log via `logger.error`, and never raise.

---

## 2. Python Tool Script — `scripts/tools/pnl_exit.py`

CLI arguments:

| Arg | Values | Required for |
|-----|--------|-------------|
| `--action` | `get` / `set` / `delete` | always |
| `--profit` | float | `set` |
| `--loss` | float | `set` |
| `--product-types` | space-separated: `INTRADAY` `DELIVERY` | `set` |
| `--kill-switch` | `true` / `false` | `set` |

Prints a single JSON line to stdout (same convention as `get_portfolio_pnl.py`, `exit_all_positions.py`). On success for `get`:

```json
{"success": true, "data": {"pnlExitStatus": "ACTIVE", "profit": 5000.0, "loss": 3000.0, "productType": ["INTRADAY"], "enableKillSwitch": false}}
```

On success for `set` / `delete`:

```json
{"success": true}
```

On failure:

```json
{"success": false, "error": "...message..."}
```

---

## 3. Next.js API Route — `rs_dashboard/app/api/pnl-exit/route.ts`

Three handlers in one file:

- **`GET`** → spawn `pnl_exit.py --action get` → return parsed JSON
- **`POST`** → read `{ profitValue, lossValue, productTypes, enableKillSwitch }` from body → spawn `pnl_exit.py --action set ...` → return `{ success }`
- **`DELETE`** → spawn `pnl_exit.py --action delete` → return `{ success }`

Uses `execFileAsync` with 15 s timeout. Follows the last-JSON-line parse pattern. Returns HTTP 500 on spawn failure.

---

## 4. UI — `rs_dashboard/app/strategies-plus/page.tsx`

### Control bar addition

Add a **P&L Guard** button between the P&L metrics area and the Stop All / Exit All buttons in the stats bar. The button shows:

- A colored dot: **emerald** when a P&L exit is ACTIVE, **zinc/gray** when INACTIVE or unknown
- Label: `P&L Guard`
- A small chevron that rotates when the panel is open

Clicking toggles `showPnlGuard` state (boolean).

### Expansion panel

Renders below the control bar when `showPnlGuard` is true. Same styling as the bar: `border-b border-zinc-900 bg-zinc-950/60 px-4 py-3`.

**Layout (single row on wide screens, wraps on narrow):**

```
[Status chip]  [₹ Profit target ____]  [₹ Loss limit ____]  [INTRADAY] [DELIVERY]  [Kill switch toggle]  [Set]  [Clear]
```

**Status chip:** `ACTIVE ₹5,000 profit / ₹3,000 loss` in emerald, or `INACTIVE` in zinc. Fetched on panel open via `GET /api/pnl-exit`.

**Profit target input:** Number field, `₹` label, placeholder `e.g. 5000`. Required for Set.

**Loss limit input:** Number field, `₹` label, placeholder `e.g. 3000`. Displayed as a positive number; sent as-is to the API (the API interprets it as a loss magnitude).

**Product type pills:** Two pill-toggle buttons `INTRADAY` (pre-selected) and `DELIVERY`. At least one must be selected. Clicking a selected pill deselects it (unless it's the only one selected).

**Kill switch toggle:** Checkbox/toggle labeled "Activate kill switch on trigger". Default off.

**Set button:** Emerald. Validates that at least one product type is selected and at least one of profit/loss is non-zero. Calls `POST /api/pnl-exit`, shows toast, refreshes status chip.

**Clear button:** Red-tinted. Uses the same two-click confirm pattern as Stop All / Exit All (first click shows "Confirm Clear?", auto-resets after 3 s). On confirm calls `DELETE /api/pnl-exit`, shows toast, refreshes status chip.

### State

```typescript
const [showPnlGuard, setShowPnlGuard] = useState(false);
const [pnlGuardStatus, setPnlGuardStatus] = useState<PnlGuardStatus | null>(null);
const [pnlGuardLoading, setPnlGuardLoading] = useState(false);
const [profitValue, setProfitValue] = useState('');
const [lossValue, setLossValue] = useState('');
const [productTypes, setProductTypes] = useState<string[]>(['INTRADAY']);
const [enableKillSwitch, setEnableKillSwitch] = useState(false);
const [confirmClear, setConfirmClear] = useState(false);
const [settingPnl, setSettingPnl] = useState(false);
const [clearingPnl, setClearingPnl] = useState(false);
```

`PnlGuardStatus` type:

```typescript
interface PnlGuardStatus {
  pnlExitStatus: 'ACTIVE' | 'INACTIVE' | string;
  profit?: number;
  loss?: number;
  productType?: string[];
  enableKillSwitch?: boolean;
}
```

### Data flow

- `fetchPnlGuardStatus()` called when panel opens (`showPnlGuard` becomes true via `useEffect`)
- After Set: call `fetchPnlGuardStatus()` to refresh chip
- After Clear confirm: call `fetchPnlGuardStatus()` to refresh chip
- No background polling — P&L exit is a broker-side configuration that doesn't change unless the user changes it

---

## Error Handling

- If `GET /api/pnl-exit` fails (token expired, network), the status chip shows `—` and a warning toast fires
- If Set/Clear fails, an error toast fires; the panel stays open with inputs intact
- Validation before Set: profit or loss must be > 0; product types must be non-empty

---

## Non-Goals

- No live P&L progress bar vs threshold (the broker handles exit autonomously; current P&L is already shown in the existing metrics bar)
- No per-strategy P&L exit (Dhan's API is account-level)
- No persistence across days (Dhan's P&L exit is day-session scoped)

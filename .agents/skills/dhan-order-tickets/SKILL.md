---
name: dhan-order-tickets
description: >-
  Use when designing, building, or reviewing order tickets, execution modals,
  and trade-dispatching API routes or Python bridges (Futures, Options, Equities,
  Commodities). Covers server-side lot/size caps, multi-segment contract
  resolution (MCX/BSE/NSE), commit-on-blur input protection, out-of-order fetch
  guards, margin estimation differences, and position identity preservation.
---

# Dhan Order Tickets & Trade Bridges

## Overview

Any UI component or API route that places real orders, estimates required margin, or resolves derivative contracts is a **high-risk surface**. Errors here directly risk capital loss, rejected orders, or broken account state.

This skill establishes the mandatory invariants and patterns discovered during the implementation and review of the Futures Order Desk, Scalper tickets, and multi-asset trade dialogs.

---

## When to Use

- Building or modifying order modals, tickets, or execution desks (`*OrderModal.tsx`, `*ActionDesk.tsx`, quick-trade panels).
- Creating or editing trade execution API routes (`app/api/*/order/route.ts`, quiktrade endpoints).
- Working on Python bridge CLI tools (`scripts/tools/*_api.py`, `scripts/tools/quiktrade.py`, etc.).
- Adding or resolving derivative contracts across multiple exchanges (`NSE`, `BSE`, `MCX`).
- Reviewing margin calculation or turnover estimation logic.

---

## The 6 Mandatory Invariants

### 1. Server-Side Hard Cap on Order Sizing
**Never rely solely on frontend HTML attributes (`max="50"`) or UI steppers.**

Frontend validation can be bypassed by direct HTTP POST, script calls, or compromised client state. A missing server-side check allows catastrophic orders (e.g., `lots: 9999` resulting in hundreds of crores in exposure).

- **In the Next.js API route (`route.ts`)**:
  ```typescript
  const MAX_LOTS_PER_ORDER = 50; // Set appropriate hard ceiling

  const lotsRaw = parseInt(String(lots), 10) || 0;
  if (lotsRaw <= 0) {
    return NextResponse.json({ success: false, error: 'Lots must be a positive integer' }, { status: 400 });
  }
  if (lotsRaw > MAX_LOTS_PER_ORDER) {
    return NextResponse.json(
      { success: false, error: `Order exceeds max allowed lots (${MAX_LOTS_PER_ORDER}). Please split the order.` },
      { status: 400 }
    );
  }
  ```

- **In Python execution scripts (`*_api.py`)**:
  Reject invalid lot quantities explicitly with an error message instead of silently clamping with `max(1, lots)`:
  ```python
  if args.lots <= 0:
      print(json.dumps({'success': False, 'error': f'Invalid lots value: {args.lots}. Must be >= 1.'}))
      sys.exit(0)
  ```

---

### 2. Multi-Segment & Exchange Contract Resolution
Symbol resolution must never assume that all non-index contracts are NSE stock derivatives (`NSE_FNO / FUTSTK`).

- **Commodities (`MCX`)**: Contracts like `CRUDEOIL`, `GOLD`, `SILVER`, `NATURALGAS`, `COPPER`, `ZINC` belong to `MCX / FUTCOM / MCX_COMM`. If allowed to fall through to `NSE / FUTSTK`, master list lookups silently fail.
- **BSE Derivatives**: `SENSEX` and `BANKEX` contracts belong to `BSE / FUTIDX / BSE_FNO`.
- **Next-Gen Indices**: Ensure secondary indices like `NIFTYNXT50` and `MIDCPNIFTY` are explicitly registered in `NSE_INDEX_SYMBOLS`.

**Standard Resolution Pattern:**
```python
NSE_INDEX_SYMBOLS = {'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50'}
BSE_INDEX_SYMBOLS = {'SENSEX', 'BANKEX'}
MCX_COMMODITY_SYMBOLS = {
    'CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI',
    'GOLD', 'GOLDMINI', 'SILVER', 'SILVERMINI',
    'COPPER', 'ALUMINIUM', 'ZINC', 'LEAD', 'NICKEL'
}

def resolve_instrument_and_exchange(underlying: str):
    under = underlying.upper()
    if under in MCX_COMMODITY_SYMBOLS:
        return 'MCX', 'FUTCOM', 'MCX_COMM'
    if under in BSE_INDEX_SYMBOLS:
        return 'BSE', 'FUTIDX', 'BSE_FNO'
    if under in NSE_INDEX_SYMBOLS:
        return 'NSE', 'FUTIDX', 'NSE_FNO'
    return 'NSE', 'FUTSTK', 'NSE_FNO'
```

---

### 3. Segment-Aware Margin Estimation
Different exchange segments and asset classes have radically different SPAN/exposure margin requirements. Never apply a blanket index/stock margin rate across all instruments:

- **MCX Commodities**: Typically ~2.5% for MIS (Intraday) and ~4.0% for NRML.
- **NSE Index Futures**: ~10.0% for MIS and ~19.0% for NRML.
- **NSE Stock Futures**: ~12.0% for MIS and ~23.0% for NRML.

```typescript
const isMcx = contractData?.exchangeSegment === 'MCX_COMM';
const isStock = contractData?.instrument === 'FUTSTK';

const marginPct = isMcx
  ? (productType === 'INTRADAY' ? 0.025 : 0.04)
  : productType === 'INTRADAY'
    ? (isStock ? 0.12 : 0.10)
    : (isStock ? 0.23 : 0.19);

const estimatedMargin = contractTurnover * marginPct;
```

---

### 4. Commit-on-Blur for Typed Order Parameters
Per the `dhan-commit-on-blur` skill, free-typed input boxes that directly feed financial calculations, order size, or limit prices must **never** update committed state per keystroke.

- Immediate `onChange` clamping like `onChange={e => setLots(Math.max(1, parseInt(e.target.value) || 1))}` is an anti-pattern: clearing `"1"` to type `"25"` instantly snaps back to `"1"`.
- Use a local `draft` string state. Commit on `blur` or `Enter`. Revert on `Escape`.
- Keep discrete steppers (`+` / `−`) and lot presets (1L, 2L, 5L) immediate.

```tsx
const [lots, setLots] = useState(1);
const [lotsDraft, setLotsDraft] = useState('1');

const commitLots = (raw: string) => {
  const n = Math.max(1, parseInt(raw, 10) || 1);
  setLots(n);
  setLotsDraft(String(n));
};

<input
  type="number"
  value={lotsDraft}
  onChange={e => setLotsDraft(e.target.value)}
  onBlur={e => commitLots(e.currentTarget.value)}
  onKeyDown={e => {
    if (e.key === 'Enter') {
      commitLots((e.target as HTMLInputElement).value);
      (e.target as HTMLInputElement).blur();
    }
    if (e.key === 'Escape') setLotsDraft(String(lots));
  }}
/>
```

---

### 5. Out-of-Order Response Guard on Async Quotes
When switching symbols or clicking "Refresh" repeatedly, network latency can cause an earlier request to resolve *after* a later request. This can overwrite fresh LTP and contract details with stale data.

**Protect all contract fetch routines with a monotonic sequence ref:**
```tsx
const fetchSeqRef = useRef(0);

const fetchContract = useCallback(async (symbol: string) => {
  const seq = ++fetchSeqRef.current;
  setLoading(true);
  try {
    const res = await fetch(`/api/futures/order?symbol=${encodeURIComponent(symbol)}`);
    const json = await res.json();
    if (seq !== fetchSeqRef.current) return; // Discard stale response
    setContractData(json.data);
  } finally {
    if (seq === fetchSeqRef.current) setLoading(false);
  }
}, []);
```

---

### 6. Preserve Position Identity `(symbol, product)` in Feedback
Per the `dhan-broker-positions` skill, position identity is **always** `(symbol, product)`, not symbol alone.
- An order placed with `productType="INTRADAY"` (MIS) creates a completely separate broker position from one placed with `productType="MARGIN"` (NRML).
- Always include the booked product type in order success banners and logs so the user knows exactly which position was created or needs to be closed.

---

## Order Ticket Checklist

Before releasing any new order ticket or trade desk component:

- [ ] Is there a server-side `MAX_LOTS_PER_ORDER` check in the API route?
- [ ] Are non-positive lot quantities rejected with an error instead of silently clamped?
- [ ] Does contract resolution account for `MCX` commodities and `BSE` indices?
- [ ] Are typed `lots` and `limitPrice` fields using draft state with commit on blur/Enter?
- [ ] Are async contract fetches guarded with a monotonic sequence ref (`fetchSeqRef`)?
- [ ] Is the margin estimate adjusted for commodity vs index vs equity rates?
- [ ] Does the order confirmation feedback surface both `symbol` and `productType`?
- [ ] Does successful order placement trigger `invalidateBrokerCache()`?
- [ ] Are modal backdrops styled with `bg-oncolor-dark/70` and text themed via tokens?

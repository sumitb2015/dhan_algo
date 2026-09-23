---
name: dhan-csp-desk
description: Use when touching the cash-secured-put screener, tracker, or strike-roll flow — scripts/tools/csp_scanner.py (screening only, no orders), scripts/tools/csp_watchlist.py (real orders + reconcile), lib/cspTracked.ts (JSON store), components/CspScreener.tsx, ShiftCspModal.tsx, cspColumns.ts, CspGlossary.tsx, and the csp-scan/, csp-tracked/, csp-watchlist/ API routes. Covers the lots-not-shares OI/IV liquidity filter, the minimum-DTE expiry gate, and the three-way desync (partial fill, late fill, timed-out order) that only csp-tracked/reconcile can resolve. Real-money endpoint. Not for generic order-ticket mechanics (dhan-order-tickets) or OI/PCR analytics used elsewhere (dhan-oi-analytics).
---

# Cash-Secured-Put Desk

Three separate pieces, each with its own real-money or data-quality trap:
**scanner** (read-only screening) → **tracker** (the local ledger of what's actually sold) →
**reconcile** (the only thing that keeps the ledger honest against the broker).

## 1. Scanner (`scripts/tools/csp_scanner.py`) — screening only, no orders

`pick_expiry()` (`csp_scanner.py:218-233`, `MIN_DTE = 5`) enforces a hard 5-day-out floor and
returns an explicit failure reason (`"no expiry at least 5d out"`) rather than silently
falling back to the nearest expiry. A scan close to a weekly rollover can legitimately return
empty — that's the gate working, not a bug.

The liquidity filter (`csp_scanner.py:245-316`, defaults `--min-oi-lots 25`, `--max-iv 100`)
rejects a strike if `oi < min_oi_lots * lot_size` **or** `iv*100 > max_iv`. Both floors exist
for the same reason: a deep-OTM strike with a stale, near-zero quote back-solves to a
fabricated sky-high IV that makes the strike *look* extra-safe (high premium for the risk)
when it's actually just illiquid and unpriced. **The OI floor is in lots, not shares**
(`csp_scanner.py:290`, `min_oi_shares = min_oi_lots * lot_size`) specifically because lot size
ranges from 20 to 2,075 shares across the Nifty-500 options universe — a shares-based
constant would be two orders of magnitude wrong for some names. If you change this filter,
keep the units in lots and re-derive shares from the per-symbol lot size at filter time, never
hardcode a shares threshold.

Rate limiting: Dhan's option-chain endpoint allows roughly 1 call per 3 seconds (same
`DhanHelper` throttle documented in `dhan-oi-analytics`/`dhan_helper.py`), so a full Nifty-500
universe sweep takes on the order of 10 minutes. `csp-scan/status` polls progress; the results
table only replaces atomically on completion — there is no partial-refresh race to worry
about, but there is a long wait to account for in any UI built on top of it.

`components/CspGlossary.tsx:30` documents the 25-lot/100%-IV constants in prose for the user.
**If you change the scanner's defaults, update this string too** — it is not derived from the
Python constants, just hand-kept in sync.

## 2. Tracker (`lib/cspTracked.ts`, `ShiftCspModal.tsx`) — the local ledger

`readTracked()`/`writeTracked()` (`cspTracked.ts:42-62`) is a flat JSON read-modify-write
store of `TrackedCsp` rows (see `dhan-polling-guards` for the general JSON-store race
pattern). A row's `status: 'OPEN'` plus a `securityId` is what makes it eligible for
reconciliation — rows without a `securityId` (manually added, or pre-fill) are skipped by
`reconcile`, not auto-adopted.

`ShiftCspModal.tsx` is the strike-roll flow: closing the current short and opening a new one
at a different strike/expiry is two separate broker actions, not an atomic roll — treat it
with the same "reducing order first, then new order, and don't let the new order fire before
the roll before the old one confirms closed" discipline as any other multi-leg adjustment (see
`dhan-terminal-position-ownership` for the general shape of this problem).

## 3. Reconcile (`app/api/csp-tracked/reconcile/route.ts`) — the only source of truth sync

Three things put a tracked row out of step with the broker's real position, and **none of
them can be fixed from the original order response alone** (`reconcile/route.ts:32-37`):
an order that fills *after* its placement route already timed out, an entry that only
part-fills, and a fill that confirms later than the 25-second wait window the sell route
uses (which stores `avgPrice: 0` as a placeholder). `reconcile` is the one place that re-reads
live broker state and repairs all three:

- If the broker reports the security flat or long (`!broker.found || broker.netQty >= 0`,
  `reconcile/route.ts:70-76`), the row is **deliberately not auto-closed** — with no captured
  fill price and no exit timestamp, any P&L booked here would be invented. It's flagged with
  `reconcileNote` for a human to close or delete instead.
- `qty`/`avgPrice`/`productType` are overwritten from the broker's own figures
  (`reconcile/route.ts:78-89`) — the local values were always provisional.
- A `broker.avgPrice > 0` is what actually clears `needsReconcile`
  (`reconcile/route.ts:93`) — a broker-reported average of exactly `0` means the broker
  doesn't have a settled price either yet, so the row stays flagged rather than being marked
  resolved with a wrong zero price.
- Between building the reconcile payload and writing results back, the route **re-reads
  `readTracked()` fresh** (`reconcile/route.ts:62`) rather than reusing the snapshot it
  started with, because the broker round-trip is long enough (up to 60s timeout) for a
  concurrent sell or delete to have landed in the meantime. Any new write path into this same
  JSON store must re-read before writing for the same reason.

`csp-tracked/sync` and `csp-tracked/reconcile` are separate routes with different jobs — don't
assume one supersedes the other; check both before assuming stale-looking data is a bug rather
than an unreconciled row waiting for the next reconcile pass.

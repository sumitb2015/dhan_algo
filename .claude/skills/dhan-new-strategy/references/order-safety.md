# Order Safety Patterns

Read this before writing any code path that places, rolls or exits an order. Every rule is a bug that
shipped in this repo; the commit is named so you can read the diff.

## Contents
1. The one rule underneath all of them
2. Placing an order and getting the fill
3. Multi-leg entry (all-or-nothing)
4. Sizing an exit
5. Closing a leg and clearing it from tracking
6. Rolls (close + reopen)
7. Dry-run parity
8. Anti-pattern index

## 1. The one rule underneath all of them
**The tracked state must always equal what the broker holds, or be visibly flagged as unsure.** An
order id is not a fill; a logged error is not a handled error; a variable you set is not a position
you own. When any of those diverge and the code carries on, a leg silently drops out of P&L, exit and
state calculations, or a second position opens on top of the first.

## 2. Placing an order and getting the fill
```python
oid = self.broker.sell(strike, expiry, "CE", qty, product=PRODUCT)   # id, or None on failure
if not oid:
    ...undo what this step already did, then return...               # never fall through
```
- `helper.wait_for_fill(oid, timeout=5)` returns a **bool**. It is not a price. Booking its result as
  the entry price recorded a straddle at Rs 1 per leg and fired the SL on the first tick (`466e225`,
  rolling straddle). Fetch `helper.get_order_by_id(oid)` and read `averageTradedPrice`, then
  `avgFilledPrice`, then `price`; fall back to the pre-order LTP only if none is > 0.
- Price exits at the actual fill too, not the pre-order mark (`466e225`).
- `helper.buy/sell` default to `product="INTRADAY"`; pass the strategy's product on every call.
- Zerodha/Kotak `ExecutionBroker` returns the last order id or `None`; the Dhan path returns the
  helper's id or `None`. Treat both identically.

## 3. Multi-leg entry (all-or-nothing)
1. Resolve **all** quotes and ids first. If any is missing or <= 0, skip the tick (no orders yet).
2. Place the legs. If some succeeded and some did not, close the ones that succeeded (rollback) and
   return with tracking still flat.
3. Mark `position_open = True` as soon as any short leg is live, **not** when the whole entry ends.
   Otherwise a failed hedge phase that also fails to unwind leaves `position_open=False` with live
   legs, and the main loop enters a second straddle on top (`c51eff6`).
4. Hedged strategies: a missing hedge quote or a failed hedge order is an emergency unwind of
   everything placed so far, logged CRITICAL. "Never run unhedged" is an invariant, not a preference.
5. Only write the leg dicts and bounds into `self` in one commit block after the orders are real.
   `enter_straddle()` mutated `self` at three points and every early return left phantom legs
   (`2b6a433`). Hold ids/prices in locals until the commit.

## 4. Sizing an exit
Never `helper.get_net_quantity()`, `helper.close_position()`, `cancel_all_orders()` or
`close_all_positions()` for a routine exit. They act on the account-wide netted position, which is
shared with every other instance and strategy on that security id.
```python
qty, net = resolve_exit_qty(helper, security_id, own_qty, "BUY", logger)          # Dhan helper path
qty, net = resolve_exit_qty_broker(self.broker, strike, expiry, "CE", own_qty, "BUY", logger)
if qty > 0: place it
```
`own_qty` is what *this* instance opened (`lots * lot_size`, with `lot_size` persisted at entry so a
mid-week NSE lot change cannot desync the maths, `6f0a778`). The helper clamps to what the broker still
shows in that direction and returns 0 when the leg is already flat, which is a normal outcome, not an
error. `BUY` closes a short, `SELL` closes a long. Cost of getting this wrong: 2026-07-30, INR 4,101
across four instances (`2c874d5`).

## 5. Closing a leg and clearing it from tracking
```python
closed = False
try:
    qty, net = resolve_exit_qty_broker(...)
    if qty > 0:
        oid = self.broker.buy(...)
        closed = bool(oid) and self.helper.wait_for_fill(oid, timeout=5)     # confirm, don't assume
    else:
        closed = True                                                         # broker already flat
except Exception as e:
    logger.error(...)
if closed:
    unsubscribe; self.leg = None                                              # only now
else:
    any_still_open = True                                                     # stays tracked, retried
```
- `exit_all()` returns True only if every leg is closed. Callers (shutdown, KeyboardInterrupt, trail,
  EOD, target/SL) branch on it. A False result sets a retry status (`FLATTENING`/`UNWINDING`) and the
  next tick calls it again; it does not reset to flat.
- On Zerodha/Kotak, confirm by polling `broker.get_owned_net_qty()` for the expected post-close net
  (there is no `wait_for_fill` equivalent).
- A close that fails with a clean-looking state is worse than a crash: the process keeps trading
  against a position it thinks is flat (`6f0a778`, a naked short live and untracked).
- Never issue a buy-to-close for a leg that is already flat. It opens a real naked long
  (`466e225`, strike adjustment left `ce_id` pointing at a closed contract).

## 6. Rolls (close + reopen)
1. Close the old leg and confirm. **If it failed, return immediately**, leaving the leg and its SL
   exactly as they were; the next tick retries. Do not book P&L or sell the replacement
   (`c51eff6` would have doubled exposure with the original half untracked).
2. Only then charge `realized_pnl` (once), go flat, increment `roll_count`.
3. Open the replacement. If that fails, the strategy is flat on that side and the main loop's flat
   branch decides what happens next; it must not re-book the close (`2b6a433`).
4. Dereference optional companions (a hedge that may be `None` after an earlier failed drag) only
   after a `None` check.
5. Re-check strike inversion after every roll; violation is an emergency flatten and a 5-minute pause.
6. Check `self.status` after each side's roll: the first side may have emergency-flattened, and the
   loop must not continue into the second side (`6f0a778`).
7. Cap it: `--max-rolls`. Past the cap the side stays flat (protected by any hedge) instead of
   chasing a trend.

## 7. Dry-run parity
Paper mode replaces only the call to the broker with "log it and pretend it filled at LTP". Everything
else runs: tracking, P&L, state writes, exits, rolls. A dry run that skips the state machine proves
nothing. Keep paper and live in one code path (`if not self.dry_run:` around the order call only).

## 8. Anti-pattern index
| Smell | Consequence | Fix |
|---|---|---|
| `oid = broker.sell(); logger.error(...) ` then continue | untracked live leg | return / rollback |
| `price = helper.wait_for_fill(oid)` | Rs 1 entry, instant SL | `get_order_by_id` fill price |
| `qty = abs(helper.get_net_quantity(id))` | flattens sibling's leg | `resolve_exit_qty*` |
| `self.leg = None` before the close confirms | phantom flat, live naked leg | clear after confirm |
| Booking P&L, then early-returning before re-entry | same close re-booked every tick | flat first, book once |
| `entry_combined_pts` set once at entry | trail dead after a roll | trail on `total_pnl` |
| `sys.exit(1)` without `save_state` | dashboard shows RUNNING for a dead process | save first |
| Comparing `total_pnl` to a target that may be `None` | TypeError on first flat tick | guard `is not None` |

# Nifty Weekly Delta-Managed Short Strangle

`nifty_delta_strangle.py` — positional (multi-day carry), delta-managed NIFTY
short strangle. Distinct from every `value_imbalance/` strangle: those are
same-day entries rebalanced on premium *value* imbalance; this strategy carries
positions across a full week and rolls legs purely on absolute *delta* drift.

## Weekly cycle

```
Wed (entry, from --entry-time)  Mon-Tue (monitoring/rolling)   Tue (exit)
        |                              |                            |
        v                              v                            v
   sell 0.15-delta            roll any leg whose |delta|      buy back both legs,
   CE + PE on expiry[1]       hits >=0.35 or <0.08, on the    go IDLE until next Wed
   (skip nearest expiry)      SAME stored expiry
```

No entry is attempted before `--entry-time` (HH:MM IST, default `09:20`) on the entry
weekday, even if the market is already open — this only gates the earliest attempt; a
market-closed or no-qualifying-strike miss still retries every poll until end of day.

The traded expiry is always `helper.get_expiries("NIFTY")[1]` — the expiry
*after* the soonest one listed, roughly 13 days out at entry. The scheduled
Tuesday exit lands exactly on the date the skipped nearest expiry itself
expires, so the position always closes about a week before its own expiry.

## Strike selection

Both legs are picked **independently**: filter the chain to strikes whose
delta magnitude is `<= --entry-delta` (default 0.15), then take the strike
with the *largest* qualifying delta magnitude — i.e. closest to 0.15 from
below, not the farthest OTM strike that merely qualifies. `pick_leg()` in the
script implements this for both entry and every roll.

Two gates apply **only at Wednesday entry** (never on a mid-week roll):
- **Inversion guard**: CE strike must be strictly greater than PE strike.
- **Premium symmetry**: `min(ce_premium, pe_premium) / max(...) >=
  --premium-symmetry-min` (default 0.80). Selling a very rich strangle where
  one side dominates the credit defeats the point of a delta-symmetric
  strangle.

Either gate failing skips that week's entry attempt — no alternate-strike
search — and the strategy simply retries on the next poll (still Wednesday,
still before exit-time).

## Rolling

Checked every `--poll-interval` seconds (default 60) while a position is
open. Each leg is evaluated independently against its **current** delta on
the chain:

- `abs(delta) >= --roll-up-delta` (default 0.35): the short has run too far
  ITM — buy it back and re-sell fresh at `--entry-delta` on the same expiry.
- `abs(delta) < --roll-down-delta` (default 0.08): the short has decayed too
  far OTM to be collecting meaningful premium — same roll.

A roll does **not** re-check premium symmetry against the other leg — only
delta drives it. After a roll, the CE>PE inversion guard is re-checked
against the *other* leg's current strike; a violation triggers
`EMERGENCY_FLATTENED` — both legs are closed and the strategy goes idle for
a 5-minute cooldown before it's eligible to re-enter, per CLAUDE.md's
documented inversion-guard convention (emergency exit + 5-minute pause +
fresh cycle).

If a roll can't find a qualifying new strike (or the re-sell order fails),
that leg is left flat rather than forced into a bad strike — the next poll's
`monitor()` pass retries filling it.

## Order-close confirmation and status machine

A buy-to-close order's return value is just an order id, not proof the short
is actually gone. Every place a leg gets closed — a roll, the scheduled
Tuesday exit, or an emergency flatten — blocks on `_confirm_close()` before
treating that leg as flat: `helper.wait_for_fill()` on Dhan, or polling
`broker.get_owned_net_qty()` against the expected post-close net (not a
blind `== 0`, since another instance can share the same strike) on
Zerodha/Kotak.

If a close doesn't confirm, the leg is left exactly as tracked — never
cleared, never rolled into a new strike — and the strategy enters one of two
dedicated statuses so `monitor()`'s "leg is `None` → refill it" logic can
never run against a leg that's still stuck open:

- **`UNWINDING`**: a single naked leg left by a failed second-leg entry
  (CE sold, PE rejected). Every poll retries closing just that leg via
  `retry_unwind()`.
- **`FLATTENING`**: an `exit_all()` (scheduled exit or emergency flatten)
  that closed at least one leg but not all. Every poll retries `exit_all()`
  again until every leg confirms closed, then the strategy goes `IDLE`.

Both statuses are dead ends for `attempt_entry()` and `monitor()` — nothing
else happens while either is active, so a stuck close can't be "fixed" by
opening a fresh leg on top of it.

## Order product and exit sizing

Every leg — entry, roll, and scheduled exit — is placed with
`product="MARGIN"` explicitly. `ExecutionBroker.buy()/sell()` default to
`product="INTRADAY"`, which would auto-square-off the same day and silently
break the whole weekly-carry design; this strategy always passes `MARGIN`.

Every buy-to-close goes through `lib/strategy_risk.py::resolve_exit_qty_broker()`
(live mode) — never the broker's raw net quantity — per the repo's documented
2026-07-30 cross-instance-flattening incident. In dry-run mode there is no
real broker position to query, so the strategy trusts its own tracked
quantity instead.

## Hard SL backstop

On Dhan only, a loose resting SL-M order (`entry_premium * --hard-sl-multiple`,
default 3x) is placed per leg as a dead-man's-switch — meant to protect
against the process dying or being unable to poll delta in time, not as a
normal exit path. It is cancelled and replaced on every roll. Zerodha/Kotak
have no resting stop-loss (software-managed only per
`lib/execution_broker.py`); for those brokers `--poll-interval` is the only
protection, and the strategy logs a startup warning to that effect.

## State / restart safety

`debug/<state_key>_portfolio.json` is the source of truth for an open
position (expiry, strikes, lots, entry premiums/deltas, SL order ids, roll
counts) — loaded before the main loop starts. A restart with an open position
resumes straight into monitoring; it never re-enters blindly. If the file
exists but is unreadable, the strategy refuses to start rather than risk a
double-entry. On a live restart with an open position, reloaded legs are
cross-checked (diagnostic only) against `broker.get_owned_net_qty()`; a
mismatch requires `--force-reconcile` to proceed.

`debug/<state_key>_state.json` is dashboard-display-only, written every loop
via `save_strategy_state()` — never trusted as position source of truth.

## CLI

See `nifty_delta_strangle.py --help` for the full flag list; all deltas,
thresholds, schedule days/time, poll interval, and sizing are configurable.
`--lots N` bypasses margin-based auto-sizing entirely.

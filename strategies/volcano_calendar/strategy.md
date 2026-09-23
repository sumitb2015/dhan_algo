# Nifty Volcano Calendar

`strategies/volcano_calendar/nifty_volcano_calendar.py`

> **UNVALIDATED — dry-run only in v1.** Sourced from a Lemonn/Kundan Prajapati video (2026-08-18) plus
> a presenter deck slide and an independently-run StockMock (`stockmock.in`) simulator screenshot
> supplied 2026-09-22. There is no backtest (the options DB is weekly-expiry-only, this is a monthly
> hold) and no losing-month example anywhere in the evidence — see the vault page
> `wiki/strategies/volcano-calendar.md` (stage `analysed`) for the full research trail, including
> unresolved gaps this file inherits. `--live` requires `--i-understand-this-is-unvalidated`.

---

## 1. Why / edge hypothesis

A "zero adjustment" monthly income structure combining a **Put Butterfly** (defined-risk downside)
with a **Call Calendar** (upside, financed by selling near-month theta against a longer-dated long
call at the same strike). The claimed edge is a wide, roughly symmetric no-action zone each month,
reached via a flat 2%/2% target-stop on the whole combo. The source shows 3 non-adverse monthly
walkthroughs and no theory of *why* this reliably nets premium — mark the edge itself unconfirmed.
A StockMock screenshot (spot 24049, entry example) corroborates real premiums/margin for one snapshot
but is not a stress case and not a multi-month track record.

## 2. Instruments and product

- Underlying: **NIFTY** index options only (v1; no other underlying).
- Product: **MARGIN** (carry-forward) — this is a monthly hold, never `INTRADAY`.
- Expiry: current monthly expiry for 4 of 5 legs; the Call Calendar's long leg sits on a **further**
  monthly expiry, chosen by `--far-expiry {next-month,two-months}` (default `next-month`). The source
  slide says "MONTHLY & BI-MONTHLY" for this leg, which is genuinely ambiguous between the two — v1
  makes this an explicit, documented CLI choice instead of silently picking one.
- "Monthly expiry" is derived from `helper.get_expiries("NIFTY")` by grouping into calendar months and
  taking the last available expiry date in each month (works whether that date is a Tuesday, Wednesday
  or Thursday — no weekday is hardcoded).
- Lot size from `helper.get_lot_size("NIFTY")`, never a constant.

## 3. Entry

- **Day**: the last trading Friday of the calendar month. If that Friday is an NSE holiday
  (`helper.NSE_HOLIDAYS`), enter Thursday instead; if Thursday is also a holiday, keep walking back one
  weekday at a time (the source only documents the Friday→Thursday case explicitly).
- **Time**: `--entry-time` (default `15:16`, per the source deck), open for `--entry-window-min`
  minutes (default 4) to tolerate a slow tick/restart, then the window closes for that month.
- **One entry per calendar month.** The position file records `entry_month` (`YYYY-MM`); a restart
  inside the same month with no open position does not re-enter for that month again once the window
  has passed or a position/exit already happened this month.
- **Sizing**: `--lots` (default 1) sets the "1×" legs; the put-butterfly body leg (the sold middle
  strikes) is always **2× lots**, matching the 1×2×1 butterfly ratio — not independently configurable.
- **Strikes** (spot = current NIFTY LTP, `step` = `--strike-step` default 50):
  | Leg | Side | Qty (lots) | Strike |
  |---|---|---|---|
  | `pe_wing_far`  | BUY  | 1×  | ATM − 2×`--wing-points` (default 800 below ATM) |
  | `pe_body`      | SELL | 2×  | ATM − `--wing-points` (default 400 below ATM) |
  | `pe_atm`       | BUY  | 1×  | ATM |
  | `ce_far`       | BUY  | 1×  | ATM + `--ce-offset-points` (default 300 above ATM), **far expiry** |
  | `ce_near`      | SELL | 1×  | same strike as `ce_far`, **near (current monthly) expiry** |
  ATM is `floor(spot / step) * step` — **floor, not nearest**: the StockMock reference example (spot
  24049) bought its "ATM" put at 24000, not the nearer 24050, so this matches that empirically. At
  default settings this reproduces the reference example exactly: spot 24049 → 24000/23600/23200 PE,
  24300 CE.
- **Entry order (protective legs before short legs, per repo convention)**: buy `pe_wing_far`, buy
  `pe_atm`, buy `ce_far` — all three long legs first — then sell `pe_body` (×2), then sell `ce_near`.
  If any leg's quote is missing/zero, abort before placing anything. If any placement fails after
  earlier legs succeeded, unwind every already-placed leg (sell back longs, buy back shorts) and
  return flat; a leg that fails to unwind is tracked and retried next tick (`status=UNWINDING`), never
  silently dropped.
- No entry-quality gate beyond the quote check in v1 (no spread-width or liquidity filter).
- **Dashboard launcher caveat**: this strategy uses the generic `--lots`/`--target-profit`/`--stop-loss`
  launcher fields (no custom `StrategyCard`/`StrategyRowWide` branch was added, since the script's CLI
  matches the generic shape exactly). Those text fields default to `25%`/`25%` for every generic-branch
  strategy in the UI, which does **not** match this strategy's own `2%` CLI default — a dashboard user
  must type `2%` into both fields before Start, or accept whatever they typed. CLI users get the
  correct `2%` default automatically.

## 4. Adjustment

**None in v1**, matching the source's "zero adjustment" design. The source separately mentions a
"center-credit rebalance" (if the combo's net credit exceeds 3–4% of capital, shift the call strikes
further out) but gives no formula for how far — the presenter does it by eye. This is **deliberately
not implemented**; see Section 8.

## 5. Exit

Checked in this order, first match wins:
1. **Target**: `total_pnl >= target_rs`, where `target_rs` is `--target-profit` (default `2%`)
   resolved **once**, at entry, against the margin actually blocked for the combo
   (`helper.get_multi_leg_margin_summary()`'s `final_margin`) — **not** against entry premium value,
   because the source states the 2% target is "on deployed capital". If the margin call fails, falls
   back to a logged, documented estimate (`--fallback-margin-per-lot`, default ₹170,000/lot, the
   midpoint of the source's ₹1.5–1.8L range) and warns loudly that the real number could not be read.
2. **Stop**: `total_pnl <= stop_rs`, same margin-based resolution, `--stop-loss` (default `2%`).
3. **Near-expiry EOD**: on the current monthly expiry's trading day, flatten everything at
   `--eod-exit-time` (default `15:17`) — including the far CE leg, which still has time value left.
   v1 does not roll the far leg into a fresh combo; the whole position closes together. This follows
   the same "expiry day only" convention as `overnight_fly`/`delta_strangle`.
4. Otherwise the position holds untouched (no daily/intraday exit) until the next check.
5. A dashboard Stop request or `--max-consecutive-stops` breach (default 3, pauses further entries
   without closing an already-open position; see Section 8) can also end a cycle.

`total_pnl` sums `realized_pnl` (booked on every leg close) plus each open leg's unrealized P&L,
signed correctly per side (`(entry - ltp) * qty` for a short leg, `(ltp - entry) * qty` for a long
leg), so it stays continuous — there are no rolls in v1 to invalidate it.

## 6. Failure modes

| Failure | Tracked state |
|---|---|
| Quote missing/zero for any leg before entry | Abort silently, no orders placed, retry next tick within the entry window |
| A BUY (protective leg) fails | Unwind any earlier BUYs already filled, stay flat |
| A SELL (short leg) fails after all BUYs filled | Unwind all 3 already-bought longs (and the already-sold short if `pe_body` filled but `ce_near` fails); `status=UNWINDING` until every leg confirms closed |
| Order placed but fill never confirms | Leg stays tracked with its order id; loop keeps polling `wait_for_fill` next iteration rather than assuming a price |
| Margin call for target/stop sizing fails | Fall back to `--fallback-margin-per-lot` estimate, log `WARNING`, proceed (never blocks entry) |
| Process killed mid-position | Position file has every filled leg; restart reloads, resubscribes, reconciles against the broker (diagnostic only), refuses to start on a mismatch |
| Process killed mid-unwind | `status` was `UNWINDING`/`FLATTENING` before the crash; restart resumes closing exactly those legs |
| Corrupt position file | Refuses to start (raises), does not guess and trade blind |
| Dashboard Stop while `UNWINDING`/waiting for a fill | `check_shutdown_trigger` is checked every loop iteration; the in-flight unwind/close continues to completion (never abandons a partially-closed 5-leg position mid-way) |

## 7. Restart behaviour

- `debug/nifty_volcano_calendar_position.json` (atomic write) is the source of truth: `entry_month`,
  `near_expiry`, `far_expiry`, all 5 legs (`{id, strike, opt_type, side, avg_price, qty}` or `None`),
  `realized_pnl`, `target_rs`, `stop_rs`, `dry_run`.
- On restart with an open position: resubscribe every live leg's security id, reconcile each against
  the broker's net quantity (diagnostic only, per `resolve_exit_qty_broker`'s own warning against using
  net quantity to size an exit) — a mismatch refuses to start.
- A paper (`dry_run=true`) position file cannot be picked up by a `--live` run and vice versa; refuses
  to start on a mode mismatch.
- If no position is open and the current month's entry window has already passed (checked via
  `entry_month` in the position file, defaulting to "never entered" if the file doesn't exist), the
  strategy waits for next month's window rather than entering immediately on a late restart.

## 8. Deliberately not done in this version

- **Center-credit rebalance** (shift call strikes if credit exceeds 3–4%): no formula in the source;
  a developer must design and test this before adding it.
- **Far-leg rollover**: at near-expiry, the far CE leg closes with everything else rather than being
  carried into the next month's combo.
- **`--max-consecutive-stops`**: implemented as a documented default (3) even though neither source
  specifies a kill criterion — this is a repo-side safety addition, not a source rule; call out and
  revisit once real dry-run cycles accumulate.
- **Adverse/high-IV stress scenario**: not computed here; the only margin/payoff numbers available are
  one benign StockMock snapshot.
- **Entry-window holiday walk-back** only goes Friday→Thursday→earlier weekdays; it does not consult a
  full multi-day holiday cluster scenario beyond what `helper.NSE_HOLIDAYS` covers.
- **`--i-understand-this-is-unvalidated`** must be passed together with `--live`, matching the
  `intraday_equity` precedent for unvalidated rule sets — the whole strategy is dry-run only otherwise.

## CLI Reference

```
python strategies/volcano_calendar/nifty_volcano_calendar.py [--live --i-understand-this-is-unvalidated]
    [--lots N] [--wing-points N] [--ce-offset-points N] [--strike-step N]
    [--far-expiry {next-month,two-months}]
    [--target-profit INR|%] [--stop-loss INR|%] [--fallback-margin-per-lot INR]
    [--entry-time HH:MM] [--entry-window-min MIN] [--eod-exit-time HH:MM]
    [--max-consecutive-stops N]
    [--instance-id ID] [--broker {dhan,zerodha,kotak}]
```

Dry run by default. See `--help` for full flag documentation and defaults.

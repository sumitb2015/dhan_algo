# Strategy Broker Selector — Design Spec

**Date:** 2026-08-28
**Status:** Approved

## Problem / Goal

Every automated strategy under `strategies/` is hardcoded to Dhan: each instantiates
`DhanHelper` via `login.py:get_dhan_client()` and places every entry/exit through
`helper.buy()` / `helper.sell()` / `helper.close_position()`. Zerodha and Kotak exist
today only as (a) manual-trading brokers in the Scalper/Advanced Scalper terminals, and
(b) copy-trade *children* that mirror Dhan fills — Dhan is always the source of truth.

Add a broker selector, similar in spirit to the Scalper's, that lets a strategy run its
own trading loop and place its own orders against Kotak or Zerodha directly — no Dhan
order flow involved for that instance — while keeping Dhan as the copy-trade primary
for anyone who still wants that mode.

## Scope

- **In scope**: the 14 option-selling strategy scripts that trade NFO index options —
  `value_imbalance/*.py` (6 scripts), `spread_trend/nifty_spread_trend.py`,
  `st_oi_bearcall/nifty_st_oi_bearcall.py`, `oi_directional/nifty_oi_directional.py`,
  plus any others in those groups. A global dashboard header control to pick the
  execution broker (Dhan / Zerodha / Kotak) for the *next* strategy launched.
- **Out of scope**: `crudeoil/*` (MCX futures — different order path, already has its
  own Kotak route), `momentum_investing/nifty500_momentum.py` (CNC equity, multi-day),
  `intraday_equity/nifty50_vwap_rs.py` (not validated, dry-run only). These stay
  Dhan-only; the broker selector is disabled/greyed out for them.
- **Out of scope**: market data. LTP, candles, option chain, and indicators keep coming
  from `DhanHelper` regardless of the selected execution broker — a Kotak-only run still
  needs a valid Dhan session for data, same as the scalper's Zerodha mode still reads
  Dhan quotes.
- **Out of scope**: resting broker-side stop-loss orders on Zerodha/Kotak. Exits on those
  brokers are software-managed (the strategy loop detects the trigger and places a market
  order to close) — this is a known, documented gap relative to Dhan's
  `place_sl_market()`, not something this change closes.

## Architecture

### 1. `lib/execution_broker.py` (new)

A thin, broker-agnostic front for order placement, sitting between a strategy and
either `DhanHelper` or a `ChildBroker` (`scripts/tools/child_brokers.py`).

```python
class ExecutionBroker:
    @classmethod
    def create(cls, broker: str, helper: DhanHelper, underlying: str, log=print) -> "ExecutionBroker": ...

    def buy(self, strike: float, expiry: str, opt_type: str, qty: int, product: str) -> Optional[str]: ...
    def sell(self, strike: float, expiry: str, opt_type: str, qty: int, product: str) -> Optional[str]: ...
    def close_position(self, strike: float, expiry: str, opt_type: str, qty: int, side: str, product: str) -> Optional[str]: ...
    def get_owned_net_qty(self, strike: float, expiry: str, opt_type: str) -> int: ...
```

- `broker="dhan"` (default): resolves the Dhan tradingsymbol via the existing
  `helper.option()` / `get_security_id()` path and calls `helper.buy()` /
  `helper.sell()` / `helper.close_position()` unchanged. Zero behavior change for every
  strategy run without `--broker`.
- `broker="zerodha"` / `"kotak"`: constructs a `ChildBroker` via
  `child_brokers.create_broker(broker, log=..., underlying=underlying)`, resolves the
  leg's tradingsymbol with `resolve_symbol(strike, expiry, opt_type)`, and places through
  `place_child_order()` / closes through `close_position()`. Raises a clear error at
  construction time if `create_broker()` fails (dead/missing session) — the strategy
  should not start a trading loop it cannot execute.
- Internally keyed by `(strike, expiry, opt_type)` rather than a resolved symbol string,
  since that's the one representation both Dhan and the child brokers can turn into
  their own tradingsymbol.

### 2. Strategy changes (14 scripts)

- `templates/strategy_template.py` and each of the 14 scripts' argparse setup gains
  `--broker {dhan,zerodha,kotak}` (default `dhan`).
- Each script constructs one `ExecutionBroker` after `DhanHelper` init:
  `self.broker = ExecutionBroker.create(args.broker, self.helper, underlying="NIFTY")`.
- Every `self.helper.buy(symbol, qty, ...)` / `self.helper.sell(symbol, qty, ...)` call
  site (option-leg entries/exits only — data calls like `get_ltp`/`get_option_chain_df`
  are untouched) is replaced with the equivalent `self.broker.buy(strike, expiry,
  opt_type, qty, product)` / `self.broker.sell(...)`, using the strike/expiry/opt_type
  the strategy already resolved before it previously built the Dhan symbol string.
- `save_strategy_state()` payload gains a `"broker": args.broker` field.

### 3. Shared exit-sizing safety (`lib/strategy_risk.py`)

`resolve_exit_qty()` currently takes `(helper, security_id, own_qty, side)` and calls
`helper.get_net_quantity()`. Generalize it to take the `ExecutionBroker` instead:

```python
def resolve_exit_qty(broker: ExecutionBroker, strike, expiry, opt_type, own_qty, side, log=None):
    net_qty = broker.get_owned_net_qty(strike, expiry, opt_type)
    ...  # same clamp-to-broker-truth logic as today
```

For `broker="dhan"` this is exactly today's behavior (net qty from Dhan). For
Zerodha/Kotak it reads the `ChildBroker`'s own `positions_rows()` for that broker's
account — the same "exit only what this instance opened, clamped by broker truth"
invariant, scoped to whichever broker the instance is actually trading on. Two
instances sharing the same Kotak account and strike are protected the same way two
instances sharing a Dhan account are today.

### 4. Dashboard

- **Global header**: new `<BrokerSelector>` component (reuses `useBrokerSelector`'s
  `Broker` union and persistence pattern — localStorage, not per-session-only like the
  scalper's). Options are `Dhan | Zerodha | Kotak`, default `Dhan`. Placed in the app
  shell header so it's visible from every page, not just Strategies.
- **Launch wiring**: the Strategies page reads the currently selected broker and
  includes it in the existing launch POST to `/api/strategies`. The route:
  - Appends `--broker <name>` to the spawned `python` args only when the target script
    is one of the 14 eligible ones (a small allowlist/config map in the route, mirroring
    how `strategies/` groups are already enumerated for the launcher UI); other scripts
    ignore the selector and always launch Dhan-only.
  - When `broker != 'dhan'`, calls the corresponding `ChildBroker.verify_session()`
    (via a small Python one-shot invoked through `runPythonJson()`, same pattern as
    other pre-flight checks) before spawning, and refuses to start with a clear error
    toast if the session is dead — instead of spawning a process whose first order
    attempt fails.
  - Broker selector in the UI is disabled (with a tooltip) for strategies not in the
    eligible set.
- **State display**: `StrategyCard` / `StrategyRowWide` read the new `broker` field from
  the strategy's state file and show a small badge (`DHAN` / `ZERODHA` / `KOTAK`) next to
  the running instance — this reflects what the instance actually launched with, not the
  header's current (possibly since-changed) selection.
- **SL caveat surfaced in UI**: when the header selector is set to Zerodha or Kotak, show
  a small persistent warning ("Stop-loss is software-managed on this broker — no resting
  broker-side stop order") near the selector, not just in docs.

### 5. Documentation

- Each affected strategy's `strategy.md` gets a short note: broker-selectable execution
  is supported, data stays Dhan-sourced, and SL/target/time exits are software-managed
  on non-Dhan brokers.
- `CLAUDE.md`'s Strategy Conventions section gets one line pointing at this capability
  and the caveat, consistent with how `resolve_exit_qty` is already called out there.

## Error handling / edge cases

- `ExecutionBroker.create()` for Zerodha/Kotak raises if `create_broker()` fails
  (expired token, missing instrument cache) — the strategy's `main()` should catch this
  at startup and exit cleanly with a logged reason, the same way a Dhan auth failure
  today prevents a strategy from starting.
- Two strategy instances trading the same underlying/strike on the same non-Dhan broker
  share one net position exactly like two Dhan instances do today — `resolve_exit_qty`
  (generalized per above) is the existing, proven mitigation, not new risk.
- If the option chain resolves a strike/expiry combination the child broker's instrument
  cache doesn't have yet (e.g. a strike added intraday), `resolve_symbol()`'s existing
  throttled refresh-on-miss (`ChildBroker.refresh_instruments`) handles it — no new logic
  needed in `ExecutionBroker`.
- A strategy already running when the header selector is changed is unaffected — the
  broker is fixed at launch time via the CLI flag baked into its spawn args, not read
  live from the header.
- `close_position` / emergency-exit paths inside each strategy (e.g. the
  CE-strike > PE-strike inversion guard) route through the same `ExecutionBroker`
  instance, so an emergency exit on Kotak/Zerodha is still software-managed but at least
  goes through the one code path instead of a separate ad hoc close call.

## Testing

- Unit-level: `ExecutionBroker` construction and method dispatch for all three broker
  values, mocking `DhanHelper` and `ChildBroker`.
- Manual, off-market-hours: launch one eligible strategy (`--broker kotak`, dry-run) and
  confirm `ExecutionBroker` resolves strikes to Kotak tradingsymbols correctly via
  `resolve_symbol()`, without placing real orders.
- Manual, market-hours, small size: one live 1-lot run each against Zerodha and Kotak,
  confirming the order appears in that broker's own order book and `resolve_exit_qty`
  clamps correctly against a pre-existing manual position on the same strike (simulate
  the netting scenario deliberately).
- Dashboard: confirm the broker selector is disabled for out-of-scope strategies,
  confirm `verify_session()` pre-flight blocks a launch with an expired Kotak/Zerodha
  token, confirm the running-instance badge reflects launch-time broker regardless of
  later header changes.
- Regression: re-run an existing Dhan-only strategy launch (no `--broker` flag reaching
  it, or `--broker dhan` explicit) and confirm behavior and state file shape are
  byte-for-byte equivalent to before this change (aside from the added `broker` field).

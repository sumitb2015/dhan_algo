# Multi-broker

Dhan is the primary account. Zerodha and Kotak are supported both as selectable
brokers in the scalper terminals and as copy-trade children that mirror Dhan
fills. Read this before touching broker-selector UI, `child_brokers.py`,
`copy_trade_bridge.py`, or any Kotak/Zerodha-specific code path — not needed
for Dhan-only work.

- **Dashboard**: `hooks/useBrokerSelector.ts` owns the `Broker` union; use `scalperRoute(broker,
  endpoint)` rather than hand-building `/api/scalper/...` paths, and `brokerRoute(broker, {…})`
  for irregular ones — it takes a **map**, because a positional pair silently routed a third
  broker to Dhan's endpoint (i.e. traded the wrong account). Dhan is the only broker with a
  numeric `securityId`; every other broker joins positions and places orders by trading symbol,
  so branch on `broker !== 'dhan'`, not on a specific broker name.
- **Bridge**: `scripts/tools/child_brokers.py` defines `ChildBroker` plus `ZerodhaChild` /
  `KotakChild`; `copy_trade_bridge.py` is broker-agnostic and drives them through that interface.
  Each broker owns its own instrument cache, margin state, position snapshot and replication
  scope. The safety invariants live in `ChildBroker` so the two cannot drift: a reducing order is
  never margin-blocked, unknown margin fails OPEN, a stale position snapshot fails OPEN, and the
  fast path (WS callback thread) never makes an HTTP call.
- **Kotak quirks** (all handled in `lib/kotak/`): auth failures and "no data" arrive as 200-OK
  bodies (`stCode 5203` = empty book, not an error); positions report no net quantity (compute it
  from the four `cf*`/`fl*` legs); strikes are ×100 scaled in the scrip master; the REST base URL
  is per-user and comes from the login response; the SDK issues every HTTP call with **no
  timeout**, so `lib.kotak.authentication.install_timeouts()` must run before any API use.
- **Kotak expiry epochs differ per segment.** `nse_fo`/`bse_fo` use a **1980-based epoch** (add 10
  calendar years). `mcx_fo` does **not** — its timestamps are a genuine epoch and must be read in
  **UTC** (Kotak stamps 23:59:59 UTC, so local parsing rolls every expiry forward a day). Applying
  the NSE rule to commodities returns 2036. Both branches live in
  `scripts/tools/kotak_instruments_cache.py`.
- **MCX quantity semantics are broker-specific and differ by 100x.** Dhan takes MCX order quantity
  in **lots** (its master reports `LOT_SIZE=1`); Kotak's `qt` is **absolute** (100 per CRUDEOIL
  lot, 10 per CRUDEOILM). Always send a position's reported `netQty` verbatim when squaring off.
  MCX options are `OPTFUT` in both masters — the equity `OPTIDX`/`OPTSTK` filter drops them.
- The startup OTM hedge (`copy_trade_hedge.py`) is **Zerodha-only** by design.
- **Strategy Broker Selector**: Option-selling strategies accept `--broker {dhan,zerodha,kotak}`.
  Market data (LTP, option chain, technical indicators, expiries) always originates from `DhanHelper`,
  while orders are routed through `ExecutionBroker.create(broker, helper, underlying)`.
  Zerodha and Kotak stop-loss exits are purely software-managed (in-memory polling/WS loops), not resting broker orders.
  Multi-instance exit safety across all brokers is managed via `resolve_exit_qty_broker()`. Pre-flight
  session checks via `scripts/tools/verify_broker_session.py` prevent launch with dead tokens.

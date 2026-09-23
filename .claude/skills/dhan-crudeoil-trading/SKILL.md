---
name: dhan-crudeoil-trading
description: Use when fetching futures or options data for MCX CRUDEOIL/CRUDEOILM, sizing an MCX order or P&L calc, or touching strategies/crudeoil/*.py, scripts/tools/crudeoil_oi_collector.py, lib/kotak/ MCX code, or the dashboard's MCX-aware code (lib/positionPnl.ts's MCX_LOT_MULTIPLIER, lib/analyticsUnderlyings.ts, lib/basketOrders.ts, lib/syntheticFuturesSegments.ts, components/CyberScalper/*). Covers the lots-vs-barrels quantity trap (the single most common source of a wrong P&L or wrong order size in this repo), the get_expiries() dead end for MCX, and Kotak's separate 100x/10x quantity scaling. Not for option-chain mechanics in general — see dhan-option-chain-analysis for that; this skill is MCX-specific on top of it.
---

# MCX CRUDEOIL / CRUDEOILM: futures, options, and lot sizing

CRUDEOIL (full-size, 100 barrels/lot) and CRUDEOILM (mini, 10 barrels/lot) are the only
MCX commodities this repo trades. Every quirk below stems from one fact: **Dhan's
`LOT_SIZE` master-list field is `1` for every MCX contract**, because Dhan's own order
quantity convention for MCX is "number of lots", not "number of barrels" — unlike
NSE/BSE F&O, where `LOT_SIZE` and order quantity are both real contract-unit counts.
Every place in this repo that touches MCX quantity has to know which of the two units
it's holding at that moment, or it silently mis-sizes an order or under/over-reports P&L
by the contract multiplier (10x or 100x).

## Contract identifiers

| | Symbol | `find_future`/`find_option` args | Order segment | Barrels/lot |
|---|---|---|---|---|
| Mini | `CRUDEOILM` | `exchange="MCX"`, `instrument="FUTCOM"` (futures) / `"OPTFUT"` (options) | `MCX_COMM` | 10 |
| Full-size | `CRUDEOIL` | same | `MCX_COMM` | 100 |

MCX options are `OPTFUT` in Dhan's and Kotak's master lists — the equity-style
`OPTIDX`/`OPTSTK` instrument filter used elsewhere in the repo silently drops them
(`docs/API_GOTCHAS.md`). All five live strategies under `strategies/crudeoil/` trade
CRUDEOILM futures only, with the constants:

```python
SYMBOL, EXCHANGE, INSTRUMENT, SEGMENT = "CRUDEOILM", "MCX", "FUTCOM", "MCX_COMM"
```

Resolve the near-month contract with `helper.find_future(SYMBOL, exchange=EXCHANGE,
instrument=INSTRUMENT)` — it already filters out expired rows before picking nearest
(`lib/dhan_helper.py:333-365`; see `docs/API_GOTCHAS.md`'s "`find_future()` and expired
contracts" for why that filter exists). Fetch LTP/quotes with `helper.get_ltp(security_id,
exchange=SEGMENT, instrument=INSTRUMENT)`.

## The lots-vs-barrels trap (read this before writing any MCX quantity code)

`helper.get_lot_size("CRUDEOILM")` returns **1**, not 10 — `get_lot_size()`
(`lib/dhan_helper.py:850-879`) only special-cases the index → F&O lookup for
`INSTRUMENT == 'INDEX'` (walks to the underlying's `OPTIDX`/`FUTIDX` row); for an MCX
`FUTCOM` row it falls straight through to `sec.get('LOT_SIZE', 1)`, which is Dhan's `1`.
**Do not call `get_lot_size()` for CRUDEOIL/CRUDEOILM** — hardcode the barrels-per-lot
contract size (10 or 100) at the call site instead, the way every strategy under
`strategies/crudeoil/` does:

```python
# strategies/crudeoil/crudeoilm_ema_supertrend.py:139-152 (the canonical pattern)
# qty      : what the broker receives. Dhan takes MCX quantity in LOTS.
# exposure : barrels actually controlled (lots x contract size), for P&L ONLY.
#            CRUDEOILM = 10 barrels/lot, CRUDEOIL = 100.
self.qty = lots
self.exposure = lots * contract_size
```

Some of the strategies additionally cross-check the master list's `LOT_SIZE` field and
only trust it if it looks sane (`> 1`), else keep the hardcoded default — see
`crudeoilm_supertrend.py:213-216`, `crudeoilm_orb.py:444-445`,
`crudeoilm_ema_supertrend.py:334-345` (the last one also logs a warning if
`--contract-size` disagrees with whatever the master list reports, since P&L is computed
off the CLI flag, not the master list).

**Conflating `qty` (lots, what you send to `place_order`) and `exposure`/barrels (what
you use for P&L) is the single most common MCX bug in this repo** — it under-reports P&L
by 10x or 100x and makes daily target/stop-loss caps effectively unreachable, because the
cap compares against a number that's 10-100x too small.

This same lots-vs-units split reappears on the **read side** (positions/P&L), independent
of the trading side above:

- `rs_dashboard/lib/positionPnl.ts:11-14` — Dhan's `/positions` endpoint also reports
  `buyQty`/`sellQty`/`netQty` **in lots** for MCX, confirmed empirically (a CRUDEOIL
  position with `buyQty=sellQty=1` and a 4-point move has a true realized P&L of ~400,
  not ~4 — 100 barrels/lot). `unrealizedProfit`/`realizedProfit` are *also* reported
  unmultiplied by Dhan for MCX (same file, `contractMultiplier()` / `scaleBrokerPnl()`)
  — recompute, don't trust the raw broker P&L field, for any MCX row.
- `MCX_LOT_MULTIPLIER = { CRUDEOIL: 100, CRUDEOILM: 10 }` (`positionPnl.ts:10-13`) is the
  one canonical source for this multiplier on the dashboard side; `lib/analyticsUnderlyings.ts`,
  `lib/multiLegFocus.ts:62`, and `lib/fifoPositions.test.ts` all key off the same two
  numbers — if you add a new MCX consumer, reuse this map rather than re-hardcoding 10/100.
- **`CRUDEOILM` is a literal prefix-superset of `CRUDEOIL`'s own root** — a naive
  `startsWith('CRUDEOIL')` root match finds CRUDEOIL's 100x multiplier first for a
  CRUDEOILM symbol and overstates P&L 10x. `lib/analyticsUnderlyings.ts:48` and
  `lib/positionLegs.ts:215-221` both order the root list longest-first
  (`['CRUDEOILM', 'CRUDEOIL']`) and guard against a false partial match — see
  `lib/fifoPositions.test.ts:30-39` for the regression test that pins this down. Copy this
  ordering discipline for any new CRUDEOIL(M)-aware string match.
- Trading-symbol spelling also differs by broker: Dhan positions carry the bare hyphenated
  root (`CRUDEOIL-17Sep2026-9000-CE`); Kotak's compact symbol for the *mini* contract is
  prefixed `CRUDEOILM` (`CRUDEOILM17AUG264150CE`), never `CRUDEOIL`
  (`lib/positionLegs.ts:125,215-221`).

## `get_expiries()` / `get_expiry_list()` do not work for MCX — resolve via the futures contract instead

`helper.get_expiries("CRUDEOIL")` resolves the symbol through `_resolve_symbol()`, which
for a commodity name lands on the spot/index-style master-list row, not the `FUTCOM` row
Dhan's expiry-list API actually needs — it returns nothing usable, with no exception
raised (`docs/API_GOTCHAS.md`, "`get_expiries()` fails silently for MCX underlyings";
`lib/dhan_helper.py:3382-3395`). Anything that depends on it (e.g. `cyber_scalper_feed.py`'s
`find_atm_options()`) ends up with a permanently empty options chain — symptom: an MCX
options order pad loads with zeroed CE/PE and no working order buttons, silently.

**Working pattern** (`scripts/tools/crudeoil_oi_collector.py:213-224`): resolve the
nearest **futures** contract first, then call `get_expiry_list()` directly with the
futures contract's own security id, not the commodity's:

```python
fut = helper.find_future("CRUDEOIL", exchange="MCX", instrument="FUTCOM")
futures_sid = int(fut["SECURITY_ID"])
expiries = helper.get_expiry_list(under_security_id=futures_sid, under_exchange_segment="MCX_COMM")
```

Once you have an expiry, `helper.get_option_chain("CRUDEOIL", expiry,
exchange_segment="MCX_COMM")` works fine passing the bare symbol — `exchange_segment`
being explicit is what matters (it skips `_auto_detect_segment`'s guess); the option-chain
endpoint tolerates the commodity-resolved security id even though the expiry-list endpoint
doesn't. Don't build an MCX options chain from `get_expiries()`/`get_nearest_expiry()` —
either treat MCX as futures-only (what every strategy under `strategies/crudeoil/` does)
or use the futures-contract-id workaround above.

On the dashboard side, `COMMODITY_SYMBOLS = new Set(['CRUDEOIL', 'CRUDEOILM'])`
(`components/CyberScalper/CyberOrderPad.tsx:41`) exists specifically to skip the options
chain for these two and force Futures mode in the order pad — this is the same root
cause, not a separate dashboard-only bug. `FUTURES_CAPABLE_SYMBOLS` in the same file
(`CyberOrderPad.tsx:33`) must include both `CRUDEOIL` and `CRUDEOILM`, and
`cyber_scalper_feed.py`'s equivalent set had a real bug where `CRUDEOIL` (full-size) was
missing — check both the Python feed and the TS pad stay in sync if you touch either.

## Kotak MCX quantity is absolute units, not lots (100x scaling trap, different from Dhan's)

Dhan and Kotak use **opposite** quantity conventions for MCX, and neither is "barrels" in
the way you'd naively guess:

- **Dhan**: order quantity is in **lots** (`get_lot_size` reports `1` for MCX, per above)
  — send `qty = lots`, not `lots * contract_size`.
- **Kotak Neo**: order quantity (`qt`) is **absolute units** — 100 per CRUDEOIL lot, 10 per
  CRUDEOILM lot (`docs/API_GOTCHAS.md`, "Kotak quirks"). Sending Dhan-style `qty = lots` to
  Kotak silently places an order 100x (or 10x) too small.

`components/CyberScalper/CyberScalperTerminal.tsx:461-462` documents the fix at the
call site: for CRUDEOILM, `params.qty = lots × 1` (Dhan) vs Kotak needing lots × 10
(absolute barrels). When squaring off an MCX position, **always send the position's
reported `netQty` verbatim** rather than recomputing a quantity from lots — the broker
already told you its own convention (`CyberScalperTerminal.tsx:668-673`: Dhan reports
`MCX_COMM` netQty in lots already, so a fixed `return 1` per-lot-step is correct there,
while Kotak's is absolute).

Kotak's MCX expiry timestamps also use a genuinely different epoch than its NSE/BSE F&O
segments — `mcx_fo` is a real UTC epoch (not the `nse_fo`/`bse_fo` 1980-based one), and
must be parsed in UTC or every MCX expiry rolls forward a day
(`scripts/tools/kotak_instruments_cache.py`; see `docs/API_GOTCHAS.md` "Kotak quirks" for
the full epoch table). Strikes are also ×100-scaled in Kotak's scrip master, same as every
other Kotak underlying — not MCX-specific, but easy to conflate with the quantity scaling
above since both are "×100" for CRUDEOIL specifically. They are unrelated numbers that
happen to share a multiplier for the full-size contract.

## Session hours and other repo-specific defaults

MCX trades a longer session than NSE equities/F&O — `scripts/tools/crudeoil_oi_collector.py`
uses `MARKET_OPEN = 09:00`, `MARKET_CLOSE = 23:30` IST (`crudeoil_oi_collector.py:47-48`),
and `crudeoilm_*.py` strategies wait for this window with a time-only check (no weekday or
MCX holiday-calendar filter — see the strategy file's `_wait_for_session()`). Don't reuse
the NSE 09:15-15:30 window or the 15:17 auto-exit hardcoded for equity-F&O strategies
(CLAUDE.md's "Strategy Conventions") when building a new MCX strategy — check the relevant
`crudeoilm_*.py` file for its own EOD time flag instead of assuming 15:17 applies.

The OI collector (`scripts/tools/crudeoil_oi_collector.py`) polls the CRUDEOIL (full-size,
not mini) option chain every 30s for ATM±10 strikes and writes a daily CSV — it's a
read-only snapshot tool, not an order-placing one; see `dhan-oi-analytics` for the
analytics consuming its output (`CrudeOilOITab.tsx`/`CrudeOilCumulativeOITab.tsx`).

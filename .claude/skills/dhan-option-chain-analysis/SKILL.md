---
name: dhan-option-chain-analysis
description: Use when fetching or analysing a Dhan option chain — helper.get_expiries/get_expiry_list/get_option_chain/get_option_chain_df/get_atm_strike/get_atm_row, resolving an underlying's chain security id (especially SENSEX or MCX, which key on a different id than their spot/index id), reading per-strike fields like previous_close_price/oi/greeks, or building a new strike-window scan or ATM/OTM picker. Covers the chain vs spot id-resolution split, the 5s cache + 3s rate-limit on option_chain(), and the flattened DataFrame column-naming convention. Not for MCX-specific quantity/lot-size issues (dhan-crudeoil-trading, layered on top of this), OI buildup/PCR/max-pain classification (dhan-oi-analytics), Greeks aggregation across a live book (dhan-position-greeks), or payoff-curve math (dhan-payoff-diagrams) — this skill is about getting a correct chain and finding strikes in it, not what you compute from it afterward.
---

# Fetching and reading a Dhan option chain

`DhanHelper` gives you two layers: `get_option_chain()` (raw dict from the Dhan API,
cached) and `get_option_chain_df(symbol, expiry, exchange_segment=None)`
(`lib/dhan_helper.py:3494-3590`, flattened to a strike-indexed `pandas.DataFrame` with
CE/PE columns and computed change-percentages). Use the DataFrame form unless you need
the raw nested dict for something the flattener drops.

## Two different security ids can be in play — resolve both correctly

An underlying's option chain does **not** always key on the same security id as its own
spot/index quote. Getting this wrong fails **silently**: an empty chain, `0.0` LTP, or
`DH-905` — never an exception you can catch.

- **NIFTY/BANKNIFTY/FINNIFTY**: chain id and spot id happen to coincide (13/25/27, both
  under `IDX_I`).
- **SENSEX**: they don't. The chain + expiry list key on security id **`1`** under
  **`BSE_FNO`**; the index's own id `51` is spot/candles-only, served under `IDX_I` —
  `BSE_IDX` returns `DH-905` for history and an empty payload for quotes. Passing the bare
  symbol `"SENSEX"` resolves through the master list to `51`, whose chain is empty
  (`docs/API_GOTCHAS.md`, "SENSEX splits three ways").
- **MCX (CRUDEOIL/CRUDEOILM)**: neither id is fixed — there's no stable "chain id" the
  way SENSEX has `1`. You must resolve the *current nearest futures contract's* security
  id each time and pass it explicitly. See `dhan-crudeoil-trading` for the full pattern;
  the one-line version is: `get_expiries()`/`get_expiry_list()` fail silently if you feed
  them the commodity's own resolved id — resolve via `find_future(..., instrument="FUTCOM")`
  first, then call `get_expiry_list(under_security_id=futures_sid, under_exchange_segment="MCX_COMM")`.

The repo's canonical fix for "chain id differs from spot id" is a small per-underlying
table, not a runtime guess — see `scripts/tools/options_data_fetch.py:37-43`
(`UNDERLYINGS`, mirrored in `options_chart_fetch.py`):

```python
UNDERLYINGS = {
    'NIFTY':     {'chain_id': 13, 'chain_seg': 'IDX_I',   'spot_id': 13, 'spot_seg': 'IDX_I'},
    'BANKNIFTY': {'chain_id': 25, 'chain_seg': 'IDX_I',   'spot_id': 25, 'spot_seg': 'IDX_I'},
    'FINNIFTY':  {'chain_id': 27, 'chain_seg': 'IDX_I',   'spot_id': 27, 'spot_seg': 'IDX_I'},
    'SENSEX':    {'chain_id': 1,  'chain_seg': 'BSE_FNO', 'spot_id': 51, 'spot_seg': 'IDX_I'},
}
```

When adding a new underlying to any chain-fetching script, add it here (or the
equivalent table in whatever script you're extending) rather than trusting
`_resolve_symbol()`'s default guess — probe-verify the (chain_id, chain_seg) pair against
the live API first if you're not sure, since a wrong pair returns an empty chain with no
error. **Beware while re-probing**: `get_option_chain()` caches 5s on `(security_id,
expiry)` (`lib/dhan_helper.py:3454-3459`), so a bad combination can look like it's
"working" off a prior call's cache entry — bust the cache (change the expiry arg, or wait
5s) before trusting a re-probe.

`get_option_chain_df()`'s own docstring (`lib/dhan_helper.py:3499-3503`) states the rule
this table encodes: leave `exchange_segment=None` to auto-resolve for the common case, but
pass it explicitly — together with a numeric-string `symbol` where the chain id differs
from the index id — for SENSEX and MCX.

## The "26000" claim in CLAUDE.md/docs does not match any working code path

CLAUDE.md, `AGENTS.md`, `docs/STRATEGY_GUIDELINES.md`, and several skills/agent files state
"NIFTY options underlying ID is 26000, not 13 (the index id)". Grepping the whole repo for
the literal `26000` turns up **zero** call sites that pass it as `under_security_id` to
`option_chain()`/`expiry_list()` — only comments repeating the claim, plus one unrelated CLI
example (`--strike 26000`). Every actual working chain/expiry call in the repo — including
`scripts/tools/options_data_fetch.py`'s `UNDERLYINGS` table above and
`tests/test_04_option_chain.py`'s exercised path — resolves NIFTY through **id `13`** under
`IDX_I`, same as the spot/index calls. If you're about to hardcode `26000` for a NIFTY chain
or expiry-list call because a doc told you to, don't — verify against a live response first;
`13` is what every working path in this codebase actually uses. (`26000` may describe some
Dhan-internal FNO scrip code that this codebase simply never calls directly — the claim isn't
necessarily false in general, just untested and unused here.)

## `find_future()`, expiry lists, and expired contracts

`find_future()` (`lib/dhan_helper.py:333-365`) sorts by `SM_EXPIRY_DATE` and explicitly
filters `SM_EXPIRY_DATE >= today` before picking nearest — Dhan's master list keeps
expired futures rows around for days after expiry, and a plain "earliest sorted row" pick
can hand back a dead contract with no live OHLC/quote data (`docs/API_GOTCHAS.md`,
"`find_future()` and expired contracts"). If you write a new chain/expiry lookup that
bypasses `find_future()`, keep this same `>= today` filter.

`get_expiry_list()` itself unwraps a **doubly-nested** response —
`res['data']['data']`, not `res['data']` (`docs/OPTION_CHAIN_QUICK_REF.md`) — the helper
already does this correctly (`lib/dhan_helper.py:2493`), but if you ever call
`dhan.expiry_list()` directly instead of through the helper, unwrap both layers.

## Rate limiting and caching on `get_option_chain()`

`lib/dhan_helper.py:3454-3466`: a 5-second cache keyed on `(security_id, expiry)`, plus a
hard 3-second minimum gap between consecutive live calls to the option-chain endpoint
(sleeps to enforce it). A loop that scans several expiries or several underlyings back to
back will serialize to one call per 3s — budget for this in any polling loop (the
CRUDEOIL OI collector, for instance, polls once per 30s specifically to stay well clear of
this floor). Don't add your own additional throttling on top of it; the helper already
owns the pacing.

## Reading fields out of the chain — naming traps

- **`previous_close_price`, not `previous_close`** — the per-strike close field is the one
  field with the `_price` suffix (`previous_oi` has no such suffix). Reading
  `previous_close` returns `None`/0 silently, which then reads as "flat / no previous
  close" everywhere downstream. This typo has been copied between scripts more than once
  (`live_options_ws.py`, `focus_tool_ws.py`) — verify the field name against a live
  response before trusting it in new code (`docs/API_GOTCHAS.md`).
- **Flattened column prefixes** (`get_option_chain_df`, `lib/dhan_helper.py:3516-3538`):
  every raw scalar field gets `ce_`/`pe_` prefixed (`ce_last_price`, `ce_oi`,
  `ce_previous_oi`, `ce_previous_close_price`, `ce_volume`, `ce_previous_volume`). The
  nested `greeks` sub-dict is the one exception — its own key does **not** get repeated:
  `ce_greeks_delta` is wrong, the actual column is `ce_delta` (any other nested dict, if
  one ever appears, *would* get `ce_{key}_{subkey}` — `greeks` is special-cased to drop its
  own name). Check the actual DataFrame columns (`df.columns.tolist()`) rather than
  guessing a name by pattern.
- **Computed change-percent columns** (`ce_price_change_pct`, `ce_oi_change_pct`,
  `ce_vol_change_pct`, and the `pe_` equivalents) are added by `get_option_chain_df()`
  itself, only when the corresponding `*_previous_*` column exists — division-by-zero is
  mapped to `0.0`, not `inf`/NaN (`lib/dhan_helper.py:3549-3567`). If a strike's previous
  value is legitimately `0` (e.g. a newly-listed far OTM strike with no prior trade), its
  change-pct reads as `0.0` — indistinguishable from "no change" at the field level. Don't
  build a signal that depends on distinguishing those two cases from this column alone;
  fall back to the raw `ce_previous_oi`/`ce_previous_close_price` value in that case.
- The DataFrame carries the underlying LTP as `df.attrs['underlying_ltp']`, sourced from
  the chain response's own `last_price` (`lib/dhan_helper.py:3583`) — not from a separate
  spot fetch. This is the chain's own reference price at fetch time, which for MCX is the
  futures price, not a spot index.

## Finding ATM / building a strike window

`helper.get_atm_strike(df, underlying_ltp=None)` and `get_atm_row(df, underlying_ltp=None)`
(`lib/dhan_helper.py:3592-3627`) pick the strike closest to `underlying_ltp` (falling back
to `df.attrs['underlying_ltp']` if not passed) via `(strikes - ltp).abs().argmin()` — note
this returns the **nearest listed strike**, not a rounded-to-step value; if the chain is
missing a strike near the true ATM (thin far-month chain, unusual step), it will pick
whatever's actually present. `select_strike(ltp, offset, step)` (`lib/dhan_helper.py:3421-3428`)
is the separate step-rounding version for when you need an arithmetic OTM/ITM strike
(`atm = round(ltp/step)*step`, then `atm + offset*step`) rather than a real strike drawn
from a fetched chain — use `get_atm_strike` when you have a DataFrame in hand and want a
strike guaranteed to exist in it, `select_strike` when you're computing a target strike
before fetching anything.

A fixed strike **window** around ATM (rather than the single ATM strike) is typically
built the way `crudeoil_oi_collector.py` does it — lock ATM from the spot/futures price,
then generate `atm + i*step` for `i` in `range(-N, N+1)` — rather than slicing the fetched
DataFrame's index, since the chain may not include every step-aligned strike (deep
OTM/ITM strikes are often thin or absent). Cross-check that the strikes you generate
actually exist in `df.index` before indexing into it; a missing strike raises `KeyError`
on `df.loc[strike]` the way `get_atm_row` documents at `lib/dhan_helper.py:3624-3627`.

## Scope boundary with sibling skills

This skill stops at "I have a correct chain DataFrame and can find strikes in it." For
what to compute from that chain, use the dedicated skill: OI buildup/PCR/max-pain →
`dhan-oi-analytics`; aggregating a live position book's own per-contract Greeks →
`dhan-position-greeks`; payoff-curve construction and Black-76 Greeks →
`dhan-payoff-diagrams`; historical/expired chain data (a completely separate SQLite
pipeline, not this live-chain API) → `dhan-expired-options-data`; MCX-specific lot-size
and quantity handling layered on top of everything here → `dhan-crudeoil-trading`.

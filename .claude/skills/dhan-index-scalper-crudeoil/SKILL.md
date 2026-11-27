---
name: dhan-index-scalper-crudeoil
description: Use when a change or bug on /index-scalper is specific to full-size CRUDEOIL (MCX, 100 barrels per lot, 5-lot cap, order tag isxc, 10x the mini's exposure). Instrument-specific facts only; the terminal is dhan-index-scalper, MCX units are dhan-crudeoil-trading.
---

# Index Scalper: CRUDEOIL (MCX full-size)

Read `dhan-index-scalper` ("MCX crude") and `dhan-crudeoil-trading` first; sibling is `dhan-index-scalper-crudeoilm`. Spec: `INSTRUMENTS.CRUDEOIL` (added 2026-11-25).

## Facts
| | |
|---|---|
| Barrels per lot | **100** (10x CRUDEOILM): every lot, P&L and margin figure is 10x |
| Quantity | Dhan order qty = lots; Kotak = lots x 100 barrels (2-lot Kotak position = netQty 200, never 2) |
| P&L multiplier | Dhan 100; Kotak / SIM 1 |
| Segment, ticks, strike step, session, NRML-only | identical to CRUDEOILM (MCX_COMM, 50 / 1.0 / 0.1, MCX hours, MARGIN) |
| **Cap** | **5 lots per order** (500 bbl, owner's choice). Quick Trade shows/sends `min(saved, 5)`; widget steppers clamp on switch |
| Tag | **`isxc`** (server cap is keyed by tag, which cannot tell the crudes apart). Dhan `SOURCE_QTY_CAPS_MCX.isxc` = 5; Kotak `SOURCE_LOT_CAPS.isxc` = 5, chosen from the contract server-side, never from the browser |
| Closes | Uncapped, tag `isxx`. Tagging a close with `isxc` once made a 10-lot position impossible to exit |
| Modify | Sends the cap tag only when this page changes its own order's lots; price-only moves are never capped |
| Own-order test | tags start with `isx`, so `isx`/`isxc`/`isxx` all match |

## Traps
- Any "contains CRUDE" or `CRUDEOIL` prefix match also catches CRUDEOILM: use the exact-root helpers.
- Reverse: the opening half is capped per order (`reverseLotsError`); MCX MIS legs refuse.
- A size that is fine on the mini (e.g. 10 lots) is refused here: surface the 5-lot message, don't raise the cap without the owner.
- Full-size margin and MTM guard rupee defaults (8,000 / 8,000) are far tighter in points than on the mini.

## Verify
`node --test lib/indexScalperInstrument.test.ts`; `e2e/index-scalper-crude.spec.ts` (both crudes); server caps in `lib/dhanSourceCaps.ts`.

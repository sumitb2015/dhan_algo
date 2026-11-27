---
name: dhan-index-scalper-crudeoilm
description: Use when a change or bug on /index-scalper is specific to CRUDEOILM (MCX mini crude, 10 barrels per lot, futures + options, lots on Dhan vs barrels on Kotak, NRML-only). Instrument-specific facts only; the terminal is dhan-index-scalper, MCX units are dhan-crudeoil-trading.
---

# Index Scalper: CRUDEOILM (MCX mini)

Read `dhan-index-scalper` ("MCX crude") and `dhan-crudeoil-trading` first. Spec: `INSTRUMENTS.CRUDEOILM`. e2e: `e2e/index-scalper-crude.spec.ts`.

## Facts
| | |
|---|---|
| Exchange / segment | MCX, `MCX_COMM` (Kotak `mcx_fo`); candles `MCX_COMM` / `FUTCOM`; no index id: the underlying pane **is the future** |
| Barrels per lot | **10** (`mcxBarrels`, from `MCX_LOT_MULTIPLIER`) |
| Quantity | Dhan order qty = **lots** (master `LOT_SIZE` is 1); Kotak = lots x 10 barrels |
| P&L multiplier | Dhan 10 (netQty in lots); Kotak and SIM 1 (barrels). SIM ledger stores display units |
| Strike step / ticks | 50 / future tick 1.0, option tick 0.1 |
| Cap / tag | 20 lots per order, tag `isx` |
| Product | **NRML (MARGIN) only** for opening orders (`openingProduct`); a close keeps the leg's own product |
| Session | MCX weekdays 09:00 to 23:30 (summer DST) / 23:55 (winter) via `mcxSession`; bars anchored 09:00 |
| FUT | Futures are traded here (unlike NIFTY / SENSEX); option month uses the nearest FUTCOM expiring on/after the option expiry |
| Chain | `get_expiries()` needs the futures-contract id, not the commodity id (`docs/API_GOTCHAS.md`) |

## Traps
- Branch on `isMcx(u)`, never `=== 'CRUDEOILM'`.
- **Never read CRUDEOILM as CRUDEOIL** (or the reverse): a 10x error. `symbolMatchesUnderlying` files CRUDEOILM under CRUDEOIL on purpose; use `parseScalperContract` (exact root then "-" or digit), Kotak rows `startsWith(u)` + digit, chart order filter `^ROOT(?=[\s\d-]|$)`.
- Kotak MIS fresh crude positions are RMS-refused; that is why NRML-only.
- Closes are never lot-capped (`isxx` tag).
- Kotak quantity unit for CRUDEOILM (barrels, 10/lot) confirmed live 2026-11-03.

## Verify
`node --test lib/indexScalperInstrument.test.ts lib/indexScalperSession.test.ts`; `e2e/index-scalper-crude.spec.ts`.

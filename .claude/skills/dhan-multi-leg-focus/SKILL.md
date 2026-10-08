---
name: dhan-multi-leg-focus
description: Use when touching Multi-Leg Focus (/multi-leg-focus) — rs_dashboard/components/MultiLegFocus.tsx, components/multiLegFocus/* (Strategy row, Leg row, Add New Leg, Scale, Group bar, Ungrouped trades, Strategy Chart, P&L table, Position Map), lib/multiLegFocus.ts, multiLegFocusStore.ts, multiLegStoreMerge.ts, multiLegRegroup.ts, multiLegBrokerSync.ts, multiLegArchive.ts, and app/api/multi-leg-focus/*. A map of the page's moving parts and the cross-file rules (which pure module owns which decision, which tests to run, what a store change must also touch). The ownership/safety invariants themselves live in dhan-terminal-position-ownership; read that first. Real-money endpoint.
---

# Multi-Leg Focus — anatomy and cross-file rules

An N-leg options basket terminal (Dhan; Zerodha/Kotak via `basket.broker`). Baskets are persisted in
`debug/multi_leg_baskets.json` (archive: `debug/multi_leg_baskets_archive.json`) by `lib/multiLegFocusStore.ts`.
The biggest source of bugs here is **several tabs writing one file**, so most modules below exist to make a stale
tab lose gracefully. **Read `dhan-terminal-position-ownership` (Invariants 1, 2, 6, 9, 10) and `dhan-polling-guards`
before changing any of it**; this skill only maps the page.

## Who owns what (all pure unless noted; each has a `*.test.ts` next to it)
| Module | Decides |
|---|---|
| `lib/multiLegFocus.ts` | Types (`MultiLegBasket`, `MultiLegLeg`, `WaitingEntry`), leg P&L/avg/qty maths, fill grace, `reconcileLegWithBroker`, order-row classification, `settleWaitingEntry` / `applyTriggeredEntry`, scale maths |
| `lib/multiLegStoreMerge.ts` | Server-side merge of a basket save into the stored copy by per-item `rev`; a leg that ever traded is never dropped by a save; append-only id lists (`orderIds`, `outsideTradeKeys`) are unioned; `relocateResurrectedLegs` |
| `lib/multiLegRegroup.ts` | Group / ungroup = moving legs between baskets; places no orders; refuses PLACING/CLOSING legs; one broker + one underlying per basket; drafts never share a group with traded legs; disarms strategy SL/target on changed groups |
| `lib/multiLegBrokerSync.ts` | Broker → ledger: `growLegToBroker`, `outsidePositionBaskets` (a position no leg holds becomes an ungrouped trade), futures-row detection (`futuresContractOf`) |
| `lib/multiLegArchive.ts` | Retiring finished strategies (`isFullyClosed`, `splitEarlierDayLegs`); a row holding a waiting stop entry is **not** finished |
| `lib/multiLegFocusStore.ts` (server I/O) | Atomic JSON writes, calls merge/regroup/archive |
| `lib/multiLegGreeks.ts`, `lib/positionPayoff.ts` | Greeks panel and payoff — through the central libraries (`dhan-payoff-diagrams`, `dhan-position-greeks`) |
| `app/api/multi-leg-focus/{baskets,baskets/regroup,archive,margin,depth}` | Store, server-side regroup, archive, broker margin (own interval), depth for the limit ladder |

## Rules worth knowing before you edit
1. **One strike per group** (2026-10-07). Place / add lots / add leg / scale / shift onto a strike open in another
   group is *refused* (`refuseSharedStrike`), not confirmed. A contract's broker qty therefore belongs to its one leg
   and broker sync may grow it. Stand-down: sync and reconcile pause while PLACING/CLOSING, `pendingOrders`, fill
   grace, any order action or regroup is in flight. Trade-off recorded in the vault: a position on the same contract
   opened by another surface is adopted here and a stop set here can close it.
2. **Regroup is server-side** (`baskets/regroup`): it backs up the ledger, bumps revs, and a leg can live in only one
   basket so a stale tab cannot resurrect a moved leg (`relocateResurrectedLegs`). Exits wait (8 s timeout) for a
   running regroup, then write back to the row that *now* holds the leg. Other tabs re-read via `BroadcastChannel`.
   Regroup is refused while an order action runs on the involved rows, and vice versa.
3. **Ungrouped trades** are one-leg baskets with no name (`isLooseTrade`). Positions the page cannot identify stay as
   read-only `BROKER ONLY` rows in the Ungrouped trades table. Ungrouping a row keeps its closed legs there as history.
4. **Futures legs** (`option: 'FUT'`, strike 0; adopted from the broker only): payoff = synthetic call − put at strike
   = entry, delta 1, exit via the broker row. Place / add lots / shift / scale refuse them (`isOptionLeg`); chain
   views skip them. Live price = `costPrice + unrealizedProfit / netQty` — Dhan leaves the contract multiplier out
   of MCX `unrealizedProfit`, so dividing by it showed 8590 against a live 8721. An open leg with no live price has
   **no P&L** (never value against 0). Groups with futures show rupee P&L only; points/% and strategy Target/SL are off.
5. **Day roll.** A leg opened on an earlier IST day whose security id is absent from the broker book is marked CLOSED
   (no exit price recoverable); the same day an absent row only waits (order-propagation lag). `86a03d93`.
6. **Stop-loss entry orders (SL-L / SL-M, Dhan only, `ca20e7c7`).** A resting stop is a `WaitingEntry` on
   `basket.waitingEntries`, **never a leg**. Each poll, `settleWaitingEntry(w, orderRow)` returns wait / open / dead /
   expired; only `open` creates a leg (`applyTriggeredEntry`, at the traded qty and average, idempotent by order id).
   No order book this tick = nothing settles. If another group already tracks that security id the fill is **not**
   added (toast: move it manually). Exit All cancels waiting stops; deleting a row that holds one is blocked;
   `fast-order` accepts `STOP_LOSS` (limit must be on the correct side of the trigger) and `STOP_LOSS_MARKET`.
7. **Header Today P&L comes from broker positions** (not summed legs); MCX is scaled by the multiplier. The Recon
   chip audits baskets against broker day totals. Only one broker-scope MTM chip.
8. **Scale (+N)** previews with `planScale()` and re-checks margin live — preview equals execution (see the Scale
   section of `dhan-terminal-position-ownership`). The Position Map and P&L-by-date grid share `buildHeatmapGrid`.
9. **Strategy Chart modal** fills the modal height (`dbebd53c`) and scopes chart errors to the selection.

10. **Leg SL / TP units** (`LegThresholdType` = `'pts' | 'pct' | 'price'`, 2026-10-08). `pct` is a percentage of the
   leg's *entry premium* (`fill.avgPrice`): SL 30 % on a 100 sell = exit at 130. The toggle in `MultiLegLegRow` cycles
   pts → % → price via `nextLegThresholdType`. All conversion lives in `computeLegTrailingSL`; a new unit is added
   there plus the type, the toggle/placeholder/label in `MultiLegLegRow` and `AddLotsModal`, and a test. The
   1-rupee trail uses the resolved SL price, so it works with any unit. Strategy-level Target/SL
   (`StrategyRiskConfig`, `checkStrategyRisk`) already has `pts | pct` (pct of combined gross entry premium).
   `MultiLegStrategyRow` whitelists `slType`/`tpType` patches and `MultiLegFocus.tsx` carries them on scale; both
   pass new values through untouched.

## Change checklist
- Touched a basket/leg field? Update `multiLegStoreMerge` (rev + union rules) and its `…Resurrect` test, or a stale
  tab will drop/overwrite it.
- New order path? Two-phase concurrent placement with rollback, shorts exit before hedges, fail-closed margin gate
  (Invariants 6/9/10) and a unique idempotency key.
- New leg kind or state? Check `isFullyClosed`, regroup refusals, broker sync, exit sizing and the Greeks/payoff skip rules.
- Run: `cd rs_dashboard && node --test lib/multiLegFocus.test.ts lib/multiLegStoreMerge.test.ts lib/multiLegStoreMergeResurrect.test.ts lib/multiLegRegroup.test.ts lib/multiLegBrokerSync.test.ts lib/basketOrders.test.ts`.
- Reload every open Multi-Leg tab after a store-shape change; first real-money check is a 1-lot order compared with
  the broker's order book (vault thread: `multi-leg-focus-followups`).

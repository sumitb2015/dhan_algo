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
| `lib/multiLegGuards.ts` + `lib/multiLegGuardEngine.ts` | Basket `guards` (2026-10-12): spot triggers, net-Greek bands, rupee max-loss + account margin-utilisation alarm. `multiLegGuards.ts` = rules, edit reducers, `exitSide`, `expireStaleGuards`; `evaluateBasketGuards` (engine) = one pure evaluation pass returning effects (patch / toast / exitAll / exitSide). UI is `components/multiLegFocus/GuardsPanel.tsx`; `MultiLegFocus.tsx` only supplies inputs (1 s ref-driven timer, no re-render) and performs the effects |
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

11. **Guards** (`basket.guards`, 2026-10-12; rules in `lib/multiLegGuards.ts`). Leader tab only. A spot trigger acts
   only on a FRESH spot (`guardSpotFor`: live feed < 10 s, chain fallback < 30 s, else 0 = unknown) and only after the
   breach lasts `SPOT_CONFIRM_MS` (3 s; a 1 s tick drives the clock). An exit trigger stamps `firedAt` first, then keeps
   retrying every 15 s until its scope is flat (`stepGuard`), so a reload resumes it. A trigger cannot be armed past its level.
   - **An exit ACK is not a fill.** Exits flip a leg to CLOSED on ACK and a rejection reopens it later. So (a) a side exit
     (`EXIT_CE`/`EXIT_PE`, `exitSide`) sells a hedge only after the shorts are ACKed AND `confirmShortsDown` (the same
     positions-book check Exit All uses) shows them down; (b) a guard does not `finish`/disarm while `legsSettling` (a pending
     order or a leg closed inside the fill grace), or a rejected exit would never be retried; (c) a retry holding only hedges
     waits while the shorts it already closed are still settling (`shortsSettling`).
   - **Edits are functional.** The watcher writes `guards` too (firedAt, armed), so the panel applies the reducers
     (`editSpotTrigger`, `setBandArmed`, ...) through `patchGuards`; replacing the whole object from the render's copy
     reverts the watcher's write. Editing any guard disarms it.
   - Greek bands take negative and zero limits (`RuleNumInput signed`, `parseRuleNum`); every other box stays positive-only.
   - Greek bands skip while any open leg is unpriced or an IV was assumed. The alarm announces once per escalation and
     re-arms 5 points below the threshold. Regroup disarms the guards of every changed group (`disarmGuards`) because a
     trigger written for one set of legs must not act on another. There is no auto-hedge yet.
   - **Day roll:** a guard stores `armedDay` (IST) when armed; `expireStaleGuards` disarms any armed guard from another day
     (or unstamped) with one toast, so a level chosen for yesterday never acts on a carried or new position. Re-arm daily.
   - **UI is "Risk rules"** (2026-10-15): one row per rule, `[ON/OFF switch] If … → action`. The max loss always measures
     today's P&L (live legs + legs closed today) with a fixed 80% heads-up; margin use is its own rule
     (`guards.marginAlarm`, alert only, own switch). `normalizeGuards` migrates older saves (`alarm.lossScope` / `warnPct` /
     `marginWarnPct`): the engine stores the new shape on its first pass and turns OFF an armed loss rule whose meaning changed
     (it counted all trades, or warned at another %), with a toast. Every reducer normalizes first.
   - **Leg rules** (`guards.legRules`, 2026-10-15): one leg by id, watching spot, its own price, or its own ₹ loss
     (80% heads-up) → Alert me / Close leg (`exitLeg` effect → `exitOneLeg(..., { unattended: true })`). Same 3 s confirm,
     firedAt + 15 s retry, settling waits, day expiry and edit-turns-off as the strategy rules. Option legs only. A rule
     ends (turns off) when its leg closes and has settled; it does NOT follow a strike roll to the new leg. A hedge leg
     waits with one notice while a short on its side is open (`hedgeHeldOpen`, the same predicate `exitOneLeg` refuses on).
     An armed-today EXIT_LEG rule counts as protection in `unguardedShorts`.
   - **Alert-only SL / Target** (`leg.slAction` / `tpAction` = `'ALERT'`, bell toggle in the leg row): the leg monitor
     toasts + chimes once per crossing (30 s quiet period), never exits or auto re-enters; an alert-only SL is not
     protection in `unguardedShorts`. Carried with sl/tp on roll and auto re-entry; allowed by `updateLeg`'s live-edit whitelist.
   - **Spot freshness is per chain pair** (`chainSpotAtRef`, stamped only when a fetch carried a positive spot), so another
     underlying's updates cannot make a stale spot look fresh. Margin-alarm state is per basket, not per broker.
   - **Automatic exits never raise a dialog.** `exitBasket` and `exitOneLeg` take `{ unattended: true }` (guards pass it): the
     "could not confirm the shorts" confirm becomes "keep the hedges, retry", and the BUY-leg hedge prompt is skipped unless a
     short on the same side is still open (then the hedge is refused with a toast). A `window.confirm` in an unattended tab
     freezes it, and a 15 s retry would raise it again.
   - **Close-at-max-loss closes once.** The alarm stamps `firedAt` with the exit, retries until flat (hedges-only retries wait
     for settling shorts), then disarms. Otherwise a leg added the same day would be closed at once by the realized loss.
   - **Test the engine, not the effect:** add a case to `lib/multiLegGuardEngine.test.ts` for any new guard behaviour.

12. **Resting LIMIT exits** (Exit ticket, Dhan only, 2026-10-13). Unlike a market exit, a limit exit does NOT flip the leg to
   CLOSED on ACK: it records `pendingOrders` `{kind:'exit', resting:true}` and the leg stays OPEN, so its SL/target/guards keep
   working. The fill reaches the ledger through broker reconcile (full close, or `brokerClampSlice` for a partial, price
   estimated from the row). `applyOrderOutcomes` only retires a resting entry (never reopens/re-prices; TTL 8 h, not 30 min) and
   `legsSettling` ignores it. **Every other exit goes through `exitOneLeg`, which cancels the resting order first** (DELETE
   `/api/scalper/orders`) and only then reads the position; a failed cancel aborts the exit (it may have filled). Never send a
   second exit while a resting one is live. Limit price snaps to the contract tick (`lib/multiLegExitOrder.ts`).

## Change checklist
- Touched a basket/leg field? Update `multiLegStoreMerge` (rev + union rules) and its `…Resurrect` test, or a stale
  tab will drop/overwrite it.
- New order path? Two-phase concurrent placement with rollback, shorts exit before hedges, fail-closed margin gate
  (Invariants 6/9/10) and a unique idempotency key.
- New leg kind or state? Check `isFullyClosed`, regroup refusals, broker sync, exit sizing and the Greeks/payoff skip rules.
- Run: `cd rs_dashboard && node --test lib/multiLegFocus.test.ts lib/multiLegStoreMerge.test.ts lib/multiLegStoreMergeResurrect.test.ts lib/multiLegRegroup.test.ts lib/multiLegBrokerSync.test.ts lib/basketOrders.test.ts`.
- Reload every open Multi-Leg tab after a store-shape change; first real-money check is a 1-lot order compared with
  the broker's order book (vault thread: `multi-leg-focus-followups`).

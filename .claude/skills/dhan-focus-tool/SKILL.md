---
name: dhan-focus-tool
description: Use when touching the Focus Tool (/focus-tool, "Ultimate Scalper Terminal — Straddles & Strangles") — rs_dashboard/components/FocusTool.tsx (Pro / Table / Cards row views), lib/focusToolRules.ts, focusToolRows.ts, focusToolUnderlyings.ts, useFocusMarketData.ts, useFocusToolWS.ts, scripts/tools/focus_tool_ws.py and app/api/focus-tool/*. A map of the page plus the conventions that cost a bug each time they were missed: where each underlying's live prices come from (CRUDEOILM is not on the focus WS), SL entered as a percentage but stored as a multiplier, the per-row strike step (MCX "100s only"), per-leg lots, the one-entry latch behind "Enter now" / per-leg "Re-enter", and the icon-button / aligned-levels UI rules. Real-money endpoint; read dhan-terminal-position-ownership (Invariant 11) first.
---

# Focus Tool — anatomy and conventions

A scheduled straddle/strangle terminal. Each **row** sells CE/PE at resolved strikes, with leg SL/target, pair stop,
re-entry, lazy legs, overall SL/target/trail. Rows + the fill ledger live in `debug/focus_tool_rows.json`
(`app/api/focus-tool/rows`). It executes **only in the open browser tab that is the leader**; a second tab shows the
banner "Focus Tool is open in another tab…" and fires nothing (manual buttons still work). Rows are SIM or REAL per row;
REAL also needs the daily LIVE · REAL MONEY arm. Ownership/safety rules: `dhan-terminal-position-ownership`
(Invariant 11) — ledger-owned legs, unconfirmed orders held, down-only reconcile. Do not re-derive them here.

## Files
| File | Owns |
|---|---|
| `components/FocusTool.tsx` (~9k lines) | The page, the scheduler, `placeLeg`, `autoEnterRow`, `armRow`, exits, re-entry, all three row views |
| `lib/focusToolRules.ts` (+`.test.ts`, `focusToolRules.cases.json`) | Pure rules: `evaluateEntry`, stop/target levels, `legLots`/`multipliedLots`, re-entry, trail. Parity with `tests/test_focus_tool_parity.py` |
| `lib/focusToolRows.ts` | `FocusRow` type (add new row fields here), fill ledger shape |
| `lib/focusToolUnderlyings.ts` | Per-underlying meta: `strikeStep`, `segment`, `unitsPerLot`, session windows, `FEED_BRIDGE_UNDERLYINGS`, `toInternalQty`/`orderQuantity` |
| `lib/useFocusMarketData.ts` | REST polling: expiries, lot sizes, lookups, **chains** (3 s client poll of `/api/options/chain`, itself 30 s cached) |
| `lib/useFocusToolWS.ts` + `scripts/tools/focus_tool_ws.py` (port 8965, via `market_data_hub`) | Tick feed for NIFTY / BANKNIFTY / SENSEX **only** |
| `lib/focusToolPnl.ts` (+`.test.ts`) | Row / leg P&L, `pnlPctOfPremium`, the fill-price basis maths (`blendFillBasis`, `sliceTradedPrice`, `fillRebasePatch`) — see `dhan-fill-price-pnl` |
| `lib/focusToolPresets.ts` (+`.test.ts`), `lib/focusToolPresetsStore.ts`, `app/api/focus-tool/presets/`, `components/FocusToolPresets.tsx` | Duplicate row, rule presets (`debug/focus_tool_presets.json`), export / import |
| `lib/tradedPriceClient.ts` | The one browser-side Dhan order-price reader (final status only), shared with Synthetic Futures and Triple Straddle |

Three row views — **Pro** (`FocusProRowImpl`, the legs grid), **Table** (`FocusTableRowImpl`), **Cards**. `FocusRowViewProps`
is derived from the Table impl's props; Cards declares its own prop type. A new row action therefore needs: the prop in
the Table type (`onX?`), the Cards type (else TS fails at the call site), the three `onX={…}` call sites, and the UI in
each view you care about. Polish so far is Pro-first; say which views you changed.

## Which broker a REAL row is on (2026-10-17)
The page broker is the ONE `dhan_algo.selected_broker` localStorage setting every dashboard page shares, so the Focus
Tool can load on a broker another page picked. `FocusRowFill.broker` records the account a REAL position opened on
(`nextFillBroker` in `adjustFillQty`: stamped flat→held, kept while held, dropped when flat; never guessed for a row
opened before the field). Pure rules in `lib/focusToolBroker.ts` (+ test), browser proof in `e2e/focus-tool-broker.spec.ts`.
- On load the page **follows** the broker its open REAL rows agree on (`followBroker`: this page only, not saved), never
  while an order is in flight or unconfirmed. Rows split across two brokers: not followed, selector unlocked, toast.
- `placeLeg`, the ladder (place / reconcile / cancel), the level watcher, the 1 s scheduler, pending re-entries and Exit
  All's row retirement all skip or refuse a row with `rowBrokerMismatch(row, broker)` (`refuseForeignBroker`, 10 s
  toast throttle); the row views disable its buttons with the reason.
- The selector locks on `brokerSelectorLocked(rows)` OR `busyRows.size` OR a pending unconfirmed order.
- A position book is "unknown", never "flat", when the poll carries `positionsError` (Kotak / Zerodha answer
  `success:true, positions:[]` when the session is gone) or belongs to the previous broker (`positionsBrokerRef`;
  `placeLeg` re-reads it). Either read as flat made the next exit drop a live leg as "closed outside the tool".
- New order path or new rule loop → add the mismatch check; new fill writer → go through `adjustFillQty`.

## Zerodha parity (2026-10-19)
Zerodha has the same order safety as Dhan/Kotak: per-order status + cancel through `/api/scalper/orders?orderId=&broker=zerodha`
(`shapeZerodhaOrderStatus`, shared order-book read), traded-price re-pricing, the limit ladder, own-order ids remembered for the
outside-close match (`noteOwnOrder`), opens carry `source:'fts'` (100-lot cap; closes never), exchange freeze from Dhan's master
via the Zerodha lookup route. `tracksOrderStatus` is now true for every broker — do not use it as a proxy for "MCX allowed".
**CRUDEOILM on Zerodha:** order quantity is in LOTS (checked on Kite's margin calculator: qty 1 = 10 barrels; its MCX dump
lists `lot_size` 1), so `brokerOrderQuantity` / `brokerToInternalQuantity` treat it like Dhan, and `shapeZerodhaPosition`
multiplies MCX P&L by barrels per lot. Position / fill / trade-book read-back units were NEVER observed live (the Kite app had
no static IP, so no probe order could be placed): first REAL lot shows a one-time toast to check Positions quantity = lots.
Proof: `e2e/focus-tool-zerodha.spec.ts`.

## An order with an UNKNOWN outcome (2026-10-17)
`classifyOrderReply` (`lib/focusToolOrderOutcome.ts` + test) sorts every order reply into placed / rejected / unknown.
Unknown = no reply, a 504 (Dhan: not found by correlationId; Kotak: not in the order book within ~5 s; both routes now
send `unknown: true`), or a non-JSON 5xx. It may be LIVE. Never report it as "rejected": the entry retried the leg (a
doubled short) and an all-unknown entry cleared its latch and re-sold every tick.
- `holdUnknownOrder`: an unconfirmed-order record with `orderId: null`, `holdMs` 60 s (the sweep credits a late fill
  from the position book). Open records are kept while the row exists even with no ledger (a first entry has none).
- An unknown OPEN (or ladder order) also sets `FocusRow.orderUnknown` (persisted, `ROW_RUNTIME_KEYS`) plus the
  synchronous `unknownHoldRef` (the next leg of the same entry runs before a render). While set, `placeLeg` and the
  ladder refuse every open, the scheduler and pending re-entries skip the row, and `autoEnterRow` neither retries the
  missing leg nor clears its latch. Exits still run. A red banner lists held rows; only its "Checked — resume" button
  (`clearUnknownHold`) or `armRow` (Arm / Enter now) clears it.
- An unknown CLOSE only holds further closes on that leg (no row pause).
- `placeLeg` also refuses an open while an earlier order on the same leg is unconfirmed.
- Proof: `e2e/focus-tool-unknown-order.spec.ts` (shared mock `e2e/focusToolMock.ts`; "Enter now" is Pro-view only, so
  those tests open with `view: 'pro'`). Event kind `order_unknown` carries `orderKind` — an `extra.kind` would overwrite
  the event's own kind in `logEvent`.

## Order safety rules from the 2026-10-18 review (`e2e/focus-tool-order-safety.spec.ts`)
- **A held leg has its own product.** `FocusRowFill.ceProduct` / `peProduct` is stamped on the flat→held move
  (`nextLegProduct` in `adjustFillQty`); every lookup, close and ladder order uses `legProduct(row, leg, …)`
  (`lib/focusToolBroker.ts` `legProductFor`), never the group's current product. The group PRODUCT select is locked while
  any row on the index holds a position or has an order in flight (`productLockReason`, refused in `updateGroup`).
- **Position rows: prefer the open one.** Dhan lists a closed-then-reopened leg as two rows of one product; match with
  `openRowOfProduct` (`lib/positionProduct.ts`), never `.find(product)`.
- **Orders are sliced** under the exchange freeze (lookup `freezeQty`: Dhan master `SM_FREEZE_QTY`, Kotak `lFreezeQty`,
  read as the first refused size) and the route cap (`maxOrderUnits`; `fts` in fast-order `SOURCE_QTY_CAPS` and Kotak
  `SOURCE_LOT_CAPS`, the latter sent on opens only). A rejected later slice is not a full close (no ledger wipe, no
  re-entry); an unknown slice is held with everything already sent. Sliced fills settle from the book.
- **ACK is not open.** Non-`awaitFill` opens count in `confirmsInFlightRef`; `checkEntryLegsFilled` / `awaitLegSettled`
  wait for the real outcome and raise the persistent NAKED / LOPSIDED banner (`nakedAlerts`) on a late rejection.
- **Header EXIT ALL** retires a row only once a fresh book shows its owned legs flat (8 s); others stay watched.
- **Closes run under a cross-tab Web Lock per leg** (`withLegCloseLock`); manual, non-leader or waited-for closes size off a
  fresh book. Sizing reads the latest ledger (`sizeRow`), not the caller's row copy. A close is refused when the broker
  shows the contract LONG while the row holds a short (`close_refused_direction`).
- **Auto-entry holds the row** (`enteringNowRef` + `busyRows`); whole-row exits and leg stops wait for it, then close all.
- The account trail-floor reset effect depends on `trailX.kind/every/by` by value (a new object came with every save).

## Where live prices come from (the lag bug, 2026-10-09)
| Underlying | Option LTP / P&L source |
|---|---|
| NIFTY / BANKNIFTY / SENSEX | `focus_tool_ws.py` ticks → `focusWsQuotes[u]` |
| **CRUDEOILM** | **Not on the focus WS.** The shared `live_options_ws.py` bridge (one process per underlying, the Advanced Scalper's) via `useLiveOptionsWS(expiry,'dhan',['dhan'],'CRUDEOILM')`, adapted into `focusWsQuotes.CRUDEOILM` (`books[expiry]`, same shape as the others). |
| Fallback (any) | `chains` — REST chain: server-cached 30 s, `last_price` is a lagging snapshot (measured 4.7 % behind on MCX). Fine for strike lists, **wrong for stops and P&L**. |

Rules: the CRUDEOILM feed is **one expiry** (nearest unless every row sits on a later one) — rows on another expiry fall
back to the chain, with its lag. The page `POST`s `/api/options/live {action:'start'}` when the expiry is known and
**never stops it** on unmount (the Advanced Scalper shares it); a 60 s keep-alive restarts it **only if status is not
RUNNING/STARTING** (a start for a different expiry restarts the bridge, so two pages disagreeing would flap it). Quotes
older than `WS_STALE_MS` (8 s) are dropped so consumers fall back to the chain; a 1 s clock state re-evaluates that.
Check the feed: `debug/live_options_quotes_dhan_crudeoilm.json` `updated_at`, status file, and the bridge log
(`WS clients=N` shows the page connected). Prices that stop moving while the file is fresh = the page, not the bridge.

## SL and target units — one convention
- **Everything is typed as a percentage**: SL 20 = stop at 20 % above entry; Tgt 40 = exit 40 % below entry (unit chips:
  `% / pts / idx pts / idx % / Δ`). Overall SL (Total Premium %) already worked this way.
- **Storage is unchanged**: `ceSlMultiplier` / `peSlMultiplier` / `slMultiplier` stay multipliers (`'1.2'`), because the
  rules, the Python worker and the parity cases read them. Conversion is display-only: `slMultToPct` / `slPctToMult` and
  the `SlPctInput` wrapper over `RuleNumInput` (commit-on-blur — `dhan-commit-on-blur`). Never hand-write `1 + n/100`.
- A stored value is **never shown blank** (`'1'` shows `0`); a blank box means "off". Do not add a new SL input as a raw
  `RuleNumInput` on a multiplier field — the same field would then mean 20 in one view and 1.2 in another.
- Tooltips/labels say `SL %`, `Pair %`. The `×` wording survives only in internal comments and stored field names.
- A typed `1.4` in **Tgt %** is 1.4 %, i.e. ~2 premium points: it fires on noise, and with RE ASAP ×2 it re-sells and
  re-exits within seconds (seen live on CRUDEOILM). When a user reports "exits instantly", read the event log
  (`debug/focus_tool_events.jsonl`: `auto_exit_leg` `rule`/`reason` states the exact level) before touching code.

## Strike step is per row, not per underlying
`STRIKE_STEP[u]` is the exchange default (CRUDEOILM 50). **`rowStep(row)`** is the row's effective step: an MCX row with
`strike100` ("100s only" checkbox beside Link legs) uses 100. Use `rowStep(row)` for ATM rounding, shift, re-entry rolls,
lazy legs, range-open strike, and the payoff model. For premium/delta/criteria picks, `rowLive` also filters the chain to
`strike % 100 === 0` (otherwise the step is honoured by ATM mode only). The index group bar's ATM uses the first row's
step. Adding another per-row strike rule = extend `rowStep` and the `rowLive` chain filter, not a new constant.

## Lots and quantity
Per-leg lots: `row.ceLots` / `row.peLots` (undefined = both legs use `row.lots`); read through `legLots(row, leg)` and
`multipliedLots(row, …)` — never `row.lots` directly. The Pro/Table `RowLotsControl` has the "Per leg" switch. MCX: the page
works in **barrels** internally (`toInternalQty`), orders go out in **lots** (`orderQuantity`); `LegOpenBadge` takes the
row's `lotSize` and shows **lots only** ("S 5 LOTS @ 169.61", barrels in the tooltip; falls back to raw qty when the
quantity is not a whole number of lots). Pass `lotSize` to every new `LegOpenBadge`.

## P&L basis
Booked and live P&L use the leg's ACTUAL fill price (`fill.ceFillEntry`, re-priced to Dhan's traded price), never
the stop reference `ceEntry`. Read `dhan-fill-price-pnl` before touching `bookedPnl`, the rebase helpers or any
P&L display.

## MCX rows measure ATM from their own month's futures (2026-10-16, `e3949f89`)
`rowAtmBase(row, …)` is the single ATM base for rowLive, lazy legs, RE OTM and RE MATCH. For an MCX row it is the futures
contract of the **row's option month** (Nov-17 CRUDEOILM options → Nov-19 futures), taken from the bridge when it runs
that expiry, else that expiry's chain; index rows keep the group's ATM BY. The front-month price put ATM ~100 points off.
A new ATM consumer must call `rowAtmBase`, never `spots[u]` directly. Bridge / chain side: `dhan-crudeoil-trading`.

## Re-entry strike rules (RE on SL / RE on Tgt)
| Mode | Strike sold | Notes |
|---|---|---|
| RE ASAP | what the row resolves to now (ATM ± offset / criteria) | |
| RE OTM, plain SL | `slRollStrikes` further OTM than the strike that stopped | |
| RE OTM, target or a stop that had **trailed** | N OTM of the anchor — `reOtmFrom`: `'atm'` (default) or `'row'` (the strike a fresh entry would take; N may be 0) | `otmReentryStrike`. A trailed SL never re-sells the strike that stopped (steps one more); no anchor → a stop rolls from the closed strike, a target stays closed |
| RE MATCH | OTM-side strike whose premium is closest to the row's OTHER open leg (`matchPremiumStrike`), never the closed strike | Other leg not open / unquoted → leg stays closed with a toast |
| RE COST / MOMENTUM / Lazy | unchanged | |
The trailed-SL flag reaches `reenterLegAfterExit` as `trailedSteps` (passed from the watcher's `ownedLegStop`). Ask the
user which anchor they mean before changing a strike rule — "OTM 1" meant different things across three iterations.

## Leg rules added 2026-10-16
- **Scale-out ladder** (`row.scaleOut`, `ce7733b6`): reduce a leg by 25 / 50 / 75 % of its qty-at-first-step as it moves toward
  ITS OWN target (`legTargetProgress`, any target unit). Reduce only; one lot always kept (the target closes the rest).
  Steps are keyed by **trigger** (`fill.ceScaleAt`), so editing the ladder mid-trade can't re-fire or skip one; recorded
  before the order. A reduce in flight sits in `scalingLegRef` (NOT `autoExitingLegRef`, which means "closing in full") and
  counts in `legExitsInFlightRef`; Square Off Complete waits for it, then closes the sibling (Invariant 11).
- **Per-leg index levels** (`ceEntryLevel` / `ceExitLevel` …, `325abc1e`, UI on each leg's line `923f1d79` via
  `LegIndexLevels`): entry = a `'level'` kind in `legEntryKind` / `driveLegEntries`; exit = `autoExitLeg(…, 'sl')`, so RE on SL
  runs. Both need a REAL cross (`levelCrossStep`); the "seen safe side" mark is keyed to the exact setting (`levelSig`) so an
  edit never fires at once. Entry fires once per day (`firedOn`, reserved BEFORE the order; `armRow` clears it) and also
  starts on an already-entered row. Ignored under Overall Momentum and in an overall re-entry cycle.
- **Leg P&L %** next to ₹ in all views (`pnlPctOfPremium`, same avg and qty as the ₹ figure).

## Duplicate, presets, export / import (`a37d98df`)
A row = RULES + RUNTIME (`ROW_RUNTIME_KEYS`: id, status, mode, fill, rev, counters, ladder, expiry). Copies carry rules
only: a duplicate / imported row is always a flat **SIM draft**. Day prices (`PRESET_SKIP_KEYS`: spot H/L and the per-leg
index levels) never go into presets or imports; Duplicate keeps them and re-validates spot levels. `typedRules` drops a
value whose type differs from a default row's and range-checks lots / Qty ×. A preset applies only to a flat, not-entered,
**not armed** row (`presetBlockedReason`) and replaces every rule (missing ones reset to defaults). Past 100 presets a new
name is refused — never evict.

## Manual entry: "Enter now" and per-leg "Re-enter"
- The scheduler enters a row once: `autoEnteringRef` is a **one-entry latch** set in `autoEnterRow` and cleared only on a
  failed entry or by `armRow` (which also clears `fill`, the overall re-entry counters and `overallReMode`). A row can
  therefore read ARMED and flat yet never enter — Disarm→Arm was the only escape.
- **Enter now** (row header, only when the row is flat): refuses if `busyRows`/`autoExitingRef` hold the row or an entry
  started <15 s ago (`lastAutoEntryAtRef`), confirms for REAL rows, calls `armRow`, then **polls `schedulerRef` until the
  row is `armed` with no fill** (≤3 s) before `autoEnterRow` — a fixed timer both double-entered (latch wiped mid-entry) and
  silently skipped (state not landed).
- **Re-enter** (per flat leg, icon button replacing Exit): `placeLeg(row, leg, {reduce:false, lots: multipliedLots(row,
  legLots(row, leg))})` through `runRowAction`; **first clears that leg's `cePending`/`pePending`** (a waiting momentum /
  range / cost re-entry would sell it again → doubled short). Confirm for REAL.
- Both go through `placeLeg`'s own SIM / LIVE · REAL MONEY guard. Never bypass it.
- `armRow` also toasts when the row's overall trail is invalid (`overallTrailInvalid`: "by" > "every" is ignored by
  `evaluateOverallExit`) so a silently disabled trail is not discovered mid-trade.

## UI conventions (see `dhan-terminal-polish`, `dhan-a11y-controls`)
- Rule number boxes (`RuleNumInput`) take opt-in `step` / `min` / `offBelowMin` / `stepFromBlank` arrows. An arrow commits at
  once but steps from the **committed** value, never a half-typed draft; price levels use `stepFromBlank={false}`
  (`dhan-commit-on-blur`).
- The per-row settings section is **Rules & re-entry**; its collapsed line shows an `OverallSummaryChip` (strategy-level
  SL / target / trail / overall RE) so they are visible without expanding. The header has an India VIX tile that dims with
  its age when the index feed is stale.
- Row-level and per-leg **Exit all / Exit / Re-enter are icon-only** (`ShieldOff`, `LogOut`, `RefreshCw`) with `aria-label`
  and a `title` that says what it does and why it is disabled (`tradeBlockedWhy`). Part-exit is one **`%` dropdown**
  (Exit 25/50/75 %, items disabled when the % rounds to zero lots), not three chips.
- `LegSlLevels` with `inline` (Pro table cell) is a fixed-min-width right-aligned column so stop/target levels line up row
  to row; the non-inline form (cards) stays centred/left. Keep new level spans as one line each.
- Header chips and cells use the zinc/emerald/rose tokens only (`dhan-theme-tokens`).

## Testing and verifying
- `cd rs_dashboard && npx tsc --noEmit -p . && node --test lib/focusToolRules.test.ts lib/focusToolUnderlyings.test.ts lib/focusToolLegLots.test.ts lib/focusToolSimulated*.test.ts lib/focusToolPnl.test.ts` (`focusToolRules` + `focusToolUnderlyings` alone: 138 pass at 2026-10-09), plus `python -m pytest tests/test_focus_tool_parity.py` when a rule changed.
- In the browser the dev data may contain a **real REAL-money row with an open position** and another tab may be the leader.
  Look, scroll, open menus; **do not click Exit / Enter now / Re-enter / + on a REAL row**. Prove behaviour on a SIM row.
- A hot-reloaded page keeps old state: reload after changing prop wiring. Phantom 404s: see CLAUDE.md (stale Turbopack cache).

## Change checklist
- New `FocusRow` field → `lib/focusToolRows.ts`, its default in `makeRow`, the ONE `CLEARED_RULES` constant (Clear rules in
  every view), the server merge if it is list-like, and a test. Decide whether it is a day price (`PRESET_SKIP_KEYS`) or a
  runtime field (`ROW_RUNTIME_KEYS`) — everything else is copied by Duplicate / presets / export.
- New fill-ledger field tied to the position → clear it in `adjustFillQty` when the leg goes flat or re-opens from flat
  (the `ceTrailSteps` / `ceScaleAt` / `ceFillEntry` pattern).
- New order path → `placeLeg` only; sequential legs; a BOTH row that fills one leg is naked (the retry/toast in `autoEnterRow`).
- New price consumer → read `focusWsQuotes` first and the chain second (`pick(ws, chain)`); never the chain alone for a stop.
- Past review findings worth remembering: latch + timer races, stale pending re-entries, blank-looking stored values, a
  per-row rule applied to ATM but not to the chain filter, fixed-delay "wait for state".

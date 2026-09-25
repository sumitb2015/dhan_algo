# Legs table: columns, formulas, and how they are built

Table of contents: Column catalog · Helpers · Widths · Preferences · Sorting and filtering · Adding a column

## Column catalog
Order in the table (optional columns in [brackets]). Every value comes from data already in the row: the leg's
ledger (`leg.fill`, `leg.closedFill`), the live price `ltpFor(leg)`, the row's `spot`, `ivForStrike`. No new API calls.

| Column | Source | Formula | Shows a dash when | Sortable | Default |
|---|---|---|---|---|---|
| Side, CE/PE, Strike, Lots | leg fields | — | — | yes | on |
| [OTM %] | `leg.strike`, row spot | CE `(strike-spot)/spot`, PE `(spot-strike)/spot`, x100; negative = ITM | spot <= 0, or leg CLOSED | no | off |
| [IV] | `ivForStrike(strike, option, leg.expiry or basket.expiry)` | fraction x100, one decimal | iv = 0 (chain not loaded) or CLOSED | no | off |
| [Qty] | `fill.qty` (live) / `closedFill.qty` (closed) | ledger units = lots x lot size, **not** multiplied by the crude multiplier | no fill | yes | off |
| Type | leg | MARKET / LIMIT | — | no | on |
| LTP | `ltpFor` | WS quote for the leg's own expiry, then off-expiry watch, then chain quote | — | yes | on |
| [Avg] | `fill.avgPrice` | as recorded (weighted average after Add Lots merges) | avg <= 0 (DRAFT) | yes | on |
| [Exit] | `closedFill.exitPrice`, CLOSED only | closing fill price | not closed; hidden entirely when no leg is closed | no | on |
| SL, TP, Trail | risk fields | — | — | no | on |
| Expiry | `formatExpiryLabel(leg.expiry or basket.expiry)` | `27 Oct 26` | — | yes | on |
| Margin | margin route per leg | — | — | yes | on |
| P&L | `legPnl(leg, ltp, multiplier)` | short `(avg-ltp)*qty`, long `(ltp-avg)*qty`, x multiplier; CLOSED uses `closedFill` | — | yes | on |
| [P&L %] | `legPnlPct` | `legPnl / (avg*qty*multiplier) * 100`; can go below -100% for a short | no avg/qty, or live leg with ltp <= 0 | yes | on |
| Status, Action | leg.status | — | — | status yes | on |

Amber on OTM % when a SHORT leg is in the money (`text-amber-400`; colour steps stop at -400 in this theme).

## Helpers (pure, in `lib/multiLegFocus.ts`, tested in `lib/multiLegFocus.test.ts`)
`legAvgPrice`, `legExitPrice`, `legQtyUnits`, `legPnlPct`, `legOtmPct`, `formatExpiryLabel`, plus the older
`legPnl`, `basketTotalPnl`, `classifyBasketStructure`, `computeCalendarPayoffCurve`, `findSiblingLegCollisions`.
Rules: return `number | null`; never coerce missing to 0; the ratio helpers use the same qty and multiplier as
`legPnl` so the percentage always agrees with the rupee figure; parse dates by hand (no `new Date`) so the day never
shifts with the time zone. Test at least: short vs long, CE vs PE, CLOSED vs OPEN, zero avg/qty/spot/ltp, crude multiplier.

## Widths
`table-fixed` needs a colgroup. Weights (percent-like, normalised at render): base
`5,5,8,5,6,6,8,8,4,6,9,7,6,14` (= 97); OTM 7 and IV 5 after Strike; Qty 6 after Lots; Avg 6 and Exit 6 after LTP;
P&L % 6 after P&L. Build one ordered array from the same booleans as header and rows, render
`style={{ width: `${(w/total*100).toFixed(2)}%` }}` per `<col>`, and give the table
`minWidth = round(total * 12)px` so extra columns scroll inside the `overflow-x-auto` wrapper instead of crushing inputs.
Fixed Tailwind width classes cannot be computed dynamically, hence the inline style.

## Preferences
`lib/legColumns.ts`: `LegColumnKey`, `DEFAULT_LEG_COLUMNS`, `LEG_COLUMN_LABELS` (label + hint used by the menu),
`parseLegColumns` (pure, tested: null, partial, corrupt, wrong types), `loadLegColumns`/`saveLegColumns`
(try/catch around `localStorage`, key `mlf_leg_cols_v1`). New optional column: add the key, a default, a label, and
the header/colgroup/cell, in that order; bump the storage key only if a default must change for existing users.

## Sorting and filtering
`LegSortKey` + `val()` switch in the strategy row. Sort is a three-state header (asc, desc, off); off keeps stored
order. Open/Closed/All chips only appear when a leg is closed. Header buttons need `aria-sort` and `FOCUS_RING`.
Use the local `sortTh(key, label, align, title)` helper for new sortable headers; do not paste another 6-line block.

## Adding a column: checklist
1. Pure helper + tests (null cases first). 2. Key/default/label in `legColumns.ts`. 3. Weight entry. 4. Header cell.
5. Row cell (same condition, same position). 6. Sort key if useful. 7. Tooltip explaining the maths (the `title` attribute).
8. Browser check with a DRAFT, an OPEN and a CLOSED leg, plus a crude basket if one exists.

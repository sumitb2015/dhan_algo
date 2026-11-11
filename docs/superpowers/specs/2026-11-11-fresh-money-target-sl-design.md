# Fresh Money board — per-position target and stop-loss

Date: 2026-11-11 · Page: `/options/fresh-money` · **REAL MONEY** (automatic MARKET exits on Dhan, Kotak, Zerodha)

## Goal

Each position opened from the Fresh Money board gets a target and a stop-loss, set as a default in the header in
either percent or premium points, and closed automatically by the dashboard server when one is hit — with the tab
closed if need be. The trader can change or clear the levels of any one position afterwards.

Agreed with the user:

- Units: one number per level with a `% | pts` switch (not both at once).
- Executor: the dashboard server (a watcher like the Price Ladder's), not the browser tab.
- Defaults are **stamped onto a position when it opens** and are editable per position; editing the header later does
  not move existing levels.
- Levels are **fixed prices once the opening fill is priced**; adding lots does not move them.
- A level must be breached on **two consecutive checks** before the exit is sent.

Out of scope: trailing stops, partial targets, levels on positions opened elsewhere (only this page's own positions),
levels on the flipped side of a position (see "Flips").

## 1. What the user sees

**Header (trade bar, beside Lots):**
`Target [ 30 ] [% | pts]   SL [ 20 ] [% | pts]`

- Blank = that level is off. Inputs commit on blur / Enter only (dhan-commit-on-blur), Escape reverts.
- Remembered per browser (`freshMoney.exitDefaults`, localStorage), like Lots.
- A **watcher chip** next to them: `Exits: watching` (green dot) while the server watcher's heartbeat is fresh;
  `Exits watcher STOPPED — levels are not being watched` (red) when it is stale and any position has levels set.

**On an order:** the order request carries the header defaults. When the order opens a position on a flat contract,
the success toast names the stamped levels, e.g. `BUY 1 lot … sent · T 30% · SL 20 pts`. A position that already
exists keeps its levels when lots are added.

**Board chip** (the P&L chip beside B / S): the hover text adds `T 130.00 · SL 80.00` (or `levels waiting for the fill
price`); a small `T/SL` marker shows when levels are set, `EXIT?` in amber when an exit is UNKNOWN or incomplete.

**Positions panel:** new **Target / SL** column: `130.00 / 80.00` plus a state badge (`waiting fill`, `watching`,
`exit sent`, `exit UNKNOWN`, `exit incomplete`). A pencil (armed page only, like ×) opens an inline editor for that
position: value + `% | pts` for each level, Save / Clear. The editor previews the resulting prices from the position's
current average before Save.

## 2. Level maths (pure — `lib/freshMoneyExits.ts`)

```
ExitSpec   = { value: number; unit: 'pct' | 'pts' }
levelsFor(basis, dir: 'long' | 'short', target: ExitSpec | null, sl: ExitSpec | null)
  long : targetPx = basis * (1 + v/100)  | basis + v      slPx = basis * (1 - v/100) | basis - v
  short: targetPx = basis * (1 - v/100)  | basis - v      slPx = basis * (1 + v/100) | basis + v
  a level that resolves to <= 0 is null ("off") — never a price
```

- `basis` = the position's average fill price when its levels are resolved (the opening fill once priced; for a later
  edit, the position's current average at that moment).
- Validation (server and page, same function): value finite, `> 0`; `pct` ≤ 1000; `pts` ≤ 100000. A short SL of 100%
  (premium doubles) is valid; a long SL of ≥ 100% / ≥ basis points resolves to null and is shown as off.
- `breached(ltp, dir, levels)` → `'target' | 'sl' | null`: long target `ltp >= targetPx`, long SL `ltp <= slPx`;
  short target `ltp <= targetPx`, short SL `ltp >= slPx`. If both somehow hold, SL wins.

## 3. Ledger record

`debug/fresh_money_trades.json` gains `exits?: Record<positionKey, FmExit>` (same file and lock as the orders, so the
route and the watcher always see one state; it rolls with the ledger each day).

```
FmExit {
  key; openedAt: number;           // ts of the order that stamped it
  dir: 'long' | 'short';
  target: ExitSpec | null; sl: ExitSpec | null;
  basis: number | null; targetPx: number | null; slPx: number | null;
  state: 'waiting-fill' | 'watching' | 'firing' | 'sent' | 'unknown' | 'incomplete';
  firedBy?: 'target' | 'sl'; firedAt?: number; note?: string;
}
```

Lifecycle:

- **Stamp** — in `sendOne`'s check-and-record lock, for a non-close order whose contract is flat with nothing
  unconfirmed, and with at least one valid default: write `{state: 'waiting-fill', dir from the order side}`. Invalid
  defaults refuse the order (nothing sent) with the validation message.
- **Resolve** — watcher: `waiting-fill` + position open in `dir` + average known → `basis`, prices, `watching`.
- **Drop** — watcher: the position is flat (or has flipped to the other direction) and its contract is not settling
  (`contractSettling` false — so a stamp is not dropped before its order fills). Covers a rejected opening order, a
  manual ×, the down-only reconcile and a completed exit.
- **Edit** (`POST {action: 'setExit', key, target, sl}`) — position must be open; any state except `firing`; resolves
  against the current average (or `waiting-fill` if unknown) and sets `watching`. Both null = remove the record.
  Re-arming after `unknown` / `incomplete` is safe: the close path still counts unconfirmed closes (`inFlightReducing`).

## 4. The watcher (`lib/freshMoneyExitServer.ts`)

- Started from `instrumentation.node.ts` (skipped under `DASHBOARD_NO_BACKGROUND`), one loop per process
  (`globalThis` guard), tick every 2 s, no broker or price calls while no record is `watching`.
- **Heartbeat** `debug/fresh_money_exit_watcher.json` `{pid, at}` every tick; the trade GET reports
  `exitWatcher: { alive, at }` (alive = `at` within 10 s).
- Each tick: re-read the ledger; resolve / drop as in §3; for each `watching` record whose market gate is `open` or
  `close-only` and whose broker session is valid, read the price through the same `ltpsFor` as the P&L (WebSocket,
  REST fallback; no usable price = no decision and the breach count resets).
- **Two-check confirmation:** an in-memory per-key count of consecutive breaching ticks (same level); the exit fires
  on the second. A non-breaching or unpriced tick resets it.
- **At most once:** under the ledger lock, re-check the record is still `watching`, set `firing`, then call the shared
  close (`closePositionCore(key, reason)`) outside the lock. Outcome:
  - all slices placed → `sent` (with `firedBy`, `firedAt`). Once the contract stops settling: flat → dropped;
    still open → `incomplete` ("exit filled only part — remaining N lots are not watched; edit to re-arm").
  - refused with **nothing sent** (hold, not logged in, gate) → back to `watching`, `note` = reason, count reset,
    retried no sooner than 5 s later.
  - UNKNOWN or partial → `unknown`, never resent ("exit UNKNOWN — check the broker").
- Logged as `[fm-exit]` with key, level, ltp, basis.

## 5. Shared close path (refactor)

`app/api/fresh-money/trade/route.ts` keeps HTTP only. Ledger (`loadLedger`, `mutate`), `ltpsFor`, `sendOne`, the
order placement and `closePosition` move to `lib/freshMoneyTradeServer.ts`; `closePositionCore` returns a structured
result (`placed` / `refused` (nothing sent) / `unknown` / `partial`) that both the route's × and the watcher use. No
rule changes: own-fill sizing clamped to the broker's net, holds, in-flight-close subtraction, slicing, never sending a
next slice after a refusal or UNKNOWN. Closes sent by the watcher carry `reason: 'Target hit …' | 'Stop-loss hit …'` in
the order record, so the Orders tab says why.

## 6. Flips

Selling more than a long holds (or buying more than a short) flips the position; the record's `dir` no longer matches
and it is dropped. The flipped position starts with no levels (the stamp applies only to an order on a flat contract);
the user can set them from the Positions panel.

## 7. Testing

- `lib/freshMoneyExits.test.ts`: levels long/short × pct/pts; ≤ 0 resolves to off; validation bounds; breach
  directions; SL wins a tie.
- Watcher decisions as pure functions (`nextExitAction(record, position, settling, ltp, count, now)`): resolve, drop
  (flat, flip, not while settling), confirm on the 2nd tick, reset on an unpriced tick, outcome → state mapping,
  `sent` → dropped / `incomplete`.
- Stamping: only on a flat contract, not on adds, invalid defaults refuse the order.
- Existing `freshMoneyTrades.test.ts` unchanged and passing after the refactor.
- Playwright (orders mocked in the browser, never a real order): header inputs commit on blur, toast names stamped
  levels, Positions editor, watcher-stopped chip.

Known limits: the watcher stops with the dashboard (the chip says so); exits are MARKET, so a thin contract can fill
well past the level; prices are Dhan's for every broker.

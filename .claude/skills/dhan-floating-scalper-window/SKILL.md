---
name: dhan-floating-scalper-window
description: Add, restyle or debug a floating one-click "Scalper" window (draggable panel with Buy / Sell at market, lots stepper and presets, Close, Reverse, live P&L, hotkeys) on any order-placing rs_dashboard page - Renko, P&F, Price Ladder, a chart page, an options desk. Use whenever the user asks for a scalper / quick-trade / hotkey / floating order panel or popup, "buy and sell buttons in a floating window", a mini trade window over a chart, or reports that one is cluttered, misaligned, shows "—", double-sends, or trades while it should be locked. Reference implementation is the Renko Scalper (components/straddlePnf/ScalperWindow.tsx, 2026-11-06). Real money; read before writing any such panel. Not for full-page scalper terminals (Scalper.tsx / AdvancedScalper.tsx: dhan-broker-positions) or modal order tickets (dhan-order-tickets).
---

# Floating Scalper window

A floating panel for fast manual scalping on a page that already trades: Buy / Sell at market, lots with − / + and presets,
Reverse and Close while a position is open, a live P&L with a coloured edge, and keyboard shortcuts. It is a **second view
of the page's existing order engine**, never a second engine.

Reference implementation (copy from it, don't reinvent it):

| Piece | File |
|---|---|
| The window (view only, page-agnostic) | `rs_dashboard/components/straddlePnf/ScalperWindow.tsx`. Its `ScalperEngine` interface is the contract. |
| The engine both the trade bar and the window use | `rs_dashboard/components/straddlePnf/usePnfTrade.ts` |
| Page wiring: button, prefs, lock key, AUTO block | `rs_dashboard/components/StraddlePnfPage.tsx` (search `scalper`) |
| REAL P&L between broker polls | `liveRealPnl()` in `rs_dashboard/lib/pnfOrderLogic.ts` (+ tests) |
| Browser tests (all broker calls mocked) | `rs_dashboard/e2e/renko-scalper.spec.ts` |
| User doc | `docs/RENKO_AUTO_GUIDE.md`, "Scalper window" |

## 1. One engine, two views

The page's trade bar (or ticket) already owns the order path: contract lookup, the paper ledger, REAL posts, square-off
sizing, markers, bracket arming and chimes. Before adding the window, **lift that logic out of the bar into a hook called
once at page level**, and make the bar render from the hook's result. Then pass the same object to the window.

Why: two engines means two lots values, two `busy` flags and two position reads. The user changes lots in one place and
trades another size from the other; or a click in the bar and a hotkey in the window both send. With one hook:
- lots, position and P&L are identical everywhere by construction;
- the window keeps working when the trade bar is hidden.

On the Renko page this was a pure refactor: `PnfTradeBar` lost its state and gained a `trade` prop, with no visual change.
Prove it with the bar's existing e2e specs.

A page whose engine has a different shape passes an adapter object that satisfies `ScalperEngine`. Don't fork the window.

## 2. The engine contract (what the window needs)

See `ScalperEngine` in `ScalperWindow.tsx`. The parts that matter for safety:

- **Every order call returns `Promise<boolean>`**: true only when the order went through (PAPER fill, or REAL outcome
  `placed`). Reverse depends on it.
- **One order in flight, enforced by a synchronous ref** (`inFlight.current`), with `busy` state only for the UI. React
  state is stale inside the same frame, so a click and a hotkey fired together would both pass a `busy` check.
- **Reverse = confirmed close, then entry.** Close the whole position (the server sizes it from the broker book), and only
  if that returns true send the opposite side for the position's own size, capped by `cap`. Never one 2× order: if the
  close is unclear, a 2× order could double the position.
- **Sizes and caps stay server-side.** The browser sends target + side + lots only; the route resolves contract, lot
  size and cap (`dhan-order-tickets`). The window's `cap` only stops the stepper.
- **Lots input commits on blur / Enter**, never per keystroke (`dhan-commit-on-blur`).
- **Position "unknown" is not "flat".** If the REAL positions read failed, show "Position unknown" (amber) and keep Close
  usable. Don't show Flat.

## 3. Page wiring checklist

1. Call the engine hook once (see §1). Keep its callbacks (markers, bracket arm/cancel, chime) exactly as the bar had them.
2. Add a header `IconButton` (lucide `Crosshair`, label `Scalper`, `pressed` while open). Hide it when the active
   instrument cannot be traded (an index) and during bar replay (replay has its own practice bar).
3. Remember **open / minimised / position** with the page's `readPref` / `savePref` (read after mount, try/catch, validate
   the parsed `{x, y}`).
4. **Never persist the REAL unlock.** Key it to what it was granted for:
   `scalperKey = \`${chart}|${targetKey(target)}|${mode}\``, `unlocked = unlockKey === scalperKey`. A chart switch, a new
   instrument or a mode change then re-locks it with no effect needed. Also clear it on close and on `changeTradeMode`.
5. Pass `blocked` (a reason string) when anything else owns the chart, e.g. AUTO armed or holding it (`locked(active)` on
   Renko). The same rule as the rail's ± buttons: a hand order beside an automated position fights its ledger.
6. Pass `styleText` so the footer can show a Bracket / Cover style. A bracket entry must never surprise the user.
7. Label: `C${n} · name` only when two charts are shown, else just the instrument name.

## 4. Safety rules in the window

- **REAL opens locked.** The action area dims (`opacity-30 pointer-events-none`, `aria-hidden`) under one centred
  **Unlock to trade real money** button. A small LockOpen button in the header re-locks it. The border is red and the
  badge reads `REAL · <Broker>` in REAL.
- **Hotkeys only while focus is inside the window** (`tabIndex=-1` root + `onKeyDown`, focused on open and expand).
  - Keys: B buy, S sell, X close, R reverse, ↑/↓ lots.
  - Ignored when: typing in an input, Ctrl / Meta / Alt is held, **`e.repeat` is set** (a held key auto-repeats and would
    send again), or the window is busy, locked or blocked.
  - Never use a document-level listener: a key pressed while typing elsewhere on the page must not trade.
- **Disabled reasons are spoken**, not just greyed. Priority: blocked → unsupported → contract lookup → REAL locked.
  `Sending…` while busy.

## 5. Design (the compact layout the user approved)

The first version was rejected as too tall: a two-line hero, a units hint, "live" labels, a key-help footer and greyed
Reverse / Close while flat. The approved layout is 272 px wide and about 190 px tall:

```
▌ ⋮⋮ Scalper  CRUDEOILM FUT 19 Nov   Paper  –  ×     header h-8 = drag handle
▌ Long 2L @ 103.50                      +₹260      position (coloured) over LTP + tick arrow; P&L text-2xl right
▌ LTP 105.50 ↗
▌ [−] 2 [+]                  1L  2L  5L  10L         stepper and presets one row, all h-7, presets right-aligned
▌ [↗ Buy 2L          B] [↘ Sell 2L         S]        h-10, one line, emerald-600 / red-600, text-oncolor
▌ [⇄ Reverse  R      ] [⊗ Close           X]        h-7, rendered only when a position is open
▌ Bracket · TGT 4 · SL 2 boxes                       footer only when it has something to say
```

- **One signature element:** a 4 px left edge, emerald in profit, red in loss, zinc when flat (`data-tone` for tests).
  Everything else is quiet zinc.
- **No dash for a number the window always has.** While flat with nothing booked, P&L is `₹0` (`shownPnl ?? 0`). A "—"
  was reported as a bug. Keep "—" only for a genuinely missing price (LTP before the first tick).
- **Move secondary facts into tooltips:** units per lot on the lots box, "book + live" on the P&L, the full key list on
  the window. Kbd hints stay on the buttons themselves.
- **Show Reverse / Close only while a position is open,** below Buy / Sell, so Buy / Sell never move under the pointer
  when they appear.
- **Footer** = blocked reason (amber) | `Sending…` | a non-Single style; otherwise no footer at all.
- **Tokens only** (CLAUDE.md "Theming"):
  - zinc ramp for chrome; `text-oncolor` on saturated fills;
  - no hex, no slash-opacity on neutral text; accent tints (`bg-emerald-500/15`) are fine;
  - tabular-nums on every number; focus ring `focus-visible:ring-2 focus-visible:ring-violet-500/60`;
  - `aria-label` on every icon button.
- **Layering and movement:**
  - `fixed z-40` (above charts, below `z-50` modals and toasts).
  - Drag by the header with `setPointerCapture`; elements marked `data-nodrag` (the header buttons) don't start a drag.
  - Clamp to the viewport while dragging, when reading a saved spot, and on window resize.
- **Minimise** to a pill (edge + icon + P&L + `Long 2L`) that is also draggable. A pointer-up without movement (< 4 px)
  expands it.

## 6. Live P&L

- **PAPER:** the paper ledger at the live price, already per tick.
- **REAL:** the broker book is polled every 5 s. Record the leg prices **when each poll lands** (`atPoll`, via a ref
  synced in an effect), then show
  `liveRealPnl(book.total, lots, atPoll, pricesNow, unitsPerLot) = book.total + Σ (now − atPoll) × lots × unitsPerLot`.
  - `unitsPerLot` must be the server-resolved one: MCX lots vs barrels (`dhan-crudeoil-trading`).
  - Any open leg without a price, or `book.unpriced > 0`, returns the book total unchanged. No half-priced sums.

## 7. Tests and verification

1. `npx tsc --noEmit -p .` and `npx eslint` on the touched files; unit tests for any new pure function (`node --test`).
2. **e2e** modelled on `e2e/renko-scalper.spec.ts`:
   - `page.route('**/api/**')` mocks every broker-backed call; an unmatched non-GET is refused with 599 and recorded
     (`expect(blocked).toEqual([])`).
   - The live-price mock holds a mutable `ltp`, so the test can move the price and assert the P&L text and edge tone.
   - Cases: PAPER buy → position + P&L + green edge; presets / stepper shared with the trade bar; reverse = two posts in
     order (paper close sends nothing); close → Flat; hotkey sends once and a `repeat: true` keydown sends nothing; REAL
     locked → a click and a hotkey send nothing → Unlock → Close posts `close: true` with no `action`; mode change
     re-locks; minimise → reload keeps it minimised → expand → close.
   - **Never add a "valid REAL order" case that could reach a live route.**
3. **Look at it** in all three themes before handing off. Use a temporary spec that sets `localStorage['dhan-theme']` to
   dark / light / beige with `addInitScript`, screenshots `getByTestId('scalper-window')` flat, long and REAL-locked, then
   is deleted. Read the PNGs back. The user judges this window from screenshots.

## 8. Running and shipping (traps hit on 2026-11-06)

- **Check what :3000 is** before running e2e against it (`ps -eo cmd | grep next`):
  - **`next start`** is a production build, so tests against it exercise the *old* code (every new-button test timed
    out). Run `npm run test:e2e` without `E2E_PORT`: Playwright starts `next dev` on :3100, which only touches
    `.next/dev`, not the production build.
  - **`next dev`** on :3000: use `E2E_PORT=3000` and never start a second dev server (CLAUDE.md, Dashboard browser tests).
- **Deploying = `npm run build` then restarting `npm start`.** Before stopping the server, confirm nothing real is live:
  open rows in `debug/{renko,pnf}_auto_state.json`, working rows in `debug/{renko,pnf}_resting_state.json`,
  `debug/{kotak,zerodha}_server_guards.json`, and non-closed slices / pairs in `debug/price_ladder_state.json`. The server
  runs AUTO, guards and the ladder watcher, which stop with it.
- **Restarting stops bridges the server spawned** (`pnf_ws.py` respawns when a page next asks for prices). Say so in the
  hand-off.
- `npm test` has had one unrelated failure (`lib/nseHolidays.test.ts`), and `renko-auto` / `straddle-pnf-rail` 13
  pre-existing e2e failures (as of 2026-11-06). Compare against the untouched tree (`git stash -u`) before blaming the
  change.

## Related

`dhan-pnf-chart-trading-ui` (the Renko / P&F page's REAL cues, rail lock and prefs; this window follows them),
`dhan-order-tickets` (server-side caps, contract resolution), `dhan-commit-on-blur`, `dhan-a11y-controls`,
`dhan-terminal-polish` (density), `dhan-theme-tokens`, `dhan-broker-positions` (P&L and exit sizing off a broker book),
`dhan-terminal-position-ownership` (when a page holds several positions on one contract, a whole-contract Close is wrong:
size by the owner's ledger instead).

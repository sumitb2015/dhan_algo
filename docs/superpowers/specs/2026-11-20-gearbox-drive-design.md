# Gearbox Drive — live options scalping page (design)

Date: 2026-11-20 · Status: awaiting approval · Source idea: the "Gearbox Drive" artifact
(https://claude.ai/artifact/N422Ph3ycSVibQJnjeN5Q2), a game on synthetic NIFTY prices.

## 1. Intent

Turn the Gearbox Drive game into a real dashboard page, `/gearbox`, that the user scalps from.
The page reads the **CRUDEOIL / CRUDEOILM near-month future** through the game's instrument
cluster (gear, speed, RPM, altitude, lamps, road scene) and lets the user **click** to trade
**options** on that commodity, in SIM (paper) or REAL money. The user decides every trade; the
page never trades on its own. Crude first; other underlyings later.

Why: the gearbox makes the EMA trend state readable at a glance while scalping; the user wants
to act on it with one click instead of switching to another terminal.

## 2. Goals, non-goals, anti-goals

Goals
- Live gearbox on closed bars of the crude future (1 / 3 / 5-minute, default 5).
- One-click Long / Short / Exit / Reverse on options, SIM and REAL (REAL: Dhan, 1 lot, in v1).
- Own ledger: the page knows exactly what it opened and only ever closes that.
- Ghost driver shown alongside as a comparison (what the rules would have done), paper only.
- End-of-session square-off that happens even with the tab closed.

Non-goals (v1)
- No automatic trading. The ghost never sends an order. (An automated version, if ever wanted,
  belongs in `/algo-lab` with a backtest first.)
- No NSE underlyings, no futures trading, no Kotak / Zerodha REAL yet (see §6).
- No server-side stop-loss / target / trailing in v1 (see §7, optional browser-only SL/target).
- No backtest page. The ghost's rules are unvalidated and labelled so.

Anti-goals (a failure even if it works)
- A second order engine: any order code that bypasses the existing PnF order layer.
- An exit that touches a position this page did not open (another page, a manual trade).
- A REAL order from a hotkey repeat, a stale price, or a strike picked from a stale future price.
- Lots-vs-barrels mix-up on any broker (wrong size or P&L ×10 / ×100).
- Hard-coded colours that break dark / white / beige themes.

## 3. Approaches considered

- **A. Dedicated `/gearbox` page on the existing PnF order layer (chosen by the user).** Own page,
  keeps the game's look; orders go through `placePnfMarket` / `resolvePnfLegs` / `brokerLegs`
  (`lib/pnfAutoOrders.ts`, `lib/pnfOrderServer.ts`), already used by `/renko` and Signal Orb and
  already handling MCX options units for Dhan and Kotak. Own server-written ledger, Signal Orb
  style.
- B. Gearbox panel inside `/renko`, reusing its trade bar, Scalper window and MTM guard. Rejected:
  `/renko` is dense, the road scene would shrink to a strip, and its CE/PE map is index-only.
- C. A page with its own new order route. Rejected: a new real-money path relearns every rule
  (unknown outcomes, MCX units, exit sizing).

## 4. Data

- **Signal instrument:** the near-month CRUDEOIL or CRUDEOILM future (picker on the page). Bars via
  `usePnfFeed` (`components/straddlePnf/usePnfFeed.ts`) on a `futures` target, as Signal Orb does:
  1-minute history + live price folded into the forming minute. Resample to the chosen timeframe
  on the IST clock; compute only on **closed** bars (`closedBars` pattern from `lib/signalOrb.ts`).
- **Warm-up:** EMA200 needs ≥ 200 closed bars of the chosen timeframe (≈ 1,000 one-minute bars at
  5-min, about 1.2 MCX sessions). The feed already loads several sessions; show "warming up"
  until there are enough bars, never a partial gear.
- **Option prices:** the option being held (and the candidate ATM CE / PE) priced from the shared
  live options bridge / `usePnfFeed` on an `options` target. Prices are Dhan-only.
- **Session:** `lib/mcxSession.ts` (`open`, `close`, `autoExit`, US-DST aware). VWAP resets at the
  MCX open. Holidays from the MCX calendar the repo already uses.
- Header shows the `DATA: YYYY-MM-DD` chip and the feed's freshness; a stale feed (no tick for
  > 10 s in session) disables REAL buttons.

## 5. Gearbox maths (pure module `rs_dashboard/lib/gearbox.ts` + tests)

Port the artifact's `build()` logic, rule for rule, as pure functions over closed bars:
- EMA 9/20/50/100/200 on close; ATR(14, Wilder); session VWAP (hlc3 × volume, reset at open);
  Supertrend(ATR 14, ×3). Reuse `lib/indicators.ts` where an identical formula exists (see the
  `dhan-indicators` skill); don't write a private copy if one matches.
- Mode: +1 after 2 closes above EMA200 and EMA200's 10-bar slope ≥ −0.15 ATR; −1 mirrored;
  0 (fog) within 0.3 ATR of EMA200 or slope disagreeing.
- Gear = 1 + count of EMA 9/20/50/100 beyond price in the mode's direction; N in fog.
- Speed = EMA9 3-bar slope in bp per bar; acceleration = speed − speed 3 bars ago;
  RPM = |close − EMA9| / ATR (over-rev > 2); altitude = (close − EMA200) / ATR.
- Setup / Shift-up signal exactly as the artifact (armed after gear 4–5 then a drop to 2–3; fires on
  the next upshift if VWAP and Supertrend agree, mode older than 3 bars, inside the entry window).
- **MCX entry window for the ghost:** from open + 15 min to `autoExit` − 40 min (builder may tune
  in one constant). Ghost exits: stop (tighter of 10-bar swing and Supertrend, trailed at gears
  4–5), mode flip, gear collapse to 1, session square-off. Two fixes from the review of the game:
  the stop is checked against the bar's **low / high**, not the close; and a mode going to fog does
  **not** exit (same as the game, but now written into the on-page rules).
- Unit tests: a fixture series with the artifact's own output (port its generator with a fixed
  seed) to pin parity, plus closed-bar, warm-up and session-reset cases.

## 6. Trading

**Direction map** (per underlying, saved, locked while a position is open):
- Long (↑) default **BUY ATM CE**; Short (↓) default **BUY ATM PE**.
- Each direction can be changed to BUY / SELL, CE / PE, strike offset −3…+3 (`+N` = N strikes OTM
  for either type), expiry Nearest or a listed one. A ⚠ marks a leg that gains on the other
  direction's move (allowed, shown). SELL legs show a "margin, unlimited risk" note.
- **The strike is picked on the server at the click** from a fresh futures price
  (`atmStrike` + `strikesFor`, `lib/pnfContracts.ts`), using the futures contract that the chosen
  option expiry references. Stale or missing future price → order refused.

**Buttons and position model** — one position per underlying, like the game:
- Flat + Long/Short → open that direction's leg. Same direction while held → ignored (no pyramiding
  in v1). Opposite direction → **Reverse**: send the exit, and open the new leg only once the exit
  is confirmed filled; an unknown exit stops the reverse.
- Exit → close the held leg. Lots stepper (1…max) with presets; default 1.
- Hotkeys ↑ / ↓ / X / Space (pause scene only); ignore key repeat; inactive while a field has focus.
  In REAL, hotkeys need the REAL arm (below) and the same confirm the buttons use.

**Brokers (decided 2026-11-20):** REAL is **Dhan only** in v1, via the PnF order layer (Dhan MCX
quantity = lots). Kotak stays off until a live 1-lot round trip confirms its MCX **option** unit
(barrels); the broker code path is kept broker-generic so Kotak is a switch, not a rewrite.
Zerodha off (MCX units unconfirmed from this machine). Product: intraday; no overnight carry.

**Caps (decided 2026-11-20):** new source tag `gbx`. REAL: **1 lot** per order and per position,
on both CRUDEOIL and CRUDEOILM, until it has run live (as Signal Orb's `orba`). SIM: up to 10 lots.
Add `gbx: 1` to `SOURCE_QTY_CAPS_MCX` (`lib/dhanPlaceOrder.ts`); the ledger enforces the same cap
inside its lock. Server rejects, never clamps.

**SIM / REAL:** SIM by default. REAL is armed once per page load (not persisted), shows the REAL
banner, and is tied to underlying + broker; changing either disarms. SIM fills at the option's
live LTP at the click (ask if the bridge has depth, else LTP); REAL P&L re-prices from the actual
traded price (`dhan-fill-price-pnl`).

## 7. Server, ledger and exits

Follow Signal Orb's server pattern (`lib/signalOrbServer.ts`, `lib/signalOrbLedger.ts`):
- `debug/gearbox_state.json`, **one writer** (`lib/gearboxServer.ts`), all mutations on one
  in-process chain (`globalOnce`). Rows: `sending → open → closing → closed`, plus `failed`,
  `unknown`. A row is written **before** its order is sent.
- Routes: `app/api/gearbox/state` (GET ledger, POST config ops: direction map, lots, broker,
  timeframe) and `app/api/gearbox/trade` (POST `{action: open|exit|reverse, dir, decisionPrice,
  mode, broker, underlying}`). The browser names only what to do; contract, strike, quantity and
  exit size come from the server and the ledger.
- Exit size = this ledger's own open quantity, capped by what the broker still shows in that
  direction (own-units-only, as `/renko`). Unknown outcome → row `unknown`, never resent; reconcile
  from the order book by correlation id.
- **Square-off watcher** started from `instrumentation.node.ts`, idle with no open row: at
  `mcxSession().autoExit` it exits every open REAL and SIM row through the same exit path, tab open
  or not. Logged on the page.
- **Optional SL / target** per trade in option-premium points, run in the **leader browser tab
  only**, labelled "browser-only — closes nothing if this tab is closed". Commit-on-blur inputs.
- Daily limits (optional, blank = off): max loss ₹, max trades. Hitting one blocks new entries
  for the day; exits still work.

## 8. Page

Layout follows the artifact, rebuilt in the dashboard's theme tokens (no hex in components; the
canvas reads colours from CSS variables so it flips with dark / white / beige):
1. Sticky header: icon, title, underlying + timeframe + broker pickers, SIM/REAL switch and arm,
   DATA chip, feed freshness, session clock with time to square-off.
2. Road scene (canvas): road from the future's price, fog for the future, sky by mode, car with
   LONG/SHORT flag. Must stay cheap: redraw on bar close and on price change, throttled.
3. Cluster: speed, shifter, RPM gauges; altitude and acceleration bars; lamps VWAP, Supertrend,
   Setup, Shift up, Over-rev.
4. Trade strip: ↑ Long, Exit, ↓ Short, lots stepper, direction map summary (e.g. "↑ BUY 9450 CE ·
   ↓ BUY 9450 PE"), live option prices, held leg with entry / LTP / P&L ₹.
5. Score: You (₹, from the ledger, today, current mode) vs Ghost (futures points, paper,
   labelled "rules unvalidated").
6. Trip log (gear by bar) and event log; today's trades table (standard dashboard table style).
7. Rules section, as in the game, with MCX times.

Optional chime on Shift-up via `lib/alertSound.ts` (leader tab, muted by default).
Sidebar link under the live / intraday group. Desktop only.

## 9. Tests and docs

- `lib/gearbox.test.ts` (maths + parity), `lib/gearboxLedger.test.ts` (ops, caps, reverse
  sequencing, unknown handling, own-units exit, square-off), cap entries in the existing
  `dhanPlaceOrder` / `kotakOrderRules` tests.
- Playwright `e2e/gearbox.spec.ts` with every broker call mocked (SIM flow, REAL arm, reverse,
  refused stale price). **No "valid REAL order" case** against a live API.
- `docs/GEARBOX_GUIDE.md` user guide; CLAUDE.md route entry and guide pointer.

## 10. Settled after the builder check (my calls, flagged for review)

- **Server-side prices.** Signal Orb trusts the browser's price and has no square-off watcher, so
  it is the ledger pattern only. Prices on the server come from Fresh Money's server WebSocket
  helpers (`wsWant` / `wsPrice` in `lib/freshMoneyWs.ts`, as `freshMoneyExitServer.ts` uses):
  the server subscribes the signal future and every held option while a row is open, so the
  strike pick and the tab-closed square-off (SIM close price too) never depend on the browser.
  The browser's `decisionPrice` is recorded for slippage display only. No fresh server price
  (> 10 s old) → open refused; a square-off with no price still sends REAL, and closes SIM at
  the last good price, logged.
- **Which future.** Use `spotInstrument(underlying, optionExpiry, true)` (`lib/freshMoneyWs.ts:93`):
  the first future expiring on or after the option expiry. The signal chart reads that same
  future, so near rollover the chart switches with the options; the gearbox shows "warming up"
  if the new future has too few bars.
- **Other pages' closes.** Add Gearbox's open REAL units to `placePnfMarket`'s close hold-back
  (`lib/pnfAutoOrders.ts:96-104`), the same way Signal Orb's are reserved, so a P&F/Renko
  square-off on the same strike cannot close them. Price Ladder / scalper exit paths are not
  changed in v1; the guide says so.
- **Reverse confirm.** After the exit is placed, poll that order's status (`readOrder`) every
  1 s for up to 10 s. Traded → open the new leg. Rejected → stop, keep the old row open.
  Timeout → row `unknown`, reverse abandoned, never resent.
- **Bars without high / low.** Use the close for missing `h` / `l` (ATR then falls back to
  close-to-close range); history bars from Dhan carry both, so this is only the live edge.
- `placePnfMarket`'s `tagOverride` type widens to `'orba' | 'gbx'`.
- Kotak MCX **option** units are unconfirmed against a live fill (`lib/pnfOrderServer.ts:98-101`),
  hence Dhan-only REAL in v1.

## 11. Left to the builder

File split inside `components/gearbox/`, the exact resampling helper reused, canvas drawing details,
throttle intervals, constant names, whether the ghost recomputes incrementally or per bar close.

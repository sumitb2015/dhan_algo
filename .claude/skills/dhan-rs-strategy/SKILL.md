---
name: dhan-rs-strategy
description: Use when touching the RS Strategy scanner (/rs-strategy) — rs_dashboard/lib/rsStrategyCore.ts (pure engine), lib/rsStrategy.ts (Nifty-500 scan + cache), app/api/rs-strategy/route.ts, components/RsStrategyPage.tsx, lib/indicators.ts's supertrendSeries, or lib/rsStrategy.test.ts. Covers the RS-55 + Supertrend(10,2) + RSI>50 Buy/Hold/Sell/Wait state machine, the weekly "mother chart" filter (Monday-dated resample, why not 2-hour), the node-test import-extension split, the bounded/in-flight server cache and the Recalculate-vs-dataLoader-cache caveat. Not for the other RS formulas (dhan-rs-ranking lists all six and says not to unify them), RRG (dhan-rrg), the Scanner's own RS gates (dhan-equity-technical-screener), or the Supertrend copies' ATR conventions (dhan-indicators).
---

# RS Strategy (`/rs-strategy`) — Nifty 500 RS-55 + Supertrend(10,2)

A **scanner with a manual Buy/Sell ticket**: the signals themselves place nothing and there is no Python strategy behind it; orders happen only when a person clicks Buy/Sell and confirms in the ticket (see "Buy / Sell tickets" below). It is a port of
the bharatTrader "Relative Strength" TradingView indicator (Learn2Trade session 31, Vivek Bajaj /
StockEdge) combined with a Supertrend and RSI gate. Vault notes (history, reasoning, rejected
options, open follow-ups) are in `wiki/strategies/rs-55-supertrend.md` of the Dhan Algo Brain vault
— this skill is only how the code works and what bites.

> **Not validated.** No backtest exists for this rule set. Do not describe a Buy as an
> "edge" in UI copy, and do not wire it to order placement without a backtest first (the
> repo's other unvalidated strategies gate `--live` behind an acknowledgement flag for the same reason).

## Files

| File | Role |
|---|---|
| `lib/rsStrategyCore.ts` | **Pure** engine: `isBuy`, `isSell`, `resampleWeekly`, `evaluateStock`, types, `DEFAULT_PARAMS`. No `dataLoader` import. |
| `lib/rsStrategy.ts` | Server wrapper: `runRsStrategy()` reads the Nifty-500 CSVs, evaluates, caches. Re-exports the core. |
| `app/api/rs-strategy/route.ts` | `GET ?period=&rsiMin=&refresh=true` → `{success, data}`. Params clamped (period 5–250, rsiMin 0–90). |
| `components/RsStrategyPage.tsx` + `app/rs-strategy/page.tsx` | UI. Sidebar link is in the **Trading** group of `components/Sidebar.tsx`. |
| `lib/indicators.ts` `supertrendSeries()` | Wilder-ATR Supertrend returning `{line, dir}[]` (the scanner route's copy only returns a boolean). |
| `lib/rsStrategy.test.ts` | `node --test` suite for the core. |

## The rules

- **RS** = `(close / close[n]) / (nifty / nifty[n]) - 1`, `n = 55` **bars** (Pine default is 123; Vivek uses 55 ≈ 3 months and a Fibonacci number). Benchmark = `readNifty50Index()` (NIFTY 50 series, "NSE:NIFTY"). Stored and shown as the **plain ratio**, exactly as TradingView and StockEdge do (`0.46` = +46%, 2 decimals; StockEdge's "strongly outperforming" = `≥ 0.10`). It was briefly shown ×100 as a percent and read as a mismatch against the chart (ENGINERSIN: 45.81 vs chart 0.46) — keep it a ratio.
  The `n` bars are counted over dates the stock **and** the index both traded (`alignByDate`), so a halted day is skipped, not zero-filled.
- **Supertrend** (period 10, multiplier 2) = TradingView `ta.supertrend(2, 10)` — note TV's argument order is `(factor, atrPeriod)`. Wilder ATR.
- **RSI** = Wilder `rsiArray(closes, 14)`.
- **Buy**: RS > 0 **and** Supertrend bullish **and** RSI > `rsiMin` (default 50; `0` disables). **Sell**: RS < 0 **and** Supertrend bearish. Exit needs *both* negative — Vivek: "if RS strong and Supertrend negative, don't exit".
- **State machine** (walked bar by bar from the first bar all three indicators exist): `long` turns on at a Buy, off at a Sell, otherwise unchanged.
  - `BUY` = long and the buy rule holds now · `HOLD` = long but the buy rule no longer holds and no Sell yet · `SELL` = flat and the sell rule holds · `WAIT` = flat, no buy yet.
  - `daysInSignal` ("Bars in state" in the UI) counts the current `long`/flat phase, so BUY→HOLD keeps counting.
  - `rsRising` = RS strictly higher on 3 consecutive bars (`ta.rising(rs, 3)` semantics) — display filter only, not part of the signal.
- **Weekly** (`weekly` field, "Weekly long" chip = weekly state is BUY or HOLD): the same function run on weekly bars resampled from daily. Needs ≈70 weekly bars (`period + stPeriod + 5`), else `null` and the chip excludes the stock.

## Gotchas (each one was hit or caught in review)

1. **Weekly bars are dated by their Monday, not their last trading day.** A stock halted on Friday would otherwise carry a different date from the index and fall out of `alignByDate`, silently dropping that week from the weekly RS. `resampleWeekly` clones rows (`{...r, date: key}`) so the input is not mutated. The current week is a **partial** bar (as on a live TradingView weekly chart), so a weekly signal can flip mid-week.
2. **Why weekly and not "2-hour"** (the video's "mother and daughter"): the Dhan-only data set is daily CSVs. Intraday history for 500 stocks does not exist locally, and the repo rule is Dhan-only data. A 2-hour timeframe would be a new data pipeline, not a filter.
3. **`rsStrategyCore.ts` must import with explicit `.ts` extensions** (`from './rs.ts'`). `node --test lib/*.test.ts` runs without a bundler, so extensionless imports throw `ERR_MODULE_NOT_FOUND` — and `dataLoader` can't be imported there at all. That is the whole reason the core is split from `rsStrategy.ts`. `tsconfig` has `allowImportingTsExtensions`. Keep the core free of `dataLoader`/`fs`.
4. **The client imports the core, not the server wrapper** (`DEFAULT_PARAMS`, types) so no server code lands in the bundle. Defaults (`55`, RSI `50`) live only in `DEFAULT_PARAMS`; the route and the page both read them.
5. **Hold is derived from the stock's whole history** and can reflect a buy from months ago. If you want "bought in the last N bars", that is a new rule, not a bug.
6. **Latest-date handling.** `modalDate()` picks the most common last date and drops stocks on any other date (halted/delisted, or one bad future-dated row — a plain `max` would drop everyone). If the index series lacks today's bar, every stock's last RS-bearing bar falls back a session and the DATA chip shows that date.
7. **Server cache**: key = `JSON.stringify(params)`, TTL 5 min, **max 6 entries** (period and rsiMin are user-driven, so unbounded keys would be a memory leak), and an `inflight` map so concurrent identical requests share one scan. A forced `refresh=true` that arrives while a scan is in flight joins it.
8. **Recalculate re-runs the scan, but `dataLoader` has its own 5-minute CSV cache** (`readStockCSVAsync`). A manual Recalculate right after a data sync can show data up to 5 min old. Do **not** "fix" this by calling `clearCache()` from the route: it also deletes the breadth daily-cache file, hurting the Breadth page. The sync routes (`refresh/`, `backfill/`) already call it.
9. **Client fetch**: `cachedFetch(url, 5 min)` for normal loads; Recalculate uses a raw `fetch(...&refresh=true)` then `setCached(base, json)` so the session cache doesn't keep serving the pre-recalc result. A `seq` ref guards out-of-order responses (toggle RSI / change period quickly) per `dhan-polling-guards` §4. The RS-period input commits on blur/Enter only (`dhan-commit-on-blur`).
10. **The RSI chip refetches** (it changes the server's state machine); the other three chips (`RS ≥ 0.10`, `RS rising 3d`, `Weekly long`) are client-side filters over the same payload.
11. **Supertrend copies**: `supertrendSeries` is the same Wilder algorithm as the boolean copy in `app/api/scanner/route.ts:130` and matches `lib/intraday_signals.supertrend` on direction. Don't add another independent variant; see `dhan-indicators`.

## Don't unify with the other RS formulas

`dhan-rs-ranking` lists the repo's independent RS formulas. This is a fifth, deliberately a
*rolling single-lookback* ratio (n=55 bars, signed around 0) used for a state machine — not a
percentile rank (`rs.ts` scanner), not JdK (`rrg`), not Mansfield-vs-Nifty50-with-MA (`sectorBreadth`),
not the weighted composite in `momentum_investing`. It reuses only `alignByDate` from `lib/rs.ts`.

## Verifying a change

```bash
cd rs_dashboard
npm test                      # rsStrategy.test.ts: formula, HOLD/WAIT, weekly, Monday dating, rsRising
npx tsc --noEmit && npx eslint components/RsStrategyPage.tsx lib/rsStrategy*.ts app/api/rs-strategy/route.ts
python3 ../.claude/skills/dhan-page-theme/scripts/audit_pages.py | grep rs-strategy
```

Independent numeric check (what was done at build time; RS and Supertrend matched to every printed
digit on RELIANCE/TCS/INFY): recompute RS-55 and a Wilder Supertrend(10,2) in pandas from the same
CSVs (`venv/bin/python`; `Daily_Historical_Data_Fresh/<SYM>_Daily_2Y.csv` + `Historical Data/NIFTY_50_Daily_5Y.csv`)
and compare against the engine's last bar. The `_2Y` in the file name is misleading — the files hold ~7.5 years.

Browser check: the dashboard needs a session cookie (`proxy.ts`). For local testing sign
`"<uuid>.<hmac-sha256(uuid, COOKIE_SECRET)>"` with `lib/auth.ts`'s secret and set `dhan_session`
(see CLAUDE.md on 307/401). Verified 2026-10-01 in dark/light/beige. Known cosmetic issue, not specific to
this page: at 390 px the shared NavBar buttons overflow the header (Stage Screener is worse).
Reference counts on 2026-09-30 data: Buy 55 · Hold 145 · Sell 229 · Wait 70 (499 scanned; 87 Buy with RSI off; weekly long ≈ 253). Chart cross-check 2026-10-01: ENGINERSIN RS-55 `0.4581` = TradingView's `0.46`, base bar 2026-07-15 (the indicator's "RS-55 reference" label), Supertrend 288.72, RSI 69.43 — all match.

## In-page guide

The header **Guide** button opens `components/RsStrategyGuide.tsx`, which renders `docs/RS_STRATEGY_GUIDE.md`
(read per request by `app/rs-strategy/page.tsx` and passed in as text), so the repo doc and the in-app help are one
source. Rendering uses `lib/miniMarkdown.ts` — a small parser to a data structure (never raw HTML) that supports only
headings, paragraphs, `-` lists, `>` quotes, tables, `---` and `**bold**`/`*italic*`/`` `code` ``. If you use other markdown
(links, numbered lists, images) in the guide, extend the parser and its test first; `lib/miniMarkdown.test.ts` parses the real
guide and fails on an unrecognised table or leftover `**`. **When you change a column, filter, rule or order limit, update the guide.**

## Buy / Sell tickets (REAL MONEY)

Each row has Buy and Sell buttons that open `components/EquityOrderModal.tsx`; a **Held** column and an
**In portfolio** chip show what the account already owns. Dhan only (no Zerodha/Kotak). Read
`dhan-order-tickets` before changing any of it.

| Piece | Where |
|---|---|
| Pure rules (caps, tick rounding, limit band, delivery-sell check) | `lib/equityOrder.ts` + `lib/equityOrder.test.ts` — explicit `.ts` imports, no fs/fetch, so `node --test` loads it |
| Symbol → NSE security id, tick (paise ÷ 100), series | `lib/equityMaster.ts` (parses `master_list.csv`, cached per mtime). The browser never sends a security id |
| Holdings + today's NSE_EQ positions | `lib/dhanEquityPortfolio.ts` (`readEquityPortfolio` for display, `fetchHoldingsLive` for order gating) |
| Live price | `lib/dhanEquityQuote.ts` via the shared quote lane (`pacedQuoteCall`) |
| Routes | `app/api/equity-order/route.ts` (GET = ticket context, POST = place) and `app/api/equity-order/holdings/route.ts` (table read, 10 s cache) |

**Server-side limits** (re-checked on POST, the modal only mirrors them): quantity ≤ 10,000, order value ≤ ₹5,00,000 (limit price, or live price for MARKET), LIMIT price within ±20% of the live price and rounded to the tick, **no short-selling: a SELL may only close what the account owns** — CNC sell ≤ sellable holdings (fresh `/holdings` read), INTRADAY sell ≤ today's open long MIS position (fresh `/positions` read). Holdings never authorise an MIS sell and an MIS position never authorises a CNC sell. Shares already committed to **open sell orders** (`pendingSellQty`: unfilled remainder of TRANSIT/PENDING/PART_TRADED/CONFIRM orders, same product) are subtracted, and sells of one security run one at a time (`withSellLock`) so two quick sells cannot both pass against the same untouched position and become a short. If any read fails, nothing is sold. The row's Sell button is also disabled when the Held data shows nothing owned (UI convenience only; the server is the guard). Products: `CNC` (Delivery) and `INTRADAY` (MIS); order types MARKET/LIMIT; optional AMO (`afterMarketOrder` + `amoTime: OPEN`). No stop-loss/bracket orders. Fails **closed**: no live price or unreadable holdings ⇒ nothing is ordered.

Gotchas:
1. **Idempotency**: the client mints one `clientKey` per ticket; the server keeps the in-flight/booked result for 2 min so a double click or retry returns the first result instead of a second order. Plain rejections are forgotten and the client mints a fresh key, so a corrected retry works. a non-JSON reply (gateway page) is also treated as `unknown`, never as a rejection; an accepted order Dhan reports as REJECTED/CANCELLED/EXPIRED is shown as a warning, not a success; `unknown` outcomes (timeout / 5xx) are reconciled by `correlationId` via `GET /orders/external/{id}`; if still unknown the modal locks and tells the user to check the order book — never auto-retry.
2. **Dhan spells it `availabelBalance`** in `/fundlimit`; holdings `tradingSymbol` may carry a `-EQ` suffix, so rows are matched by `securityId`.
3. **Held shows holdings and today's positions separately, never summed.** Dhan can list a same-day CNC buy as a position before it reaches holdings (T+1), so a delivery SELL of a stock bought today is blocked by the sellable-holdings rule until it settles.
4. Every column header sorts (Held, Signal and Weekly by rank, a stock with no weekly signal always last, ties by symbol). Typed qty/price commit on blur/Enter, Escape reverts an uncommitted edit and a second Escape closes the window, and Submit stays disabled while a draft is uncommitted (`dhan-commit-on-blur`). The ticket fetch uses a `cancelled` flag as its out-of-order guard; the page polls holdings every 60 s while visible and re-reads (now and +4 s) after an order.
5. **Testing without risk**: never click Confirm against a live account to "see it work". Reject-path POSTs (bad qty, far limit, over cap, delivery sell of nothing) are safe and exercise the server rules; for the success/unknown/rejected UI states mock `/api/equity-order` in the browser. Verified that way on 2026-10-01 — **no real order has been placed through this ticket yet**; do a 1-share far-below-market LIMIT (or AMO) first.

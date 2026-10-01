---
name: dhan-rs-strategy
description: Use when touching the RS Strategy scanner (/rs-strategy) — rs_dashboard/lib/rsStrategyCore.ts (pure engine), lib/rsStrategy.ts (Nifty-500 scan + cache), app/api/rs-strategy/route.ts, components/RsStrategyPage.tsx, lib/indicators.ts's supertrendSeries, or lib/rsStrategy.test.ts. Covers the RS-55 + Supertrend(10,2) + RSI>50 Buy/Hold/Sell/Wait state machine, the weekly "mother chart" filter (Monday-dated resample, why not 2-hour), the node-test import-extension split, the bounded/in-flight server cache and the Recalculate-vs-dataLoader-cache caveat. Not for the other RS formulas (dhan-rs-ranking lists all six and says not to unify them), RRG (dhan-rrg), the Scanner's own RS gates (dhan-equity-technical-screener), or the Supertrend copies' ATR conventions (dhan-indicators).
---

# RS Strategy (`/rs-strategy`) — Nifty 500 RS-55 + Supertrend(10,2)

A **read-only scanner**: it places no orders and has no Python strategy behind it. It is a port of
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

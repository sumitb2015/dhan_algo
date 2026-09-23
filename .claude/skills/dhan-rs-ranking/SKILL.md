---
name: dhan-rs-ranking
description: Use when working on the shared Relative Strength (RS) primitives — lib/rs.ts's computeRSLine, computeCurrentRS, effectiveLookback, assignRSScores, buildRSResult — and their direct consumers (RS Scanner / Leaderboard at /rs-scanner). Covers the degraded-lookback fallback for recent listings, the percentile/A-B-C-D rating, the Stage-2 gate, and — critically — that this is ONE of four independent RS formulas in the codebase (RRG, Scanner, and Python's momentum_investing each compute their own). Not for RRG's own JdK-style math (dhan-rrg), Scanner's own rolling variant (dhan-equity-technical-screener), or Sector Breadth's own Mansfield-vs-Nifty50 variant (dhan-sector-breadth) — read this skill's "Four RS formulas" section before touching any of those four files to avoid unifying formulas that are deliberately different.
---

# RS Ranking (`lib/rs.ts` — the shared primitives)

## Four independent RS formulas exist in this codebase — read this before changing any of them

| Where | Formula shape | Purpose | Skill |
|---|---|---|---|
| `lib/rs.ts` `computeCurrentRS` | Mansfield-style, single lookback: `(S_t/S_base)/(I_t/I_base) - 1` | RS Scanner / Leaderboard peer ranking | this skill |
| `app/api/rrg/route.ts` | JdK-standardized: `100 + 10*(rsRatio - prevTrend)` + a second rolling-mean/std variant | RRG rotation quadrant chart | `dhan-rrg` |
| `app/api/scanner/route.ts` | Own rolling RS-ratio series → `rsRising20`/`rsAboveMA` boolean gates | Scanner filter/screen | `dhan-equity-technical-screener` |
| `lib/sectorBreadth.ts` | Mansfield-vs-Nifty-50-specifically, 50-bar window vs its own 20-bar average | Sector Breadth's per-stock RS | `dhan-sector-breadth` |
| `lib/momentum.py` `composite_rs` | Weighted multi-lookback sum, `Σ w_n*[(S_t/S_{t-n})/(I_t/I_{t-n})-1]`, weights `[(10,.10),(21,.20),(63,.40),(126,.30)]` | `momentum_investing` strategy's portfolio ranking (Python, not TS) | — (see `dhan-new-strategy`) |

These are **deliberately different tools for different jobs** — a single-index RS score, a
rotation-momentum chart coordinate, a boolean screener gate, and a portfolio-ranking composite
respectively. If a session is asked to make two of these "agree," the premise is almost
certainly wrong — check which consumer is actually being debugged and why its number looks off,
rather than trying to converge the formulas.

## `lib/rs.ts`'s own RS ratio (`computeRSLine`/`computeCurrentRS`, lines 82-138)

`computeCurrentRS(aligned, lookback=252)` — Mansfield-style: `(stockClose[-1]/stockClose[-1-lb])
/ (indexClose[-1]/indexClose[-1-lb]) - 1`, where `100`/`0` means inline with the benchmark and
positive means outperforming. `alignByDate()` (`rs.ts:63-76`) is the shared date-join used by
this file **and** by RRG/Scanner (their only shared import) — a stock/index pair with a gap in
one series drops that date from both, silently.

## `effectiveLookback()` — degrade, don't zero (`rs.ts:111-120`)

```ts
function effectiveLookback(alignedLength: number, lookback: number): number {
  return Math.min(lookback, alignedLength - 1);
}
```
A recently-listed stock (IPO, post-demerger relisting) has far less than 252 days of aligned
history. Without this clamp, `computeCurrentRS` would index out of range or silently return `0`
— a fake "exactly inline with index" reading that would corrupt the stock's percentile rank
(pulling it toward the middle of the pack instead of reflecting its real short-history RS).
`computeCurrentRS` still requires `lb >= 20` (line 133) or returns `0` — the floor exists, it's
just much lower than the 252-day default.

**This is the opposite tradeoff from `dhan-equity-movers`/`dhan-market-breadth`**, which
*exclude* a stock outright below their own minimum-history thresholds (22 rows) rather than
degrading a calculation. Both are intentional, per-feature decisions — don't try to normalize
the codebase toward one policy or the other.

`buildRSResult()`'s trend/sparkline array (`rs.ts:236-249`) reuses this same degraded `lb` so a
short-history stock still gets a populated 20-point sparkline and a real `isRSNewHigh` check
instead of an empty one (explicit comment at `rs.ts:234-235` on why).

## `assignRSScores()` — percentile + letter grade + ordinal rank (`rs.ts:198-213`)

Sorts the peer set ascending by `rsRatio`; `rsScore = round(i/(n-1)*100)` (0 = weakest, 100 =
strongest); rating bands `A>=80, B>=60, C>=40, D<40`; `rsRank = n - i` (rank 1 = strongest). A
single-stock peer set (`n<=1`) gets a hardcoded `rsScore=50` to avoid a `0/0` division.

## `buildRSResult()`'s bundle (`rs.ts:216-345`) — three metrics beyond the base RS ratio

- **`isStage2`** (`rs.ts:293`): `isAboveSma50 && isAboveSma200 && sma50>sma200 &&
  pctFrom52WHigh >= -25` — Minervini-style Stage 2 gate, requires `rawStockRows.length >= 20`
  to compute at all (else all fields default false/undefined).
- **`volSurge`** (`rs.ts:297`): `volume / vol20Avg`, defaults to `1.0` when `vol20Avg` is 0 or
  rows are insufficient — this is the **third** independent volume-spike metric in the codebase
  (alongside Movers' `volumeRatio` and Sector Breadth's turnover-weighted A/D score — see
  `dhan-equity-movers`).
- **`mansfieldRS`** (`rs.ts:300-315`): a *second*, distinct RS number computed inside this same
  file — `(currRatio - avgRatio) / avgRatio * 100` where `avgRatio` is the mean of up to 252
  days of `(stockClose/indexClose)*1000` ratios (not the same window as `computeCurrentRS`'s
  single-lookback ratio). Don't confuse `rsRatio` (the field most consumers chart) with
  `mansfieldRS` (a smoothed deviation-from-own-average reading) — they answer different
  questions even within this one file.

## `pctChange1D`/`pctChangeByDate`/`shiftDate` in this file are a fourth period-return style

`rs.ts` has its own `shiftDate`-based calendar period returns for `priceChange1W/1M/3M/1Y`
(used in `buildRSResult`'s output, distinct instances of these functions from the ones in
`app/api/movers/route.ts` — same calendar-shift-then-snap-backward *shape*, but a separately
maintained copy, not a shared import). If you fix a bug in one, check whether the sibling copy
in Movers has the same bug.

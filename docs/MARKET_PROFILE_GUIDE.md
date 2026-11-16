# Market Profile (TPO) — user guide

Page: `/market-profile` (sidebar → Scalping → Market Profile (TPO)). Read-only: it places no orders.

Code: pure engine `rs_dashboard/lib/marketProfile.ts` (tests in `marketProfile.test.ts`), canvas chart
`components/marketProfile/TpoChart.tsx`, page `components/marketProfile/MarketProfilePage.tsx`. Bars come from
`/api/volume-footprint` (`scripts/tools/volume_footprint_fetch.py`: local 1-min parquet store topped up from Dhan,
up to 50 sessions, which is Dhan's 90-day intraday window). NSE symbols only for now: NIFTY / BANKNIFTY / SENSEX /
FINNIFTY and every F&O stock. MCX is not supported yet.

## How the profile is built

- The session is cut into periods (30 min by default; 15 / 60 selectable) anchored at **09:15**. NSE gets 13
  periods, **A–M**, and M is the 15-minute stub 15:15–15:30. Letters run A–Z, then a–z.
- Every period prints its letter on each price **row** between its low and its high. A row is `rowSize` points tall.
  Auto row size is the median profile range ÷ 50 (÷ 60 for composites), snapped to 0.05 / 0.1 / … / 5 / 10 / 25.
  Type a value in **Row** to override it; leave it blank for auto. It commits on blur / Enter.
- **Weekly / Monthly** composites merge sessions by ISO week / calendar month. There each TPO's letter is the
  **day** it came from (A = first session of the week/month), so the letters show which day built the value.

## Levels and marks

| Mark | Meaning | Rule |
|---|---|---|
| **POC** (red row/line) | Price with the most time | Most TPOs; a tie goes to the row nearest the middle of the range |
| **VAH / VAL** (violet dotted) | Value area: 70% of TPOs | Start at the POC, add whichever side's next two rows hold more TPOs, until 70% (selectable 60/68/70/80) |
| **IB** (sky bar on the left) | Initial balance: the first hour | High/low of periods A+B (one hour at any period length) |
| **▸ / ◂ C** | Open / close | `◂ LTP` while today is still developing |
| Amber stripe | Mid-profile single prints | ≥ 2 consecutive rows with exactly one TPO, not at an extreme |
| Red / green stripe | Selling / buying tail | Single prints touching the top / bottom row |
| **Poor high / low** | Extreme without rejection | ≥ 2 TPOs on the top / bottom row |
| **nPOC** (amber dotted) | Naked POC | A POC no later session has traded through; faint once it was revisited |
| ◆ **VPOC** | Volume POC | Row with the most 1-min volume (volume spread evenly over each bar's range); stocks only, indices have no volume |
| **Prev VA** | Previous profile's value area carried across | Toggle |

A row whose only TPO belongs to the period still forming is not counted as a single print until that period ends.

## Reading labels (heuristics, not signals)

**Day type** (`classifyDay`; thresholds are constants at the top of `marketProfile.ts`):

- No IB extension: **Non-Trend** if the IB is narrower than 0.75 × the average IB of the last 10 sessions, otherwise **Normal**.
- Extension on both sides: **Neutral Center** if the close is in the middle half of the range, otherwise **Neutral Extreme**.
- Extension on one side: **Trend** if it exceeds 2 × IB, or is at least 1 × IB with the close in the outer 25% on that
  side. Otherwise **Normal Variation** (Up / Down).
- Today's label carries "(developing)". Sessions without an A/B period (e.g. a Muhurat session) get no day type.

**Power degree** (`powerDegree`), judged at the close (or the last price for today):

| Degree | Bullish (mirror for bearish) |
|---|---|
| 1 | within own IB, above the previous day's VA |
| 2 | above own IB but within own VA, above the previous VA |
| 3 | above own VA, above the previous VA |
| 4–6 | the same three, but above the previous day's **range** |

Inside the previous value area the market is **Balanced** (degree 0).

**Skew pressure**: more TPOs below the POC than above (by more than 10% of them) leans bullish, and the reverse
leans bearish. It is the course's statistical expectation that a lopsided profile fills back in.

**Rotation factor**: the sum, over consecutive periods, of +1/−1 for a higher/lower high plus +1/−1 for a
higher/lower low.

## Chart controls

Same zoom model as the P&F chart: wheel or − / + = zoom both axes · Shift + wheel or the squeeze / stretch
buttons = horizontal only (TPO cell width) · drag the price axis = vertical only (row height; drag up = zoom in) ·
drag = pan · click = select a profile (right panel) · double-click or ↺ = fit. Each zoom keeps the point under the
pointer fixed. The maths is in `rs_dashboard/lib/tpoChartZoom.ts` (tested). Styles: **Letters** (letters drop to plain blocks when cells are too small), **Blocks**,
**Histogram**. Live mode polls only today's session every 10 s during NSE cash hours and merges it over the
loaded history. A banner shows when updates stall for more than 3 minutes.

## Known limits

- Bars are 1-minute OHLC, so a period's range is exact but time inside a minute is not.
- The NIFTY parquet store can lag. The fetcher then tops up from Dhan for the whole requested window (≤ 84 calendar
  days), so a 50-session load is Dhan-heavy until the store is refreshed.
- Day-type and power thresholds came from one course; they are tunable labels, not backtested rules.

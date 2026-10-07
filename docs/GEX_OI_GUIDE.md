# GEX OI Chart — user guide

Dashboard page: **Options Analytics & 3D → GEX OI Chart** (`/options/gex`). Code: `rs_dashboard/lib/gex.ts`
(maths, checklist, tests in `lib/gex.test.ts`) and `rs_dashboard/components/GexOiPage.tsx` (page).

Shows **gamma-weighted open interest** for Nifty: where option dealers would be forced to buy or sell as price
moves, instead of just where the most contracts are open.

> **Read this first.** The method comes from one teaching video ("Trade the Influence, Not Contracts: OI vs. GEX
> Breakdown", Trading with 915, 2026-05-23). It has **not been backtested** and rests on one worked example. The
> page is an analysis aid: it places **no orders**. The strangle rules below are the video's, listed so you can
> read the chart the way the author does, not as a recommendation. Notes on the research are in the vault page
> `wiki/sources/oi-vs-gex-video`.

---

## 1. The idea in one minute

Raw OI counts contracts. Every strike is weighted the same, whether it is at the money or 800 points out, 2 days
from expiry or 30. **GEX** weights each strike by its **gamma**, so a strike where a small price move forces a lot
of dealer hedging counts for more.

> OI = how many cars are on the road. Gamma = how fast each car is going. You care about impact, not headcount.

- Gamma is **highest at the money** and **highest near expiry** (about 10x at 2 DTE compared with 30 DTE).
- Gamma uses a 10-minute time floor (the shared pricing clock's 6-hour floor would freeze expiry-day gamma from ~09:40), and a strike with no IV borrows the OTM leg's IV, then the same strike's other side, then the nearest strike within 200 points.
- GEX of a strike = **gamma × OI (in units) × spot^k × 0.01**: the hedge size per **1% move** in Nifty.
- **Calls count positive and puts negative.** This assumes dealers are long calls and short puts. It is an
  assumption: Indian index options publish no dealer book, so treat the sign as a convention, not a measurement.
- **Net GEX** of a strike = call GEX + put GEX (put GEX is negative), the video's "call minus put".

## 2. What is on the page

| Element | What it is |
|---|---|
| **Call wall** | Strike with the highest call GEX. Read as **resistance**: dealers sell into rallies there. |
| **Put wall** | Strike with the highest put GEX. Read as **support**: dealers buy into drops there. |
| **Strike flip** | Where per-strike net GEX crosses from negative to positive (interpolated between two strikes). It sits near spot by construction (calls above, puts below); it is **not** the zero-gamma level, which GEX v2 finds by re-pricing the chain at other spots. |
| **Pin strike** | Strike with the largest call + put GEX combined. The likeliest **expiry magnet**. |
| **Net GEX** | Whole-chain total, per 1% move. |
| **Regime badge** | **Positive gamma**: spot is at or above the flip. **Negative gamma**: spot is below it. |
| **Call vs put GEX chart** | Red bars (calls, up) and green bars (puts, down) by strike, net GEX as a gold line, dashed **SPOT** line, gold **STRIKE FLIP** line. The wall bars have a light outline. |
| **Net dealer GEX chart** | Net GEX per strike, red where negative and green where positive, with the spot and flip lines. |
| **Open interest chart** | Raw call and put OI, so you can see where raw OI and GEX disagree. |
| **Strangle entry checklist** | The video's five-point list (section 5). |
| **Guide button** | Top right of the page: opens this guide in a side panel (the panel renders this file, so the two never drift). |

Controls: **Expiry** (an expiry past its 15:40 IST close is not offered), **Strikes ±** (chart window; the KPIs use
the whole chain, and a note lists any level that falls outside the window), **GEX in** (₹ notional or index units).

## 3. How to read it

### Regimes
| | Positive gamma (spot above the flip) | Negative gamma (spot below the flip) |
|---|---|---|
| Dealers | **Dampen**: sell rallies, buy dips | **Amplify**: buy rallies, sell dips |
| Price | Stays in a range, mean reverts | Trends, moves accelerate |
| Volatility | Lower | Higher |
| For short strangles | **Good** | **Bad**: no mechanical protection |

### Raw OI versus GEX
The video's central point is that the two can say different things. Compare the OI chart with the GEX chart:
- **Pin strike**: huge GEX on both sides. Raw OI shows a big bar, but not that it pins.
- **Real support**: the put wall may not be the biggest raw-OI put strike. The video's example: support really
  starts at 24,200 (put GEX 3,920), not only 24,000 (4,117).
- **Round-number bias**: heavy OI at 24,000 or 25,000 can be retail positioning, not hedging force.
- **When both agree** (the same strike is the top call OI and the top call GEX), the level is stronger.
  The video's example: the 24,500 call wall.

### The flip is a zone, not a line
The video's own numbers (net GEX −597 at 24,200 and +250 at 24,250) interpolate to about 24,235; the video calls it
~24,225 and says "24,200 to 24,250". Spot sitting on it is a **knife edge**: below it moves amplify downside, above
it they dampen upside. Expect the regime badge to flip back and forth near it.

## 4. The video's trade: short strangle at the walls

- **Sell the call at the call wall and the put at the put wall.** Example: short 24,500 CE and short 24,000 PE.
- If two strikes are close in GEX, the author splits the position across both. The checklist says "call split" or
  "put split" when the runner-up is within 80% of the leader.
- **Only in positive gamma**, i.e. spot above the flip. In negative gamma do not enter.
- Why it should work, per the video: dealers sell as price approaches the call wall and buy as it approaches the
  put wall, so price pins between the walls and the strangle decays.

## 5. Entry checklist (as the page shows it)

The video says: all five green, execute; one amber, reduce size or wait.

| Tile | Rule | Page behaviour |
|---|---|---|
| Net GEX positive | Total net GEX above zero | Green when positive and spot-vs-flip agrees; **amber** when the chain total and spot-vs-flip disagree; red when negative |
| Flip below spot | You want to be in the positive zone | Green when flip < spot, red otherwise |
| India VIX below 18 | High VIX is tail risk | Green under 18, amber 18–20, red above 20, grey when VIX is unavailable |
| No major event in 3 days | RBI, Fed, Budget, elections, results | **Always manual**: the app has no event calendar |
| Walls clear | One dominant strike on each side | Green when both runners-up are under 80% of the leader, amber otherwise |

The slide says VIX 18 and the presenter says 20 aloud; the page uses 18 for green and treats 18–20 as amber. The
slide says 3 days for events; the speech says 2 to 5.

## 6. Risk rules from the video

- **Walls break**: when price blows through a wall, gamma at that strike collapses (deep ITM options have near-zero
  gamma) and the move accelerates.
- **Stop loss**: exit if Nifty **closes beyond the wall by more than one straddle width**.
- **Wings**: buy wings 200–300 points beyond the short strikes to turn a naked strangle into defined risk.
- **Flip watch**: if spot drops below the flip intraday, tighten the put-side stop immediately.
- **Size**: never more than 2% of capital at risk on a trade. Strangles blow up; size small.
- **Do not trade** when net GEX is negative, when the flip is at or above spot, when VIX is above 20, with a major
  event ahead, when many strikes have near-equal GEX, or when you are on back-to-back losses (no revenge trading).

## 7. How the page computes it, and where it differs from the video

- **OI units.** Dhan's chain OI is already in **units** (every OI on the live chain is a multiple of the lot size),
  so the page does **not** multiply by the lot size again. Charts show OI in lots using the current lot size.
- **Spot power ("GEX in").** `₹ notional` = gamma × OI units × spot² × 0.01. `index units` = gamma × OI units ×
  spot × 0.01, which is the video's formula (spot once) and is the number of Nifty units dealers trade per 1% move.
  Walls, flip and pin are identical either way; only the magnitudes scale.
- **The slide's "₹62.9 Cr" is wrong.** From the slide's own inputs (0.0008 × 50,000 lots × 65 × 24,200 × 0.01) the
  result is 629,200 index units, or about ₹1,522 Cr with spot squared. The slide figure is 62.9 *million*
  (₹6.29 Cr) read as crore.
- **Gamma** is computed with the repo's Black-76 library from each strike's implied volatility, on the future
  **rolled to the chosen expiry**. If no future price is returned (usually after hours), the forward is estimated
  from spot with cost of carry and the page says so; gamma is then approximate.
- **Flip.** Interpolated linearly between adjacent strikes. Sign changes between strikes with near-zero net GEX
  (below 1% of the largest) are ignored, and with several crossings the one nearest spot is used.
- **Regime.** Spot against the flip. If the chain never changes sign, the sign of the total decides.

## 8. Limits and cautions

- **Unvalidated.** One example, no backtest, no trade log. Treat every threshold (18 VIX, 80% clarity, 2% size) as
  the video's, not as tested.
- **Dealer positioning is assumed.** If dealers are not long calls and short puts, the signs invert.
- **OI is a snapshot.** The video says chain OI is a delayed snapshot while gamma changes in real time; how often Dhan
  refreshes OI during the session has not been measured here. The page recomputes gamma on each refresh, but OI itself
  can lag price.
- **Weekly expiries and expiry day.** Gamma is extreme in the last hours and the numbers swing fast. An expiry
  already closed is not offered.
- **Illiquid strikes.** A strike with no recent trade can have a stale or zero IV and contributes little or no
  gamma.
- **Market hours.** The page polls every 15 seconds only while the market is open. After hours it shows the last
  data and a "last session" chip. The VIX tile reads "unavailable" when the index feed is not running.

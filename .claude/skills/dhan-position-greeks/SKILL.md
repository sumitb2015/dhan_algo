---
name: dhan-position-greeks
description: Use when computing, aggregating, joining, or displaying option Greeks (Delta/Gamma/Theta/Vega) for a live position book — the chain-supplied per-contract Greeks pipeline behind Positions Analysis' Greeks tab, ScalperGreeksModal, DeltaPanel and margin-allocator (lib/positionGreeks.ts, lib/positionLegs.ts, components/analytics/GreeksTab.tsx, components/analytics/ScalperGreeksModal.tsx). Covers the position-scaling multiplier every one of the four Greeks must share, the chain-join and IV-normalization quirks, and the units convention for Dhan's own chain Greeks. Also covers the Portfolio Greeks page (/options/delta), the one place Greeks are computed server-side from live premiums (scripts/tools/positions_delta_data.py, lib/deltaDesk.ts, components/deltaDesk/) and the three weighting bases (index units / per lot / the broker analyzer's 1-lot-per-leg). Not for self-computed Black-76/Black-Scholes Greeks used in target-date "what-if" simulation or the payoff curve itself (Options Monitor, T+0 curve, SD bands) — that engine and its own unit conventions are dhan-payoff-diagrams; the two pipelines use different units and must never be mixed.
---

# Position-Level Option Greeks (Chain-Supplied Pipeline)

> **Third path (2026-10-05):** the Portfolio Greeks page (`/options/delta`) does not use pipeline 1. See
> "Portfolio Greeks page" below — it solves Black-76 from each leg's live premium, because Dhan's chain
> delta put a 13-lot book at −0.46 lots against the broker's −0.256.

## Two Greek pipelines in this codebase — know which one you're in

1. **Chain-supplied, live-snapshot Greeks** (this skill): Dhan's option chain response
   already carries `greeks: {delta, gamma, theta, vega}` per strike/type, computed
   server-side by Dhan for *right now*. This dashboard joins those onto each open position
   leg and sums them position-wide. No Black-Scholes/Black-76 math happens on this path —
   it's pure lookup + join + signed sum. This is what Positions Analysis' "Greeks" tab,
   `ScalperGreeksModal`, `DeltaPanel` (Nifty Covered Call), and `margin-allocator`'s
   position classification all use.
2. **Self-computed Black-76 Greeks** (`dhan-payoff-diagrams` skill, `lib/optionsMonitorMath.ts`'s
   `computeBsGreeks`): priced off the futures contract for a *chosen* future spot/date/IV —
   used for target-date "what-if" sliders, the T+0 payoff curve, and SD expected-move bands,
   because Dhan's chain only ever gives you Greeks for the current instant, never a
   projected one.

**Never conflate the two.** Pipeline 1's Greeks are already in final, ready-to-use per-unit
values (see Units below) with no further Black-Scholes scaling applied or needed. Pipeline
2's Greeks come out of raw Black-76 formulas (annualized vega per 1% vol, theta needing a
`/365` day conversion) and need the scaling steps `dhan-payoff-diagrams` documents. Applying
that skill's "Position Greeks & Multipliers" conversion table (Gamma ×100 for a 100-pt move,
Vega ×0.01 for 1% IV) to a Pipeline-1 chain Greek double-scales it — Dhan's chain Vega is
already "₹ per 1 vol point," not "₹ per 100% vol."

---

## The pipeline, file by file

1. **`lib/optionsStrategy.ts`** — `lookupChainLegData(oc, strike, type)` finds one strike's
   chain row; `ChainLegData.greeks` is Dhan's raw per-unit `{delta, gamma, theta, vega}`.
   `implied_volatility` here is a **percent** (e.g. `13.5` for 13.5%), not a fraction.
2. **`lib/positionLegs.ts`** — `buildPositionLegs()` joins each position to its `PositionLeg`,
   pulling `delta`/`gamma`/`theta`/`vega` straight off that leg's own-expiry chain lookup, and
   **converts IV to a fraction right here**: `chainLeg.implied_volatility / 100`. Every other
   IV consumer in this pipeline (`GreeksTab.tsx`'s IV% display, POP integration in
   `computePayoffStats`) expects the fraction form — if you add a new chain-Greek call site,
   convert at the join, not downstream, or some readers will silently treat 13.5 as 1350%.
3. **`components/PositionsAnalysis.tsx`**'s `legs` useMemo — **re-joins Greeks per leg's own
   expiry** after the initial book build, because a multi-expiry book (e.g. a calendar/
   diagonal, or simply two different weekly expiries in the same book) needs each leg priced
   off *its own* expiry's chain, not one global chain. Skipping this re-join is the same class
   of bug as `dhan-payoff-diagrams`' T+0-curve rule "use each leg's own expiry, not the
   basket's front expiry."
4. **`lib/positionGreeks.ts`** — `computeNetGreeks(legs)` is the aggregator. `posSign(leg) =
   (leg.side === 'SELL' ? -1 : 1) * leg.qtyLots` is the **one** signed multiplier, and it must
   be applied to **all four** Greeks identically when summing:
   ```ts
   delta += (leg.delta ?? 0) * k;
   gamma += (leg.gamma ?? 0) * k;
   theta += (leg.theta ?? 0) * k;
   vega  += (leg.vega  ?? 0) * k;
   ```
5. **Rendering components** (`GreeksTab.tsx`, `ScalperGreeksModal.tsx`) show a header strip
   of the four net totals plus a per-leg breakdown table. **The per-leg table must apply the
   exact same `k = posSign(leg)` to every Greek column it shows**, or the rows won't sum to
   the header and won't reflect each leg's real signed contribution (a short leg's gamma
   should render negative, a long leg's positive — same logic as Delta's sign flip on shorts).

---

## `qtyLots` is a misleading name — it holds real contract units, not a lot count

`PositionLeg.qtyLots` (set in `buildPositionLegs`, `lib/positionLegs.ts`) is
`Math.abs(pos.netQty) * mult` — **the absolute real contract-unit quantity** (e.g. `260` for
4 lots of a 65-lot-size NIFTY option), not `260 / 65 = 4`. So:
- `posSign(leg)` multiplies a per-unit Greek by real units, and the resulting Net Delta is in
  "underlying-share-equivalent units" directly — **no separate lot-size multiplication step
  is needed or correct** anywhere in this aggregation. `mult` (from `contractMultiplier` in
  `lib/positionPnl.ts`) is already folded in for MCX contracts before this point.
- This is why `Net Delta × spot` gives a correct rupee-equivalent directly (`GreeksTab.tsx`'s
  `sub={... net.delta * spot ...}`) with no `× lotSize` anywhere in that line — verified live
  2026-09-23 against a real 6-leg NIFTY book: Net Delta `-16.95` × spot `23,415.85` ≈
  `-3,96,894`, matching the displayed rupee-eq (`-3,96,895`) to rounding.

---

## Missing-Greeks detection: a real option's four Greeks are never all exactly zero

Dhan's chain returns literal `{delta: 0, gamma: 0, theta: 0, vega: 0}` for some priced-but-
ungreeked strikes (observed live on a deep-ITM contract) — often enough that summing those
zeros silently understates net exposure rather than genuinely reporting a flat/neutral leg.
`computeNetGreeks` treats "all four null-or-zero" as the same "ungreeked" signal as
all-`null`, and **excludes that leg from every sum**, reporting it separately in
`NetGreeks.missing`:
```ts
const allNullOrZero = (v: number | null | undefined) => v === null || v === undefined || v === 0;
if (allNullOrZero(leg.delta) && allNullOrZero(leg.gamma) && allNullOrZero(leg.theta) && allNullOrZero(leg.vega)) {
  missing.push(leg);
  continue;
}
```
Any UI showing Net Greeks **must** surface `missing` with an explicit "N leg(s) excluded, real
exposure is larger" warning (see `GreeksTab.tsx`'s amber banner) — never let a missing-Greeks
leg silently vanish from the total with no indication the number is incomplete.

---

## Units convention for chain-supplied Greeks (Pipeline 1) — already final, no rescaling

| Greek | Per-unit value straight from Dhan's chain | After `× posSign(leg)` and summing across legs |
|---|---|---|
| Delta | fraction, ±0–1 | net underlying-share-equivalent units (`× spot` = ₹ rupee-eq directly) |
| Gamma | Δdelta per ₹1 spot move, per unit | net Δdelta per ₹1 move across the whole book — **do not** further multiply by 100 to get "per 100-pt move"; that's a `dhan-payoff-diagrams` Black-76 convention, not this one |
| Theta | ₹ per calendar day, per unit, already signed for time decay | net ₹/day for the whole book (`GreeksTab.tsx` labels this "per day, per set") |
| Vega | ₹ per 1 IV point, per unit | net ₹ per 1 vol point for the whole book — **do not** multiply by `0.01`; Dhan's chain Vega is not expressed "per 100% vol" the way a raw Black-76 formula is |

If you want a derived stat this table doesn't already give you (e.g. "P&L impact of a 100-pt
gap-up," or "P&L impact of a 1-point VIX spike translated to an ATM-IV move"), compute it
**explicitly** from the net Greek (`netGamma * 100` or similar) rather than assuming any
existing number already represents it — and label the derived stat's own units clearly so it
isn't mistaken for one of the base four again.

---

## How to audit a Net Greek figure (the method that found the Gamma bug)

When a user questions a Net Delta/Gamma/Theta/Vega number, don't just re-read the code —
cross-check the live page:
1. Open the Greeks tab / modal for the actual live book in question.
2. Hand-sum the per-leg breakdown column for the Greek in question and compare to the header
   total — they must match to rounding. If they don't, the table and the header are computing
   the sign/scale differently somewhere (this is exactly how the Gamma bug below was found —
   Theta and Vega columns summed correctly to their headers, Gamma didn't).
3. Sanity-check sign and monotonicity: strikes closer to spot should have larger `|delta|`;
   short legs should show the opposite Gamma/Vega sign from long legs of the same type.
4. For Delta specifically, cross-check `netDelta × spot ≈` the displayed rupee-eq.
5. If a third-party tool (Stockmock, Sensibull) shows a different number for what looks like
   the same book, check **entry data first** before suspecting the Greek math — see
   `dhan-payoff-diagrams`' payoff-verification approach (feed the third-party tool's own leg
   data through this repo's functions and compare outputs directly, rather than trusting a
   side-by-side screenshot where the two tools may be reading different underlying data).

---

## Portfolio Greeks page (`/options/delta`): computed, not chain-supplied

**Conventions (aligned to dhan-payoff-diagrams on 2026-10-05, locked by `lib/deltaDesk.test.ts`):** rate `0.065`
(`computeBsGreeks` default, not 7%); time = `calculateTimeToExpiryYears` (to 15:40 IST, intraday, 0.25-day floor, /365) —
the script mirrors it in `time_to_expiry_years()` so a solved IV still reproduces each leg's LTP; theta is the analytic
calendar-day value `(−Fσe^{−rt}n(d1)/(2√t) + rC)/365`, not a 1-day finite difference; SD bands use **ATM IV** from the leg's
expiry chain (`atmIv`), never the average of the legs' own strike IVs; what-if forward is **additive**
(`forward + (s − spot)`), matching the canonical `spot + basis`.

**Data flow.** `api/options/positions-delta/route.ts` → `scripts/tools/positions_delta_data.py` returns **per-unit**
Greeks per leg; the browser (`lib/deltaDesk.ts`) weights and aggregates them and reprices what-ifs with the same
Black-76. Components live in `components/deltaDesk/` (PayoffPanel, ExposurePanel, GreeksMatrix, LadderAndTrail).

**What comes from Dhan vs what is computed.** From Dhan: positions (qty, `costPrice`, `unrealizedProfit`, strike,
expiry), option `last_price` from the chain (else per-leg `get_ltp`), the nearest Nifty future, index spot. Computed:
IV (bisection on the live premium), all eight Greeks (delta, gamma, theta, vega, rho, vanna, charm, vomma), every
portfolio total, the payoff, ladder and expiry split. Chain Greeks are only the fallback (`greeksSource: 'chain'`,
second-order blank) when a leg has no live price.

**Rules learned (each one was a real defect):**
1. **Dhan's positions payload has no `lastPrice`.** `row.get('lastPrice') or 0` silently showed ₹0 for every leg.
   Take LTP from the chain's `last_price`, then `get_ltp`.
2. **Do not sum chain deltas for the headline.** Chain gamma/theta/vega matched a Black-76 solve; chain delta did
   not (−0.46 vs −0.23 lots; cause unconfirmed). Solve from the premium on the futures forward, rolled to each
   leg's expiry: `F_leg = F_fut·exp(−r(T_fut − T_leg))`.
3. **One spot per underlying, never 0.** Chain spot → index `get_ltp` (retry once after 1.2 s; the chain and index
   share the ~1 req/s limit) → futures·exp(−rT) flagged `spotSource: 'futures'`. A 0 spot makes `s / spot`
   repricing return garbage (a constant −₹85 lakh). The page shows an amber note when it is estimated.
4. **A rate-limited chain call returns an empty payload with an all-`None` error dict**, not an HTTP error. Treat an
   empty `oc` as "no chain", not "no data".
5. **Units** (per unit, then × weight): gamma per index point; vega per +1 vol point; theta = price change per
   calendar day (finite difference on 1/365); rho per +1% rate; vanna = Δdelta per vol point; charm = Δdelta per
   day; vomma = Δvega per vol point.

**Three weighting bases — name the basis wherever a number is shown:**

| Basis | Weight per leg | Use |
|---|---|---|
| Index units | signed qty | real exposure; `Net Δ × spot` = rupee-equivalent |
| Per lot | signed qty / lot size | what traders think in |
| Broker view | ±1 | reproduces the broker analyzer's tab |

The broker's Greeks tab ("Decimals") sums per-unit leg Greeks with **only a buy/sell sign — lot counts ignored**;
its "Per Lot" toggle is Decimals × 65. On a 3/6/4-lot book its gamma/theta/vega read ~4.3× below real exposure
(Delta looked close only because both were small). Measured 2026-10-05: broker Δ −0.256 / Γ −0.001296 / Θ +18.22 /
ν −49.52 vs ours on the broker basis −0.2353 / −0.001264 / +17.32 / −49.43. If a user says "doesn't match the
broker", ask for the broker's Per Lot toggle value and one expanded leg before changing any maths.

**Verification recipe (do this before claiming a match).** (a) T+0 at the current spot must reproduce the book's
`unrealizedProfit` (it does, to ~₹2, because IV is solved from each leg's own premium); (b) best-case profit and
break-evens at expiry against the broker's Pay-Off tab; (c) `npx tsx` a small script over the live script output
to print the ladder, so a bug like spot=0 shows up as an absurd constant instead of in a screenshot.

**Not verified:** rho/vanna/charm/vomma have no broker figure to compare against; payoff/ladder hold each leg's IV
flat, so they omit the volatility shock that usually accompanies a big move (the page says so).

## Incidents this skill was written from (2026-09-23)

- **`GreeksTab.tsx`'s per-leg Gamma column rendered raw `l.gamma` with no `* k` multiplier**,
  while the Theta and Vega columns right next to it correctly used `l.theta * k` / `l.vega *
  k`. The header's own `Net Gamma` was unaffected (`computeNetGreeks` always applies `k`
  internally) — only the table's per-leg breakdown was showing the wrong number, two orders
  of magnitude too small and with no short/long sign distinction. Found by hand-summing the
  per-leg columns against the header while auditing a user-reported Net Delta figure (which
  turned out to be correct). Fixed: `d016e16`.
- **The identical bug, byte-for-byte, was duplicated in `ScalperGreeksModal.tsx`** — same
  missing `* k` on the same Gamma column, same otherwise-correct Theta/Vega columns next to
  it. Found by grepping for the same code shape (`fmt(l.gamma, 5)` with no multiplier) across
  every consumer of `posSign`/`computeNetGreeks` once the first instance was identified — the
  lesson being that a bug found in one Greeks-table renderer should always trigger a repo-wide
  grep for the same pattern, not just a fix in the file that was open. Fixed same session.
- If you add a **third** per-leg Greeks table, copy the `k = posSign(leg)` treatment onto all
  four columns from day one, and add it to the audit method above as another surface to
  cross-check.

Full incident write-ups: vault `wiki/incidents/2026-09-23-greeks-tab-gamma-column-unscaled.md`
and `wiki/incidents/2026-09-23-positions-analysis-unrealized-pnl-mismatch.md` (a related but
distinct bug found the same session, in unbooked P&L rather than Greeks).

Full write-up of the 2026-10-05 page rebuild: vault `wiki/incidents/2026-10-05-delta-page-zero-ltp-and-chain-delta-drift.md`, `wiki/decisions/2026-10-05-portfolio-greeks-black76-from-live-premium.md`, `wiki/concepts/position-greeks-bases-and-broker-analyzer.md`.

---
name: dhan-position-greeks
description: Use when computing, aggregating, joining, or displaying option Greeks (Delta/Gamma/Theta/Vega) for a live position book — the chain-supplied per-contract Greeks pipeline behind Positions Analysis' Greeks tab, ScalperGreeksModal, DeltaPanel and margin-allocator (lib/positionGreeks.ts, lib/positionLegs.ts, components/analytics/GreeksTab.tsx, components/analytics/ScalperGreeksModal.tsx). Covers the position-scaling multiplier every one of the four Greeks must share, the chain-join and IV-normalization quirks, and the units convention for Dhan's own chain Greeks. Not for self-computed Black-76/Black-Scholes Greeks used in target-date "what-if" simulation or the payoff curve itself (Options Monitor, T+0 curve, SD bands) — that engine and its own unit conventions are dhan-payoff-diagrams; the two pipelines use different units and must never be mixed.
---

# Position-Level Option Greeks (Chain-Supplied Pipeline)

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

# Near vs far expiries, strike rules, and spread checks

Table of contents: Per-leg expiry · Near vs far · Where the rule is applied · Bid/ask check · Calendar and diagonal · Pitfalls

## Per-leg expiry
Each leg stores `expiry`; each basket has `expiry` (main) and optional `farExpiry`. Read it as
`leg.expiry || basket.expiry` everywhere. A leg's security id, strike list, LTP, IV, margin and order all resolve
against **its own** expiry (`lookupCache["UNDERLYING:EXPIRY"]`), otherwise a calendar's far leg silently prices off
the front chain. Persisted legs from before the field existed have no `expiry`, hence the fallback.

## Near vs far
- **Near** = the 1st and 2nd listed expiry of the underlying: every listed strike is allowed.
- **Far** = the 3rd listed expiry onward: for NIFTY, BANKNIFTY and SENSEX only strikes that are multiples of 100 are
  allowed (the 50-strikes there are thin and market orders fill badly). MCX crude is exempt and keeps its own grid.
- "Listed" comes from `expiriesMap[underlying]` sorted ascending; `isFarExpiry` sorts a copy and returns false for an
  unknown expiry or an empty list. Constants and functions: `lib/farExpiryRules.ts` (`isFarExpiry`, `strikeAllowed`,
  `allowedStrikes`, `snapToAllowed`, `strikeRuleApplies`).

## Where the rule is applied
| Place | Behaviour |
|---|---|
| Leg strike dropdown, Add Leg modal | list only allowed strikes for that leg's expiry; keep a set-but-disallowed strike visible with an amber "x100 only" hint |
| Basket expiry change, leg expiry toggle, Add Leg modal opening, blank leg | snap DRAFT strikes to the nearest allowed strike (ties go lower); toast on basket-level snap |
| `placeBasket`, `addNewLegCore`, `shiftLegs` | **refuse** before anything is sent |
| Exit, Add Lots on an open leg | not restricted, so an old 50-strike position stays manageable |
| Shift planner | is fed the filtered strike list, so "N steps" means N allowed strikes on a far expiry |

**Order paths fail closed** when the expiry list has not loaded: for rule underlyings require `strike % 100 === 0`
(the toast then says the list is not loaded, not "far expiry"). UI filtering fails open so nothing vanishes while data loads.

## Bid/ask check before opening legs
`POST /api/multi-leg-focus/depth` (`{ underlying, legs:[{strike, option, expiry, securityId?}] }`) returns best bid/ask
per leg from Dhan's `/marketfeed/quote` (`data[segment][securityId].depth.buy[0].price` / `.sell[0].price`). It resolves
Dhan ids through `getDhanStrikeLookup` for Zerodha/Kotak baskets (market data is Dhan-only), sanitises ids to digits,
caches identical requests for 1 s and goes through the shared quote lane.
`assessSpread`: `no_market` (a side is 0) **blocks**; `wide` = spread > 5% of mid **and** >= Rs 0.50 asks to confirm,
MARKET legs only (a LIMIT leg's own price is its protection); `unknown` (missing data, timeout, 429) **never blocks**,
it just toasts. Client aborts after 2.5 s. Thresholds are constants in the rules file and untuned.
Run it in parallel with the margin/funds checks in `placeBasket`; for a shift, check the NEW strikes before closing anything.

## Calendar and diagonal
Two expiries in one basket; a leg on the second expiry is highlighted in the Expiry cell. The at-expiry payoff is
meaningless (legs do not share an expiry), so `computeCalendarPayoffCurve` values the strategy at the near expiry with
the near leg at intrinsic and the far leg priced by Black-76. Adding a calendar template needs a real second expiry
(refuse otherwise). Changing the basket's expiry moves DRAFT legs on the old front expiry with it; placed legs and legs
deliberately parked on the far expiry stay put (`dhan-terminal-position-ownership` invariant 8).

## Pitfalls
- A saved row with an expiry that has since expired shows no premiums: snap flat rows to the nearest listed expiry once the list loads (`cfeffd8`).
- Comparing `leg.expiry !== basket.expiry` to decide "calendar" misfires when a basket expiry changes but legs did not follow.
- Never key an LTP or IV lookup by strike alone across expiries.
- The strike rule is about *opening*; do not add it to exits.

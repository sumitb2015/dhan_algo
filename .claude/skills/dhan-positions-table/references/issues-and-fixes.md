# Issues we hit, root causes, and fixes

Use this as a symptom lookup. Commit hashes are on `master`. Vault notes (history and reasoning) live in
`/home/sumit/Brain/dhan_algo_brain/wiki/{decisions,incidents,learning,runbooks}`.

Table of contents: Data and P&L · Expiry and calendars · Payoff diagram · Greeks and order book · Concurrency and orders · Table mechanics · Operational

## Data and P&L
| Symptom | Root cause | Fix |
|---|---|---|
| An exited leg or straddle shows +Rs 0 after a real gain | closed paths never set `closedFill`, so `legPnl` had nothing to compute from | set `closedFill` on manual exit, already-flat and rollback (`956810f`) |
| Running P&L drifts from Dhan's own platform | Dhan `/positions` has no LTP; client recomputed off a stale chain | trust Dhan's `unrealizedProfit` for Dhan legs (`491281d`) |
| Live leg with no price shows a full-premium gain | `avg - 0` in `legPnl`; also true of the rupee P&L column | new P&L % column returns null without an LTP; rupee column still open (roadmap) |
| Header still says "Iron Condor" after the legs became a Batman | label came from stored `presetKey` | `classifyBasketStructure()` from live legs (`251a509`) |
| Two baskets on one contract: ghost OPEN legs, exit fails with a sign mismatch | Dhan nets by security id | confirm guard before place/add lots/add leg (`a9c6608`), Greeks-panel warning (`86cb6e0`) |

## Expiry and calendars
| Symptom | Root cause | Fix |
|---|---|---|
| Calendar legs collapse onto one expiry, BE: None / Max P&L 0 | legs had no own expiry | per-leg `expiry` + basket `farExpiry` threaded through lookup, margin, orders (`55e9938`) |
| No chart for a calendar | at-expiry payoff suppressed, nothing replaced it | `computeCalendarPayoffCurve` (`0268de5`) |
| Plain strangle reads as calendar after changing basket expiry | draft legs stayed on the old expiry | move DRAFT legs with the basket (`ac7981f`) |
| Saved row shows no premiums | its expiry has since expired | snap flat rows to the nearest listed expiry (`cfeffd8`) |
| FRONT / FAR badges tell you nothing | label describes a role, not a contract | show the actual date (`9ac374d`) |
| Far-expiry 50-strike fills badly | thin book | x100 rule + bid/ask check (`187dfb8`) |

## Payoff diagram
| Symptom | Root cause | Fix |
|---|---|---|
| Break-even off-chart for a big-premium leg | sample window narrower than strike +/- premium | pad by premium; exact expiry profile evaluates every strike (`b68d952`, `1c2fab4`) |
| Profit/loss transition squeezed into a sliver | X-domain built from far wing strikes | size off breakevens, add zoom controls (`1cd6db8`) |
| Lines frozen mid-draw, T+0 line never appears | Recharts `<Line>` animates on every live tick | `isAnimationActive={false}` (`8e522e3`, `bb5a615`) |
| Whole page slow on every tick | T+0 curve recomputed for collapsed charts | compute only while the chart is open (`dd6f04c`) |
| Chart per leg confusing | wrong scope | one chart per strategy, collapsed by default (`37fc7a7`, `ec55ffa`) |

## Greeks and order book
| Symptom | Root cause | Fix |
|---|---|---|
| Per-leg Gamma disagrees with header Net Gamma | Theta/Vega scaled by position, Gamma was raw | scale by sign and qty (`d016e16`, `4502f33`) |
| Greeks fetch on every render | eager chain fetch | on-demand button, chain fetched on click (`4ad35bc`) |
| Pending order needs cancel/modify | order book was read-only | inline limit modify/cancel in `OrdersTradesModal` (`759cbb4`) |

## Concurrency and orders (found in review, fixed before shipping)
| Symptom | Root cause | Fix |
|---|---|---|
| N-leg entry/exit slow | legs placed one after another; exit also fetched positions per leg | two-phase concurrent placement and exit (`3674729`) |
| Double-click places a strategy twice | lock set after `await` (funds read / confirm) | wrapper takes the lock before any await |
| Hedge sold while a short failed to close | exit loop ignored a failed short | skip longs unless every short returned `closed` |
| Legs stuck PLACING after an abort | all set PLACING up front, early return left them | `releaseUnattempted()` back to DRAFT, before rollback |
| A leg throwing skips the rollback | sync throw outside `try` rejected `Promise.all` | per-leg wrapper never throws |
| Concurrent responses revert/drop a leg | `basketsRef` stale while updater deferred | functional `patchLegs`; return results |
| Margin gate let orders through when unknown | fail-open on missing margin/funds | fail closed; composition-matched margin; fresh funds |
| Far 50-strike slipped through | expiry list not loaded counted as "not far" | order paths fail closed when list empty |
| Order waits on market data | depth call unbounded (server 6 s, cold lookup up to 30 s) | client abort 2.5 s, capped queue, 1 s cache |
| Wrong broker's funds used after a switch | coalesced poll kept old reply inside freshness window | per-broker inflight key, drop stale replies, reset freshness on switch |
| Shared limiter state split across route bundles | Next may duplicate a module per route | `globalThis` singleton lane |

## Table mechanics
| Symptom | Root cause | Fix |
|---|---|---|
| Columns misalign after adding one | header/rows/colgroup built separately | one ordered weights array + shared booleans |
| Fixed-percent colgroup cannot fit extra columns | static Tailwind widths | inline computed widths + `minWidth` |
| Columns menu cut off | card/table clip overflow | `position: fixed` popover, toolbar outside scroller |
| Lint: setState in effect | reading localStorage in an effect | read in the `useState` initialiser |
| Lint: "cannot access refs during render" | assigning `ref.current = x` in render | assign in an effect |
| Row order jumps while editing a draft | sort always on | sort is opt-in (`29b7ae3`) |
| `Exit Strategy` clipped, empty margins | `max-w-[1700px]` on the list | full-width container |
| Add Leg opens on a disallowed strike | initial ATM strike not snapped | snap on open and on expiry toggle |

## Operational (rebuilding and restarting to look at a change)
- `pgrep -x next-server` did not match the process; the old server kept serving the old build and the change looked "not deployed". **Kill by PID from `ps -eo pid,args`, then confirm the new `next-server` start time.**
- `pkill -f "sh -c next start"` matched the shell running the command and killed it mid-restart. Do not put the pattern you are killing in your own command line.
- A restart kills the live WebSocket bridges (`instrumentation` shutdown SIGKILLs the PIDs in `debug/*.json`); loading the page restarts them. Hard-reload every open tab and do not trade from a stale one.
- `npm run build` while the server runs can leave it serving mismatched chunks; restart right after building.
- Tests for table changes must not place orders; there is no paper mode.

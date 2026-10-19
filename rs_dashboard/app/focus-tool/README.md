# Focus Tool — risks and how to use it

Scheduled straddle / strangle rows on NIFTY, BANKNIFTY, SENSEX and CRUDEOILM. Each row sells a CE and a PE at resolved strikes, then manages them with leg stops, targets, re-entries and overall rules. **REAL rows send real orders.** SIM rows are paper and never touch the broker.

> Every short leg here is a naked option. The tool places no protective buys, so the only limits on loss are the stops you set, the exit time and your account stop. Read the risks below before running a REAL row.

## Risks — where a row can end up one-sided or naked

- **A re-entry that does not fire.** A leg stops out, its re-entry is blocked or fails, and the other leg sits alone and short. The usual cause is an index that was never started: stops and exits still run, but re-entries do not ("index not started"). An amber banner now stays up until the leg is open again or you dismiss it.
- **Square Off is "partial" by default.** A stop or target closes only that leg. If its re-entry is off, blocked or unconfirmed, the surviving leg keeps running with no hedge. Set Square Off to **complete** if a stop should flatten the whole row.
- **Scale-out is one-sided.** It cuts a leg by the chosen % as that leg nears its own target and leaves the other leg at full size, so the net exposure becomes lopsided.
- **Unequal lots.** CE and PE lots can differ ("Per leg"). A 3-lot CE against a 2-lot PE is not balanced from the start.
- **No overall stop unless you set one.** Each leg is capped by its own SL, but every re-entry (up to the re-entry limit, per leg) is a new short with its own risk, and the losses stack. The row's overall SL (SL ₹ or SL ×) and the page-level Risk stop are the only caps across all of them. The page-level stop works only while the Risk switch is on.
- **Near-the-money re-entries.** An RE OTM re-sale after a target, or after a stop that had trailed, is counted from the ATM now, so the new short carries more risk than the leg it replaced. **RE qty** sizes such a re-entry as a % of the lots that just closed (whole lots, at least one). A plain SL roll from the stopped strike is never scaled. It defaults to 100%, so set it yourself.
- **An order that goes out but does not confirm.** The leg is left flat (or part-filled) and a late fill is possible. The row holds further orders on that leg until the broker settles it. Check the broker's order book before re-entering by hand, or you can double the position.
- **Stops run only in the open browser tab.** The leader tab executes every stop, target, entry and re-entry. A closed, sleeping or throttled tab means nothing is watching your legs. A second tab shows a banner and fires nothing. Keep exactly one tab open while a REAL row holds a position.
- **Kotak stops are software stops.** There is no resting stop order at Kotak. A stop is a market or limit buy-back sent when the tab sees the price, so a fast move can fill beyond the stop price, and a limit buy-back can stay unfilled.
- **A broker book the tool cannot read.** Closes size off a fresh position book. If the broker rate-limits or the session has lapsed (Kotak ends its session at midnight IST), a close is refused and retried, not guessed. The leg stays open meanwhile.
- **Exit time is the last backstop.** Legs still open at the row's exit time (default 15:15) are closed. Past the 15:17 intraday cut-off no re-entry is taken.

## Checks before going live

- The index group is **started** if you want re-entries.
- A row's overall SL (or the page Risk stop) is set, and Square Off matches what a stop should do.
- CE and PE lots are what you intend, and RE qty is set for near-the-money re-entries.
- One browser tab is open, on the broker the row trades, and that broker's session is current.
- LIVE · REAL MONEY is armed only for the rows you mean to trade.

## Where to look when something did not happen

- `debug/focus_tool_events.jsonl` records every entry, exit, re-entry, shift and scale-out. `reentry_outcome` says why a re-entry did not go out and `shift_outcome` does the same for a strike shift.
- The amber and red banners under the header stay up for skipped re-entries, unknown order statuses and naked or lopsided rows.

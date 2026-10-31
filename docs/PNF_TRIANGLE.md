# P&F triangle (squeeze) on `/straddle-pnf`

Source: Mukta Dhamankar, "Spot Winning Breakouts with This P&F Triangle Pattern" (YouTube `s43IyMFmCHU`, 2026-06-03).
Code: `rs_dashboard/lib/pnfTriangle.ts` (pure, `pnfTriangle.test.ts`), drawn by `components/straddlePnf/PnfPanel.tsx`.

## The pattern
A **triangle** is a consolidation in which every new column sits inside the previous one: an O inside an X, an X inside that O, and
so on. Three nested columns are a 3-column triangle, four a 4-column one; the more columns, the tighter the squeeze. Neither a
breakout nor a breakdown has happened yet. It ends with a **Double Top Buy** (bullish breakout) or a **Double Bottom Sell**
(bearish breakdown). *Wait for the breakout; do not pre-empt it.*

A column `b` is nested in `a` when `b.low >= a.low`, `b.high <= a.high` and `b` is strictly shorter. A triangle is a maximal run of at
least *N* nested columns (N = 3 to 6, the `△N` button, remembered per chart).

## The trade the video teaches
| | Bullish (DTB) | Bearish (DBS) |
|---|---|---|
| Entry | one box above the top glyph of the triangle's last X column | one box below the bottom glyph of its last O column |
| Stop | the opposite trigger (the double-bottom-sell level) | the double-top-buy level |
| Target | vertical count: boxes the breakout column had when it broke × reversal × box, added to the column's bottom glyph | subtracted from its top glyph |

Both trigger levels are known while the triangle is still forming, so the chart draws them (`Buy above` / `Sell below`). After the
breakout it shows `Entry`, `Stop` and `Target · RR 1:x`. The video's slide quotes an overall reward to risk of about 1:3; the RR on
the chart is computed from the actual levels.

## On the page
- Two dotted converging lines, a `△N` tag (amber forming, green up, red down, grey ended) and the levels above.
- Toolbar next to the zoom buttons: `△` show / hide, `△N` minimum columns (3 → 4 → 5 → 6 → 3).
- Alert on a breakout (toast, log row with stop / target / RR, flash, chime). A breakout already on the chart when the page loads or
  the settings change does not alert, like every other signal.
- Triangles are **not** signals: they are kept out of `model.signals`, so **AUTO never trades them**.

## Not implemented / caveats
- The trend filter in the video (Adaptive RSI 14/9 crossover decides which side to trade) and its 750-stock daily scanner (0.25% box).
  The page shows every triangle breakout; judge the trend yourself.
- History is 1-minute closes, so the box path is close-based, as for every other P&F signal on this page. The vertical count is an
  estimate from that path.
- Only confirmed (closed-bar) columns are used, so a triangle never repaints.

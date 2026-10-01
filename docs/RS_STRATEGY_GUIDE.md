# RS Strategy — user guide

Dashboard page: **Trading → RS Strategy** (`/rs-strategy`).

Scans every Nifty 500 stock for **relative strength against Nifty** and shows which ones are in a
buy, hold, sell or wait state, with a weekly-chart check and Buy/Sell buttons.

> **Read this first.** The rules come from a teaching video (Learn2Trade session 31, Vivek Bajaj) and the
> bharatTrader "Relative Strength" TradingView indicator. **They have not been backtested.** The page is a
> screening aid. A *Buy* is a stock that meets the rules today, not a recommendation or a promise of profit.
> The Buy/Sell buttons place **real orders** with your Dhan account.

---

## 1. The idea in one minute

A stock is **strong** when it has gained more than Nifty over the same period. The page measures that over
the last **55 trading days** (about 3 months), then asks two more questions: is the price above its
**Supertrend** line, and is **RSI** above 50?

- **Buy** when all three agree the stock is strong.
- **Stay in** while it stays strong. A single warning sign is not an exit.
- **Sell** only when both RS and Supertrend turn negative together.

---

## 2. The three indicators

| Indicator | Setting | Meaning |
|---|---|---|
| **RS** (relative strength) | 55 days vs Nifty 50 | `(stock price now ÷ stock price 55 days ago) ÷ (Nifty now ÷ Nifty 55 days ago) − 1`. Above 0 = beating Nifty. Below 0 = lagging. |
| **Supertrend** | period 10, multiplier 2 | A trailing line that sits **below** the price in an uptrend and **above** it in a downtrend. Price above the line = bullish. |
| **RSI** | period 14 | Momentum from 0 to 100. Above 50 = buyers are in control. |

RS is shown as a **plain ratio**, exactly as TradingView and StockEdge show it: **0.46 means the stock
beat Nifty by 46 percentage points** over the period. `0.10` or more is what StockEdge calls "strongly outperforming".

---

## 3. The four states

| State | Rule | What it means |
|---|---|---|
| **Buy** | RS > 0 **and** price above Supertrend **and** RSI > 50 | All signals agree. The entry condition is met now. |
| **Hold** | It was a Buy earlier, one signal has weakened, but RS and Supertrend are **not both negative** | Do not exit yet. A pullback in a strong stock is not a sell. |
| **Sell** | RS < 0 **and** price below Supertrend | Both signals are negative. This is the exit. |
| **Wait** | It has never met the Buy rule | Nothing to hold and nothing to buy yet. |

The states are worked out by walking through the stock's whole history day by day: *buy when the Buy rule is true,
leave only when the Sell rule is true.* So **Hold can reflect a buy from months ago**. Check the
**Bars in state** column to see how long.

---

## 4. Using the page

### Header
- **RS period** — the lookback in trading days (default 55, allowed 5–250). Type a number and press **Enter** or
  click away. The scan re-runs with the new period.
- **Recalculate** — runs the scan again. Use it after the data has been refreshed. If the numbers look a few
  minutes old, wait a moment and try again.
- **DATA: yyyy-mm-dd** — the date of the latest price data used. Today's live prices are included once the
  market is open.

### Tabs
**Buy · Hold · Sell · All**, each with a count. The default sort inside a tab is strongest RS first for Buy and Hold, weakest
first for Sell. Click any column heading to sort (click again to reverse). An arrow shows the active sort.

### Filter chips (they combine)
| Chip | Keeps only stocks that… |
|---|---|
| **RSI > 50** | (on by default) need RSI above 50 to count as a Buy. Turning it off re-runs the scan, so you will see more Buys and fewer Holds. |
| **RS ≥ 0.10** | outperform Nifty by 10 points or more |
| **RS rising 3d** | have had a higher RS on each of the last 3 sessions |
| **In portfolio** | you already hold, or have a position in today |
| **Weekly long** | are Buy or Hold on the **weekly** chart too |

### Search
Type part of a symbol to narrow the list.

---

## 5. The columns

| Column | What it shows |
|---|---|
| **Symbol** | NSE trading symbol. |
| **Held** | What you already own, from Dhan. The big number is your **delivery holding** (shares in your demat). Below it, small lines show **today's positions** such as `MIS −10` (Intraday) or `CNC +5`. `–` means nothing. Hover for your average cost. |
| **Close** | Latest closing price (live price during market hours). |
| **1D %** | Change since the previous close. |
| **RS-55** | The relative-strength ratio described above (the number in the header changes if you change the period). Green = beating Nifty, red = lagging. |
| **RS vs zero** | A small bar around a centre line. Right of the line (green) = RS above 0, left (red) = below. Longer = stronger, capped at ±1.0. |
| **Supertrend** | The Supertrend price level. Price above it = bullish. |
| **RSI** | RSI(14). Brighter when above 50. |
| **From ST %** | How far the price is from the Supertrend line: `(price − line) ÷ price`. A large positive number means the stock is **extended** above its trend line, so a fall back to it would be big. Small means it is close to the line, which is a tighter stop. |
| **Signal** | The state on the **daily** chart: Buy, Hold, Sell or Wait. |
| **Weekly** | The **same state on weekly candles**: the bigger-picture check (see below). `–` means under about 70 weeks of history, so there is no weekly signal. |
| **Bars in state** | How many daily bars the stock has been in its current phase. Buy and Hold count together (the time since the buy). Sell and Wait count together. |
| **Trade** | **Buy** and **Sell** buttons (see section 6). |

### Reading Signal together with Weekly
- **Buy + Weekly Buy** — both timeframes agree. The cleanest setup.
- **Buy + Weekly Sell or Wait** — a daily bounce inside a weak weekly trend. Take more care.
- **Sell or Wait + Weekly Buy** — a daily pullback inside a strong weekly trend. The video treats this as a possible
  buying opportunity when the stock is strong.

The weekly chart is built from the daily data: RS compares the last **55 weeks** with Nifty (about a year), and
Supertrend and RSI are also computed on weekly candles. The **current week counts as an unfinished bar**, so a
weekly state can still change before Friday.

---

## 6. Buy and Sell buttons (real orders)

Clicking **Buy** or **Sell** opens an order window for that stock. Nothing is sent until you press the final
button, which spells out the order, for example *"Buy 25 ENGINERSIN · Delivery · Limit"*.

### The window
- **Live price, available funds, what you hold** (total and sellable, plus average cost) and **today's positions**.
  **Refresh** reloads them.
- **Product** — **Delivery (CNC)** keeps the shares in your demat. **Intraday (MIS)** must be closed the same day.
- **Order type** — **Market** (fills at the going price) or **Limit** (you set the price; **Use live price** fills it in).
- **Quantity** — in shares. Use **+ / −**, type a number and press Enter, or **Sell all** to use everything you can sell.
- **After-market order (AMO)** — queues the order for the next market open. Tick it only when the market is closed.
- **Estimated value** — quantity × price.
- Press **Esc** to cancel an edit; press it again to close the window.

### Safety rules (enforced on the server, not only in the window)
| Rule | Detail |
|---|---|
| **You can only sell what you own** | **No short-selling from this page.** A Delivery sell can use at most your sellable holdings. An Intraday sell can use at most your open long Intraday position today. |
| Open sell orders count | Shares already tied up in a pending sell order cannot be sold again. |
| Max quantity | 10,000 shares per order |
| Max value | ₹5,00,000 per order. Split larger orders. |
| Limit price band | A limit price must be within **20%** of the live price (catches a mistyped price). |
| No price, no order | If the live price or your holdings cannot be read, nothing is sent. |
| One click, one order | A double click or retry cannot place the same ticket twice. |

The **Sell** button is greyed out on rows where you hold nothing. A Delivery sell of shares you bought **today** stays
blocked until they appear in your holdings (the next trading day).

### After you press the button
- **Order sent to Dhan** — Dhan accepted it. The order ID and status are shown. **Accepted does not mean filled**:
  check your Dhan order book.
- **Dhan accepted the request but the order is REJECTED** — see the order book for the reason.
- **Order status unknown** — the reply was lost or unclear. **Do not place it again.** Open your Dhan order book
  first to see whether it went through.
- A plain **error** (for example *"Limit … is more than 20% from the live price"*) means nothing was sent. Fix it and
  press the button again.

The **Held** column refreshes after an order, and every minute while the page is open.

> **First time?** Try a **1-share Limit order far below the market price** (it will not fill), or an AMO, and
> confirm it appears in your Dhan order book before relying on the buttons.

---

## 7. Good habits from the video

- The indicators are a guide. **Price confirms.** The video prefers entering on a break above the previous swing high.
- Expect false breakouts: even when every rule is met, around **4 in 10 can fail**. Spread risk across **5–6 stocks**
  instead of putting everything in one.
- A strong stock that dips is a chance to add, but a stock that turns weak on **both** RS and Supertrend is an exit.
- The video also suggests booking part of a position as it rises and rebuying near support. The page does not do this
  for you.

---

## 8. Limits and troubleshooting

| Situation | Explanation |
|---|---|
| Counts changed after turning **RSI > 50** off | Expected. Without the RSI rule more stocks qualify as Buy. |
| A stock shows **–** in Weekly | Under about 70 weeks of price history (recent listings). |
| **Held** is empty or shows a notice | Dhan holdings could not be read. Orders still re-check ownership on the server before any sale. |
| Numbers differ from TradingView | Check the symbol, the RS period and that the chart's RS uses the **close** vs **NIFTY** with the same length. Data here is Dhan-sourced daily closes. The values match TradingView for the same inputs. |
| "Could not get a live price" in the order window | The price service was busy. Nothing was ordered. Press **Refresh** and try again. |
| Scan feels stale | Press **Recalculate**. If the data itself is old, refresh it from the dashboard's **Sync Data** button first. |

**Not included:** Zerodha and Kotak accounts (Dhan only), stop-loss or bracket orders, intraday (2-hour) signals,
and any backtest of the rules.

---

*Developer notes (formulas, files, tests, caches): see `.claude/skills/dhan-rs-strategy/SKILL.md`.*

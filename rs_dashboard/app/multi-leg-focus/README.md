# Multi-Leg Focus — how to use

Build, place and manage multi-leg option strategies (straddles, strangles, spreads, condors, calendars and custom baskets) on NIFTY, BANKNIFTY, SENSEX, CRUDEOIL and CRUDEOILM. Several strategies can run side by side, each in its own row. **Orders placed here are real.**

## 1. Set up the header

- Pick the underlying with the ticker pills. The live spot and India VIX are shown next to them (**STALE** means the quote has stopped updating).
- **Broker** chooses where **new** strategies trade and whose funds and orders are shown. An existing strategy always trades on the broker badge in its own row.
- **Avail Margin** / **Used Margin** come from the broker. **Today** P&L covers open legs plus legs closed today — the same scope as the broker's positions page.
- If no broker is logged in, a banner says so. Log in from Autologin first.

## 2. Create a strategy

- Click a **preset** (straddle, strangle, iron condor, calendar, …) to create a row with its legs already filled in around ATM, or click **New Strategy Row** for an empty row and use **Add Leg**.
- In the row, choose the **Expiry**. Calendar and diagonal presets also have a **Far Expiry** for their far leg; far expiries only accept strikes in multiples of 100.
- Each leg has side (BUY/SELL), CE/PE, strike, lots and MARKET or LIMIT (click the price to edit a limit).
- The **multiplier** (− / +) scales every leg by its ratio, so a 1:2 ratio spread stays 1:2.
- Check the row before placing: net premium, required margin, breakevens and max profit/loss. Open the **Payoff Diagram** to see the curve; its days-forward and IV-shift sliders show the P&L before expiry.
- New strategies are saved automatically and stay after a page reload.

## 3. Place it

- Click **Place Basket**, then **Confirm Place?** within 4 seconds. The button reads **Insufficient Margin** and stays disabled when funds do not cover the basket.
- Hedges (BUY legs) are placed first, then the SELL legs. If a SELL leg fails after the hedges filled, the tool rolls the filled legs back.
- You will be asked to confirm if a leg has a wide bid/ask spread, if margin is only an estimate, or if another strategy already holds the same contract.

## 4. Manage an open strategy

- **Per leg:** stop loss and take profit in points or price, an optional **Trail** (the stop tightens ₹1 for each ₹1 in your favour), **Exit** this leg only, and add lots.
- **Shift:** move the CE legs, PE legs or all open legs up or down by N strikes. The old legs are closed before the new ones are opened.
- **Scale:** add +1× the multiplier to every open leg (BUYs first, then SELLs); click twice to confirm.
- **Add a new leg** to a strategy that is already running.
- **Strategy guard:** set a target and a stop loss in points or % of the premium in play, then tick **Arm Guard**. When it shows **Auto-Exit Armed**, the whole strategy exits when either level is reached. The guard never fires while any leg has no live price.
- **Greeks** (Σ button) computes the net Delta, Gamma, Theta and Vega for the strategy.
- **Exit Strategy** closes the SELL legs first and only then the hedges, so you are never left naked short.

> Stop losses, take profits, trailing stops and the strategy guard run **in this browser tab**. Keep the page open while they need to act.

## 5. Other buttons

- **Orders** — today's broker orders and trades; modify or cancel pending orders from here.
- **Import** — group positions you took outside this tool into a strategy. No orders are placed.
- **History** — strategies closed on earlier days, with their realized P&L.
- **Option Chain** — the chain with IV and Greeks for the selected underlying.
- **Refresh** — reload quotes and margins now.

## Good to know

- Each strategy keeps its own record of what it filled. Two strategies holding the same contract share one broker position; the tool sizes each exit from its own record, so exiting one never closes the other's share.
- If the broker shows more or less than a leg's record (you traded that contract elsewhere), the leg shows an **Untracked** or **Over** warning. Use **Claim** to adopt the extra quantity, or **Reduce** to log a close you made outside the tool — neither places an order.
- An order the broker accepts can still be rejected a few seconds later. The tool checks the order book and undoes the leg's record if that happens, with a red notification.

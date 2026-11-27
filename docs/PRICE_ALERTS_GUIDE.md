# Price Alerts — user guide

TradingView-style price alerts that run on the **dashboard server**, so they keep working with every tab closed. They stop when the dashboard server stops.

## Opening them
- **Header:** the alarm-clock button in every page header. The badge counts active alerts. It is amber, or red when REAL orders are armed for today.
- **Index Scalper chart:** use the price-axis **"+"** menu, then **Add alert on … at …**. The dialog opens on that chart's instrument (NIFTY index, the future, or the option premium) at the clicked price.

## An alert
| Field | Meaning |
|---|---|
| Symbol | **NIFTY** (index, future or option) or MCX **CRUDEOIL** / **CRUDEOILM** (future or option; crude has no index). Expiries and strikes are filled in automatically from `master_list.csv`: the nearest expiry and the ATM strike. Security ids are resolved on the server. |
| Condition | **Crossing**, **Crossing Up** and **Crossing Down** fire when the price moves past the value between two ticks. **Greater Than** and **Less Than** fire while the price is on that side of the value. |
| Trigger | **Once only** stops the alert after it fires. **Every time** can fire again, with at most one fire per 10 s. A Greater/Less Than alert fires again only after the price has gone back to the other side. |
| Expiration | Choose one of the valid expiries. The default is the contract's own expiry, or the nearest NIFTY expiry for the index. The alert stops at that day's session close (NSE 15:30; MCX 23:30 or 23:55). You can also pick Today's close, Open-ended or a custom date and time. A contract alert also stops when its contract expires. |
| Sound | The alarm length in seconds (default 3, set in the panel; 1-60). |
| Action | **Notify**, or **Place order**: one MARKET order on **Dhan** or **Kotak** (BUY/SELL, 1-10 lots, MIS/NRML) on a fixed future or option chosen in the dialog. Opened from the Index Scalper chart, the broker defaults to the page's broker. |

The first price the server sees for an alert is only a baseline. A crossing never fires on it, so a restart or a stale packet cannot fire one.

## Order alerts (real money)
- An order alert is always **Once only**.
- An order alert never fires on the first price it sees, Greater Than / Less Than included. If the price is already past the level when you create it (or after a server restart), it waits until the price has been on the other side and comes back.
- An MIS order is not sent from the intraday cutoff on: NSE 15:17 and the MCX auto-exit, both taken from the dashboard's Settings cutoffs. The alert still notifies. NRML orders run until the close.
- It sends its order only when all of these hold:
  - **REAL orders armed today** is switched on in the panel (the switch resets at midnight IST);
  - the exchange is in session (NSE 09:15-15:30; MCX in its own hours);
  - the contract has not expired.

  When any of these fails, the alert still notifies, and the log shows *order skipped* with the reason.
- **The arm is separate from every terminal's SIM / REAL switch.** Switching the Index Scalper (or any page) to REAL
  does not arm alert orders, and an alert carries no SIM / REAL mode of its own: only the panel's daily arm counts, at
  the moment the alert fires. Two warnings keep this from costing a trade:
  - **NOT ARMED on the chart:** on the Index Scalper, an active order alert's chip shows *NOT ARMED* and an **Arm**
    button while today is not armed (the line's label ends in "· NOT ARMED").
  - **Market-open reminder:** when NSE or MCX is open (or a page loads in session) and an active, unexpired order alert
    on that market would be skipped only for want of arming, every tab shows a toast that stays until you arm or close
    it, with an **Arm** button, and the leader tab plays the warning chime (after your first click on the page). Once
    per market per day per tab. It counts only the alerts arming would send now (open market, unexpired); cancelling
    the Arm confirm shows it again, and only its × dismisses it for the day.

  Every Arm asks the same confirm as the panel's switch.
- The alert is marked as firing on disk **before** the order is sent. An order whose outcome is unknown is recorded as `unknown` and **never resent**; check the order book. Orders are tagged with correlation id prefix `pa` and capped at 10 lots (`lib/dhanSourceCaps.ts`).
- **Kotak orders** (added 2026-11-27):
  - The contract is looked up in Kotak's own instrument list (`kotak_instruments_cache.py`) when the alert is **saved**,
    and stored on the alert (trading symbol + Kotak lot). Saving fails when Kotak does not list it, or when Kotak's lot
    disagrees with the master list (NSE) or with the barrels per lot (MCX: CRUDEOILM 10, CRUDEOIL 100).
  - Quantity = lots x Kotak's lot: NSE units, MCX **barrels** (3 CRUDEOILM lots = 30). Capped at 10 lots by Kotak's
    `pa` source cap (`SOURCE_LOT_CAPS`), and by the freeze quantity.
  - Crude on Kotak is **NRML only**: Kotak's RMS accepts a fresh MIS crude order and then rejects it.
  - Sent through `placeKotakOrder` (placed / rejected / unknown; the Kotak day lock applies). Without a valid Kotak session
    nothing is sent (recorded *rejected*). Kotak can reject an order after giving it a number, so a placed order is read back
    from the order book 2.5 s and 5.5 s later; a rejection then is recorded as *rejected* with Kotak's reason.
  - The order is not one of the Index Scalper's own (it is not in its Kotak day file), like a Dhan `pa` order: the
    page's Exit All asks before closing it, as for any position opened elsewhere.
- Editing or restarting a fired order alert re-arms it, so it will place a **new** order the next time it fires.

## Health warnings in the panel
- **The alert watcher is not running:** the server is not evaluating alerts, so none will fire. Restart the dashboard.
- **No live price for …:** an alert has had no usable WebSocket price for 20 s or more (for example the price bridge or the hub is down), so it cannot fire until the feed returns.

## Sound
- If a dashboard tab is open, **one** tab (the leader) plays the alarm and every tab shows a toast with **Stop sound**. Only the leader tab keeps a live stream; other tabs check every 5 s.
- The browser only allows sound after you click a page once. Until you click the leader tab, the server keeps playing alarms on the speakers.
- If no tab is open, the server plays the alarm on the PC's speakers (`pw-play`, else `aplay`, on Linux only).

## Files
- `debug/price_alerts.json` holds the alerts, the arm date and the default sound length.
- `debug/price_alerts_log.json` holds the last 500 fired events.
- Prices come from `scripts/tools/price_ladder_ws.py --name price_alerts`, which uses the shared Market Data Hub connection. It makes no REST quote calls.

Code:
- `rs_dashboard/lib/priceAlerts.ts` — pure rules and tests
- `lib/priceAlertServer.ts` — watcher
- `app/api/price-alerts/` — API and SSE stream
- `components/priceAlerts/` — panel, dialog and the global listener

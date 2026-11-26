# Price Alerts — user guide

TradingView-style price alerts that run on the **dashboard server**, so they keep working with every tab closed. They stop when the dashboard server stops.

## Opening them
- **Header:** the alarm-clock button in every page header. The badge counts active alerts. It is amber, or red when REAL orders are armed for today.
- **Index Scalper chart:** use the price-axis **"+"** menu, then **Add alert on … at …**. The dialog opens on that chart's instrument (NIFTY index, the future, or the option premium) at the clicked price.

## An alert
| Field | Meaning |
|---|---|
| Symbol | An index (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX), a future, or an option strike (its premium). Security ids are resolved on the server from `master_list.csv`. |
| Condition | **Crossing**, **Crossing Up** and **Crossing Down** fire when the price moves past the value between two ticks. **Greater Than** and **Less Than** fire while the price is on that side of the value. |
| Trigger | **Once only** stops the alert after it fires. **Every time** can fire again, with at most one fire per 10 s. A Greater/Less Than alert fires again only after the price has gone back to the other side. |
| Expiration | Open-ended, or a date and time. An alert also expires when its option or future expires. |
| Sound | The alarm length in seconds (default 3, set in the panel; 1-60). |
| Action | **Notify**, or **Place order**: one Dhan MARKET order (BUY/SELL, 1-10 lots, MIS/NRML) on a fixed future or option chosen in the dialog. |

The first price the server sees for an alert is only a baseline. A crossing never fires on it, so a restart or a stale packet cannot fire one.

## Order alerts (real money)
- An order alert is always **Once only**.
- It sends its order only when all of these hold:
  - **REAL orders armed today** is switched on in the panel (the switch resets at midnight IST);
  - the exchange is in session (NSE 09:15-15:30; MCX in its own hours);
  - the contract has not expired.

  When any of these fails, the alert still notifies, and the log shows *order skipped* with the reason.
- The alert is marked as firing on disk **before** the order is sent. An order whose outcome is unknown is recorded as `unknown` and **never resent**; check the order book. Orders are tagged with correlation id prefix `pa` and capped at 10 lots (`lib/dhanSourceCaps.ts`).
- Editing or restarting a fired order alert re-arms it, so it will place a **new** order the next time it fires.

## Sound
- If a dashboard tab is open, **one** tab plays the alarm and every tab shows a toast with **Stop sound**. The browser only allows sound after you click a page once.
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

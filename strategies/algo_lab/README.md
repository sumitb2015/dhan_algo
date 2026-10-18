# Algo Lab — one Live + Backtest interface for automated strategies

Dashboard: [`/algo-lab`](http://localhost:3000/algo-lab) (`?strategy=<key>&tab=live|backtest`).
Code: `rs_dashboard/lib/algoLab/` (pure), `rs_dashboard/components/algoLab/` (UI), `rs_dashboard/app/api/algo-lab/`.

Pick a strategy in the header and the same two tabs drive it:

- **Live** — a browser-tab auto-trader (SIM paper or REAL Dhan/Kotak orders) with the Breakdown Scalper's safety model.
- **Backtest** — an offline minute-by-minute replay of the local options DB through the same strategy code, with a
  computed integrity audit.

A strategy is **one TypeScript module**. It never knows whether it runs live or in the backtest: both build the same
`AlgoCtx` (closed bars only) and call the same functions, so the backtest tests the code that trades.

## Adding a strategy

1. Write its spec here: `strategies/algo_lab/<key>.md` (rules, parameters, what it has NOT been validated on).
2. Create `rs_dashboard/lib/algoLab/strategies/<camelKey>.ts` exporting a `StrategyDefinition`
   (`lib/algoLab/types.ts`):

   | Member | Job |
   |---|---|
   | `key`, `label`, `description`, `docPath`, `side` (`BUY`/`SELL`), `underlyings`, `status` | Identity. `status: 'UNVALIDATED'` shows a badge |
   | `schema` + `defaults` | Its own settings. The base settings (timeframe, strike window, caps, lots, loss limit, entry window, EOD, brokerage, slippage, skip-cold) are added automatically. The rules drawer, server validation and the backtest's "rules changed" stamp all come from this list |
   | `warmupBars(c)` | 1-minute bars a contract needs before its signal matches live (the audit's cold-entry threshold) |
   | `gate(ctx, c)` | Market bias and the option types an entry may use now |
   | `scan(ctx, c, gate)` | Every contract as a `Candidate` (score 0-100, `eligible`, `blockReason`, display `cols`), best first |
   | `onEntry(cand, price, c)` | Initial stop and target (and optional `state`) for an entry at `price` |
   | `manage(pos, px, ctx, c)` | Proposed stop and any strategy exits (`{kind, level, reason}`) at price `px` |
   | `columns.scanner` | Which `cols` to show in the scanner, positions table and trade log |

3. Add it to `STRATEGIES` in `lib/algoLab/registry.ts`.
4. Tests next to it (`<camelKey>.test.ts`): gate per regime, a fresh signal is eligible, a stale/blocked one is not,
   `manage` exits. `npm test` picks them up.

Reusable helpers: `lib/algoLab/bars.ts` (`closedTfBars`, `ewmLast`, `closeMean`, EMA / Supertrend / session VWAP),
`lib/algoLab/risk.ts` (`initialStop`, `targetOf`, `lockAndTrail`, `targetHit`, side-aware). The proof strategy
`vwapMomentumBuyer.ts` is the template.

## What the framework enforces (a strategy cannot opt out)

- Signals from **closed** bars only; decision time = start of the current minute.
- Stops only tighten (SELL down, BUY up) — clamped in `stepPosition`, the ledger and the simulator; the best price only
  improves. The stop itself is always checked; a strategy only adds exits.
- Caps (max open, max per CE/PE side), 5-minute re-entry lock per contract, 30 s cooldown (live), entry window,
  EOD square-off, daily loss limit (today, active mode), and an account-wide REAL loss cap across all strategies
  (`/api/algo-lab/account`, default ₹10,000).
- Live: one leader tab per strategy; order outcomes are ok / failed / **unknown** (never resent automatically); exit
  state shared across tabs; halts on unknown entries/exits, unrecorded orders, 3 rejected auto entries; stale feed /
  index bars pause entries, never exits; chain pinned to the open positions' expiry; EOD exits even without a quote.
- Orders: Dhan via `/api/scalper/fast-order` (security id, INTRADAY), Kotak via `/api/scalper/kotak/order` (trading
  symbol, MIS); entries carry source `alab` (20-lot server cap), exits `alx` (never capped).

## Backtest fill model (`lib/algoLab/simulator.ts`)

- Entry at the open of the minute after the signal (± slippage); costs per order (`lib/algoLab/costs.ts`, Dhan F&O).
- Inside each bar: SELL walks O → H → L → C, BUY O → L → H → C (adverse first). At every point `stepPosition` updates
  the best price and stop and picks the exit the price reaches first; fills lie on the traded segment.
- A position closed inside bar m holds its slot (and counts in the loss limit) for entries at bar m's open.
- EOD at the cutoff bar's open.
- `results.json` `audit` re-checks every trade (P&L, costs, chronology, stop/target sizing, fills inside the bar,
  slots/side at the open, re-entry lock, warm-up by weekday, cold entries).

## Known live / backtest differences

| | Live | Backtest |
|---|---|---|
| Data | Dhan options WS + intraday API bars | `Options Data/nifty_options.db` (NIFTY only, ATM ± 10 strikes per minute) |
| `ctx.contracts[k].ltp` | current print | last closed 1-minute close |
| Fills | MARKET order after the price crosses (checked once a second); ledger books the decision LTP | at the level (± slippage) |
| Warm-up | previous 2 sessions of every strike | previous session, and only strikes the DB held then: Wednesdays (new weekly contract) and far strikes start **cold** |
| Index | 1-minute closes (intraday API) + LTP minutes | 1-minute closes from the DB |
| Volume after the last backfill | LTP-built minutes have volume 0 (VWAP ignores them) | full volume |

Read the audit's cold-entry share before trusting a result; "Skip cold contracts" in the rules excludes them.

## Files

- Ledgers: `debug/algo_lab/<key>_state.json` (git-ignored). Backtests: `debug/algo_lab/<key>_backtest/`
  (`results.json`, `status.json`, `run.lock`, `stop.trigger`, `runner.log`). Shared day cache: `debug/algo_lab/data/`.
- Runner by hand: `cd rs_dashboard && node scripts/algo-lab-backtest.ts --strategy <key> --mode rerun --window db4`.
- Data: `scripts/tools/algo_lab_backtest_data.py` (offline, options DB); live index bars:
  `scripts/tools/algo_lab_spot_bars.py` via `/api/algo-lab/spot`.

Not supported yet: multi-leg positions (the ledger's `legs[]` is ready, v1 refuses more than one), underlyings other
than NIFTY in the backtest, multi-day positions.

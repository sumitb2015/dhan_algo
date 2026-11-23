"""
Nifty 500 Momentum Investing Portfolio — autonomous positional equity strategy.

Holds up to N momentum stocks ranked by composite relative strength versus the benchmark
(Nifty 50 by default). Stops and new entries are checked every session; the rank-rotation
review runs once a week. Slots are sized off current equity (--no-compound: off --capital).

Every rule lives in lib/momentum.py, which the backtest
(scripts/analysis/backtest_momentum_portfolio.py) imports too — so what was validated on
history is what runs here. Do not reimplement ranking or exit logic in this file.

HOW THIS DIFFERS FROM EVERY OTHER STRATEGY IN THIS REPO
  * It spans days/weeks, not one session. Positions MUST survive a restart, so the book is
    persisted to debug/<state_key>_portfolio.json after every mutation and reloaded on
    startup. No other strategy here does this (the crudeoil ones restore P&L only).
  * It acts once per trading day near the close rather than polling a live feed.
  * It trades CNC delivery, not INTRADAY/MARGIN. helper.place_entry() defaults to MARGIN,
    so the product type is passed explicitly at every call site.

EXECUTION TIMING vs THE BACKTEST
  The backtest generates signals from day D's close and fills at day D+1's open. Live, the
  cycle runs at --run-at (default 15:20 IST) and fills immediately at LTP, because carrying
  orders overnight would add a failure mode for very little fidelity. Two consequences worth
  knowing: the "close" used for ranking is a near-final 15:20 price, and fills do not carry
  the overnight gap risk the backtest charges itself. Neither flatters live results.

Usage (dry run by default — no real orders without --live):
    venv\\Scripts\\python.exe strategies/momentum_investing/nifty500_momentum.py
    venv\\Scripts\\python.exe strategies/momentum_investing/nifty500_momentum.py --once
    venv\\Scripts\\python.exe strategies/momentum_investing/nifty500_momentum.py --live --capital 200000
"""

import argparse
import json
import os
import sys
import time
import traceback
from datetime import date, datetime, timedelta

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, PROJECT_ROOT)

from login import get_dhan_client                                        # noqa: E402
from lib.dhan_helper import DhanHelper                                   # noqa: E402
from lib.nse_holidays import is_nse_trading_day                          # noqa: E402
from lib.strategy_state_helper import (                                  # noqa: E402
    save_strategy_state, check_shutdown_trigger, instance_log_suffix,
)
from lib.algo_kit import setup_strategy_logging  # noqa: E402
from lib import data_quality, minervini, ema_supertrend                           # noqa: E402
from lib.momentum import (                                               # noqa: E402
    MomentumConfig, Position, STAGE_TRAIL,
    build_regime_daily, build_rs_matrix, build_tables,
    load_benchmark, load_price_map, load_universe,
    latest_data_date, rank_rotation_exits, rank_universe, ranks_by_symbol, rotation_due,
    select_candidates, size_position, passes_entry_filters, sector_counts,
)

# ── logging ───────────────────────────────────────────────────────────────────
logger = setup_strategy_logging(PROJECT_ROOT, "momentum_investing", instance_log_suffix(), name=__name__, force=True)

DEBUG_DIR = os.path.join(PROJECT_ROOT, "debug")
PORTFOLIO_VERSION = 1


class MomentumPortfolioStrategy:
    def __init__(self, cfg: MomentumConfig, dry_run: bool = True,
                 state_key: str = "nifty500_momentum", run_at: str = "15:20",
                 run_once: bool = False, model: str = "turtle_rs"):
        self.cfg = cfg
        self.model = model          # "turtle_rs" (daily entries, weekly RS rotation), "minervini" / "ema_supertrend" (daily entries)
        self.rs_pct: dict[str, float] = {}
        self.dry_run = dry_run
        self.state_key = state_key
        self.run_at = run_at
        self.run_once = run_once

        self.helper = None
        self.positions: dict[str, Position] = {}
        self.cash = cfg.capital
        self.realized_pnl = 0.0
        self.closed_trades: list[dict] = []
        self.cooldowns: dict[str, date] = {}
        self.last_cycle_date: date | None = None
        self.last_review_date: date | None = None
        self.last_rotation_date: date | None = None   # rank rotation runs at most once per ISO week

        # Market data, rebuilt each cycle.
        self.universe: list[dict] = []
        self.industries: dict[str, str] = {}
        self.price_map: dict = {}
        self.tables: dict = {}
        self.bench = None
        self.calendar = None
        self.data_date: date | None = None
        self.ranking: list = []
        self.ranks: dict[str, int] = {}
        self.last_alert = ""

    # ── portfolio persistence ────────────────────────────────────────────────
    @property
    def portfolio_path(self) -> str:
        return os.path.join(DEBUG_DIR, f"{self.state_key}_portfolio.json")

    def load_portfolio(self) -> None:
        """Restore the book from disk. A multi-day strategy that forgets its positions on
        restart would re-buy names it already owns and never exit the originals."""
        path = self.portfolio_path
        if not os.path.exists(path):
            logger.info(f"No existing portfolio at {path} — starting flat with "
                        f"Rs {self.cfg.capital:,.0f}")
            return
        try:
            with open(path, "r") as f:
                data = json.load(f)
        except Exception as e:
            # Refuse to silently start flat on a corrupt file — that would double-buy.
            logger.error(f"FATAL: portfolio file {path} is unreadable ({e}). "
                         f"Fix or move it before restarting; refusing to trade blind.")
            raise

        # A book built under one model must not be managed by the other: their stop ladders differ, so the
        # wrong rules would silently move the stops. Files written before --model existed are turtle_rs.
        saved_model = data.get("model", "turtle_rs")
        if saved_model != self.model:
            msg = (f"FATAL: {path} holds a '{saved_model}' book but this run is --model {self.model}. "
                   f"Run it with --model {saved_model}, or start this model under its own --instance-id.")
            logger.error(msg)
            raise SystemExit(msg)

        self.cash = float(data.get("cash", self.cfg.capital))
        self.realized_pnl = float(data.get("realized_pnl", 0.0))
        self.closed_trades = data.get("closed_trades", [])
        self.positions = {p["symbol"]: Position.from_dict(p, self.cfg)
                          for p in data.get("positions", [])}
        self.cooldowns = {s: datetime.fromisoformat(d).date()
                          for s, d in (data.get("cooldowns") or {}).items()}
        for key in ("last_cycle_date", "last_review_date", "last_rotation_date"):
            raw = data.get(key)
            if raw:
                setattr(self, key, datetime.fromisoformat(raw).date())

        logger.info(f"Restored portfolio: {len(self.positions)} positions, "
                    f"cash Rs {self.cash:,.0f}, realized Rs {self.realized_pnl:,.0f}")
        for sym, pos in self.positions.items():
            logger.info(f"  {sym:<14} {pos.qty} @ Rs {pos.entry_price:,.2f} "
                        f"since {pos.entry_date}  stop Rs {pos.stop_price:,.2f} ({pos.stage_label()})")

    def save_portfolio(self) -> None:
        """Atomic write — a torn portfolio file is the one thing that could lose the book."""
        data = {
            "version": PORTFOLIO_VERSION,
            "state_key": self.state_key,
            "model": self.model,
            "dry_run": self.dry_run,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
            "capital": self.cfg.capital,
            # Config echo: the dashboard falls back to this file when no state file exists
            # (the normal case for a positional strategy that is stopped between cycles),
            # and without these it renders nonsense like "5/0 slots".
            "slots": self.cfg.slots,
            "universe": self.cfg.universe,
            "cash": self.cash,
            "realized_pnl": self.realized_pnl,
            "positions": [p.to_dict() for p in self.positions.values()],
            "cooldowns": {s: d.isoformat() for s, d in self.cooldowns.items()},
            "closed_trades": self.closed_trades[-500:],
            "last_cycle_date": self.last_cycle_date.isoformat() if self.last_cycle_date else None,
            "last_review_date": self.last_review_date.isoformat() if self.last_review_date else None,
            "last_rotation_date": self.last_rotation_date.isoformat() if self.last_rotation_date else None,
        }
        os.makedirs(DEBUG_DIR, exist_ok=True)
        tmp = self.portfolio_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, self.portfolio_path)

    # ── dashboard state ──────────────────────────────────────────────────────
    def save_state(self, status: str = "RUNNING", prices: dict | None = None) -> None:
        prices = prices or {}
        unrealised = 0.0
        holdings = []
        for sym, pos in self.positions.items():
            px = prices.get(sym, pos.last_close)
            unrealised += pos.unrealised(px)
            holdings.append({
                "symbol": sym, "industry": pos.industry, "qty": pos.qty,
                "entry_price": round(pos.entry_price, 2), "ltp": round(px, 2),
                "unrealised": round(pos.unrealised(px), 2),
                "unrealised_pct": round(pos.gain_pct(px), 2),
                "stop_price": round(pos.stop_price, 2), "stage": pos.stage_label(),
                "entry_date": pos.entry_date.isoformat(),
                "hold_days": pos.hold_days(self.data_date or date.today()),
                "rank": self.ranks.get(sym), "rank_at_entry": pos.rank_at_entry,
                "rank_strikes": pos.rank_strikes,
            })
        holdings.sort(key=lambda h: h["unrealised_pct"], reverse=True)

        invested = sum(p.entry_price * p.qty for p in self.positions.values())
        equity = self.cash + invested + unrealised
        next_review = (self.calendar.next_review_day(self.data_date)
                       if self.calendar and self.data_date else None)

        counts = sector_counts(self.positions)
        top_ranks_data = []
        for s, rs in self.ranking[:25]:
            industry = self.industries.get(s, "")
            item_status = "QUALIFIED"
            if s in self.positions:
                item_status = "HELD"
            elif s in self.cooldowns and self.data_date and self.data_date < self.cooldowns[s]:
                item_status = f"Cooldown until {self.cooldowns[s]}"
            elif counts.get(industry, 0) >= self.cfg.sector_cap:
                item_status = f"Sector cap ({industry})"
            elif self.tables and self.data_date:
                ok, reason = self.entry_ok(s)
                if not ok:
                    item_status = reason
            top_ranks_data.append({
                "symbol": s,
                "rs": round(rs, 4),
                "industry": industry,
                "status": item_status,
            })

        save_strategy_state(self.state_key, {
            "strategy": "Nifty 500 Momentum Portfolio",
            "model": self.model,
            "status": status,
            "dry_run": self.dry_run,
            "capital": self.cfg.capital,
            "cash": round(self.cash, 2),
            "invested": round(invested, 2),
            # Share of current equity at cost — with compounding the slots scale with equity, not capital.
            "deployed_pct": round(invested / equity * 100, 1) if equity > 0 else 0,
            "compound": self.cfg.compound,
            "positions": len(self.positions),
            "slots": self.cfg.slots,
            "realized_pnl": round(self.realized_pnl, 2),
            "unrealised_pnl": round(unrealised, 2),
            "total_pnl": round(self.realized_pnl + unrealised, 2),
            "equity": round(equity, 2),
            "holdings": holdings,
            "top_ranks": top_ranks_data,
            "data_date": self.data_date.isoformat() if self.data_date else None,
            # With the filter disabled every day reports ON, which would read on the dashboard
            # as "the market is in an uptrend" rather than "we are not checking". Both flags
            # are published so the UI can tell those apart.
            "regime_enabled": self.cfg.regime_enabled,
            "regime_sma": self.cfg.regime_sma,
            "regime_exit": self.cfg.regime_exit,
            "regime": bool(self.calendar.is_on(self.data_date))
            if (self.calendar and self.data_date) else None,
            "last_review": self.last_review_date.isoformat() if self.last_review_date else None,
            "next_review": next_review.isoformat() if next_review else None,
            "alert": self.last_alert,
            "closed_trades": self.closed_trades[-20:],
        })

    # ── market data ──────────────────────────────────────────────────────────
    def refresh_market_data(self) -> bool:
        """Reload CSVs, rebuild indicators and the ranking. False if data is unusable."""
        logger.info("Loading universe and price history...")
        self.universe = load_universe(self.cfg.universe)
        self.industries = {u["symbol"]: u["industry"] for u in self.universe}
        self.bench = load_benchmark(self.cfg.benchmark)
        self.price_map = load_price_map([u["symbol"] for u in self.universe],
                                        min_bars=self.cfg.min_history_bars)
        if not self.price_map:
            self.last_alert = "No price data loaded"
            logger.error(self.last_alert)
            return False
        for w in data_quality.find_suspect_breaks(self.price_map, bench=self.bench):
            if (date.today() - date.fromisoformat(w["date"])).days <= 400:       # inside the indicator lookback
                logger.warning(f"DATA WARNING {w['symbol']} {w['date']}: close {w['prev_close']} -> {w['close']} "
                               f"(x{w['ratio']}) looks like an unadjusted corporate action — its ranking and stops "
                               f"may be wrong; repair with scripts/downloader/repair_symbol_history.py")

        self.tables = build_tables(self.price_map, self.cfg)
        self.calendar = build_regime_daily(self.bench, self.cfg)
        self.data_date = latest_data_date(self.price_map)

        # Freshness guard. This strategy ranks off the same CSVs the dashboard reads; if the
        # EOD refresh has not run, ranking on stale prices would rotate the book on fiction.
        stale_days = (date.today() - self.data_date).days if self.data_date else 999
        if stale_days > 4:
            self.last_alert = (f"STALE DATA: newest bar is {self.data_date} "
                               f"({stale_days} days old). Run refresh_dashboard_data.py.")
            logger.error(self.last_alert)
            return False
        if stale_days > 1:
            logger.warning(f"Newest bar is {self.data_date} ({stale_days} days old)")

        matrix = build_rs_matrix(self.price_map, self.bench, self.cfg.gap_reset_days)
        self.ranking = rank_universe(self.price_map, self.bench, self.data_date, self.cfg,
                                     matrix=matrix)
        self.ranks = ranks_by_symbol(self.ranking)
        if self.model == "minervini":
            minervini.add_tables(self.price_map, self.tables)
            self.rs_pct = minervini.rs_percentiles(self.ranking)
        elif self.model == "ema_supertrend":
            ema_supertrend.add_tables(self.price_map, self.tables)
            self.rs_pct = minervini.rs_percentiles(self.ranking)
        logger.info(f"Loaded {len(self.price_map)} symbols, data date {self.data_date}, "
                    f"{len(self.ranking)} ranked, regime "
                    f"{'ON' if self.calendar.is_on(self.data_date) else 'OFF'}")
        return True

    def current_prices(self) -> dict[str, float]:
        """LTP for held symbols, falling back to the latest close.

        bulk_ltp batches into one request per segment — never loop get_ltp over a portfolio,
        the Dhan quote endpoint is rate-limited to roughly 1 req/s.
        """
        prices: dict[str, float] = {}
        for sym, pos in self.positions.items():
            row = self.tables.get(sym, {}).get("px", {}).get(self.data_date)
            prices[sym] = float(row.close) if row is not None else pos.last_close

        if not self.positions or self.helper is None:
            return prices
        try:
            live = self.helper.bulk_ltp(list(self.positions.keys()))
            for sym, ltp in (live or {}).items():
                if ltp and ltp > 0:
                    prices[sym] = float(ltp)
        except Exception as e:
            logger.warning(f"bulk_ltp failed ({e}) — using latest closes")
            if getattr(self.helper, "last_api_error", None):
                logger.warning(f"  last_api_error: {self.helper.last_api_error}")
        return prices

    # ── execution ────────────────────────────────────────────────────────────
    def execute_buy(self, symbol: str, qty: int, price: float) -> float | None:
        """Returns the fill price, or None if the order failed. Paper fill in dry run."""
        if self.dry_run:
            logger.info(f"  [PAPER] BUY  {qty} {symbol} @ Rs {price:,.2f}")
            return price

        if not self.helper:
            logger.error("  LIVE BUY failed: helper is None")
            self.last_alert = "Dhan helper not initialized for live orders"
            return None

        # Broker fund check
        try:
            funds = self.helper.dhan.get_fund_limits()
            if isinstance(funds, dict) and funds.get("status") == "success":
                data = funds.get("data", {})
                avail = float(data.get("availabelBalance", 0.0) or data.get("availableBalance", 0.0) or 0.0)
                needed = price * qty
                if avail > 0 and needed > avail:
                    logger.error(f"  LIVE BUY skipped for {qty} {symbol}: insufficient broker margin "
                                 f"(need ~Rs {needed:,.0f}, available Rs {avail:,.0f})")
                    self.last_alert = f"Insufficient broker funds for {symbol}"
                    return None
        except Exception as e:
            logger.warning(f"Could not check broker fund limits: {e}")

        logger.info(f"  [LIVE] Placing CNC BUY order for {qty} {symbol} @ market...")
        try:
            order_id = self.helper.place_entry(
                symbol=symbol,
                quantity=qty,
                direction="BUY",
                order_type="MARKET",
                product_type="CNC",
            )
            if not order_id:
                logger.error(f"  LIVE BUY order placement rejected for {qty} {symbol}")
                self.last_alert = f"Live order rejected for {symbol}"
                return None

            filled = self.helper.wait_for_fill(order_id, timeout=30)
            if not filled:
                status = self.helper.get_order_status(order_id)
                logger.error(f"  LIVE BUY order {order_id} for {symbol} not filled (status: {status})")
                self.last_alert = f"Order {order_id} ({symbol}) not filled ({status})"
                if status in ("PENDING", "TRANSIT"):
                    self.helper.cancel_order(order_id)
                return None

            order_details = self.helper.get_order_by_id(order_id) or {}
            fill_price = float(order_details.get("tradedPrice") or order_details.get("price") or price)
            if fill_price <= 0:
                fill_price = price
            logger.info(f"  [LIVE] BUY FILLED: {qty} {symbol} @ Rs {fill_price:,.2f} (order ID: {order_id})")
            return fill_price
        except Exception as e:
            logger.error(f"  Exception placing live buy order for {symbol}: {e}")
            self.last_alert = f"Live buy error: {e}"
            return None

    def execute_sell(self, symbol: str, qty: int, price: float, reason: str) -> float | None:
        if self.dry_run:
            logger.info(f"  [PAPER] SELL {qty} {symbol} @ Rs {price:,.2f}  ({reason})")
            return price

        if not self.helper:
            logger.error("  LIVE SELL failed: helper is None")
            self.last_alert = "Dhan helper not initialized for live orders"
            return None

        # Reconcile target exit quantity against broker holdings
        try:
            holdings_df = self.helper.get_holdings()
            if not holdings_df.empty and "tradingSymbol" in holdings_df.columns:
                match = holdings_df[holdings_df["tradingSymbol"].str.startswith(symbol)]
                if not match.empty:
                    avail_qty = int(match.iloc[0].get("totalQty", 0) or match.iloc[0].get("availableQty", 0))
                    if avail_qty < qty:
                        logger.warning(f"  Holdings report {avail_qty} shares for {symbol}, clamping sell from {qty} to {avail_qty}")
                        qty = avail_qty
                    if qty <= 0:
                        logger.error(f"  No holdings found at broker for {symbol}. Skipping sell.")
                        self.last_alert = f"No holdings at broker for {symbol} to sell"
                        return None
        except Exception as e:
            logger.warning(f"Could not verify broker holdings: {e}")

        logger.info(f"  [LIVE] Placing CNC SELL order for {qty} {symbol} ({reason})...")
        try:
            order_id = self.helper.place_entry(
                symbol=symbol,
                quantity=qty,
                direction="SELL",
                order_type="MARKET",
                product_type="CNC",
            )
            if not order_id:
                logger.error(f"  LIVE SELL order placement failed for {qty} {symbol}")
                self.last_alert = f"Sell order rejected for {symbol} (Verify CDSL eDIS / DDPI authorization!)"
                return None

            filled = self.helper.wait_for_fill(order_id, timeout=30)
            if not filled:
                status = self.helper.get_order_status(order_id)
                logger.error(f"  LIVE SELL order {order_id} for {symbol} not filled (status: {status})")
                self.last_alert = f"Sell order {order_id} ({symbol}) not filled ({status}) — verify CDSL eDIS / DDPI"
                if status in ("PENDING", "TRANSIT"):
                    self.helper.cancel_order(order_id)
                return None

            order_details = self.helper.get_order_by_id(order_id) or {}
            fill_price = float(order_details.get("tradedPrice") or order_details.get("price") or price)
            if fill_price <= 0:
                fill_price = price
            logger.info(f"  [LIVE] SELL FILLED: {qty} {symbol} @ Rs {fill_price:,.2f} ({reason}, order ID: {order_id})")
            return fill_price
        except Exception as e:
            logger.error(f"  Exception placing live sell order for {symbol}: {e}")
            self.last_alert = f"Live sell error: {e}"
            return None

    def close_position(self, symbol: str, price: float, reason: str) -> bool:
        pos = self.positions.get(symbol)
        if not pos:
            return False
        fill = self.execute_sell(symbol, pos.qty, price, reason)
        if fill is None:
            return False

        proceeds = fill * pos.qty
        cost = self.cfg.trade_cost(proceeds)
        entry_cost = self.cfg.trade_cost(pos.invested)
        pnl = (fill - pos.entry_price) * pos.qty - cost - entry_cost
        self.cash += proceeds - cost
        self.realized_pnl += pnl
        self.closed_trades.append({
            "symbol": symbol, "industry": pos.industry,
            "entry_date": pos.entry_date.isoformat(),
            "exit_date": (self.data_date or date.today()).isoformat(),
            "entry_price": round(pos.entry_price, 2), "exit_price": round(fill, 2),
            "qty": pos.qty, "pnl": round(pnl, 2),
            "pnl_pct": round(pnl / pos.invested * 100, 2) if pos.invested else 0.0,
            "exit_reason": reason,
            "hold_days": pos.hold_days(self.data_date or date.today()),
        })
        if reason == "stop":
            self.cooldowns[symbol] = (self.data_date or date.today()) + \
                timedelta(days=self.cfg.cooldown_days)
        logger.info(f"  EXIT {symbol}: {reason}, P&L Rs {pnl:,.2f} "
                    f"({pnl / pos.invested * 100:+.2f}%)")
        del self.positions[symbol]
        self.save_portfolio()
        return True

    def equity(self, prices: dict) -> float:
        """Cash plus every open position marked at `prices` (last recorded close when missing)."""
        return self.cash + sum(p.qty * (prices.get(s) or p.last_close) for s, p in self.positions.items())

    def open_position(self, symbol: str, rank: int, price: float, industry: str,
                      equity: float | None = None) -> bool:
        spendable = (self.cash - self.cfg.fixed_fee) / (
            1.0 + (self.cfg.fee_pct + self.cfg.slippage_pct) / 100.0)
        # With cfg.compound the slot is a fraction of current equity, so profits are redeployed.
        qty = size_position(price, rank, self.cfg, max(spendable, 0.0), equity=equity)
        if qty <= 0:
            logger.info(f"  SKIP {symbol}: insufficient cash (Rs {self.cash:,.0f})")
            return False

        fill = self.execute_buy(symbol, qty, price)
        if fill is None:
            return False
        spend = fill * qty
        cost = self.cfg.trade_cost(spend)
        self.cash -= spend + cost
        self.positions[symbol] = Position(symbol, self.data_date or date.today(), fill, qty,
                                          self.cfg, rank_at_entry=rank, industry=industry)
        logger.info(f"  ENTRY {symbol} (rank {rank}, {industry}): {qty} @ Rs {fill:,.2f} "
                    f"= Rs {spend:,.0f}, stop Rs {self.positions[symbol].stop_price:,.2f}")
        self.save_portfolio()
        return True

    # ── model-specific rules ─────────────────────────────────────────────────
    def entry_ok(self, sym: str) -> tuple[bool, str]:
        """Per-symbol entry gate for the active model (rules live in lib/, shared with the backtest/replay)."""
        if self.model == "minervini":
            return minervini.entry_check(sym, self.tables, self.data_date,
                                         self.cfg.breakout_days, self.rs_pct)
        elif self.model == "ema_supertrend":
            return ema_supertrend.entry_check(sym, self.tables, self.data_date, self.rs_pct)
        return passes_entry_filters(sym, self.tables, self.data_date, self.cfg)

    def check_exit(self, pos: Position, price: float) -> str | None:
        if self.model == "minervini":
            return minervini.exit_check(pos, price, self.tables, self.data_date, STAGE_TRAIL)
        elif self.model == "ema_supertrend":
            return ema_supertrend.exit_check(pos, price, self.tables, self.data_date, stop_pct=self.cfg.stop_pct)
        return pos.update(price, self.cfg)

    def minervini_picks(self, free: int) -> list[dict]:
        """Top-RS names that clear the whole Minervini template, honouring cooldowns and the sector cap.
        Same walk as the replay's daily scan."""
        counts = sector_counts(self.positions)
        picks: list[dict] = []
        for sym, _ in self.ranking:
            if len(picks) >= free:
                break
            if sym in self.positions:
                continue
            if sym in self.cooldowns and self.data_date < self.cooldowns[sym]:
                continue
            industry = self.industries.get(sym, "")
            if counts.get(industry, 0) >= self.cfg.sector_cap:
                continue
            ok, _ = self.entry_ok(sym)
            if not ok:
                continue
            picks.append({"symbol": sym, "rank": self.ranks.get(sym, 999), "industry": industry})
            counts[industry] = counts.get(industry, 0) + 1
        return picks

    def enter_picks(self, picks: list[dict], prices: dict) -> None:
        for pick in picks:
            sym = pick["symbol"]
            row = self.tables.get(sym, {}).get("px", {}).get(self.data_date)
            price = prices.get(sym) or (float(row.close) if row is not None else 0.0)
            if self.helper is not None and not self.dry_run:
                try:
                    ltp = self.helper.get_ltp(sym, instrument="EQUITY")
                    if ltp and ltp > 0:
                        price = float(ltp)
                except Exception:
                    pass
            if price <= 0:
                logger.warning(f"  SKIP {sym}: no usable price")
                continue
            self.open_position(sym, pick["rank"], price, pick["industry"], equity=self.equity(prices))

    # ── the daily cycle ──────────────────────────────────────────────────────
    def daily_cycle(self) -> None:
        if not self.refresh_market_data():
            self.save_state("ERROR")
            return

        prices = self.current_prices()
        regime_on = self.calendar.is_on(self.data_date)

        logger.info("-" * 70)
        logger.info(f"CYCLE {self.data_date} | regime {'ON' if regime_on else 'OFF'} | "
                    f"{len(self.positions)}/{self.cfg.slots} slots | cash Rs {self.cash:,.0f}")

        # 1. Ladder check on every held position — runs daily, not just at review.
        for sym in list(self.positions.keys()):
            pos = self.positions[sym]
            price = prices.get(sym, pos.last_close)
            reason = self.check_exit(pos, price)
            if reason:
                self.close_position(sym, price, reason)

        # 2. Daily review & rebalancing.
        already_reviewed = self.last_review_date == self.data_date
        if not already_reviewed:
            if not regime_on and self.cfg.regime_exit and self.positions:
                logger.warning("Regime OFF — liquidating the book")
                for sym in list(self.positions.keys()):
                    self.close_position(sym, prices.get(sym, self.positions[sym].last_close), "regime")
            elif self.model in ("minervini", "ema_supertrend"):
                self.minervini_entries(prices, regime_on)
            else:
                self.weekly_review(prices, regime_on)
            self.last_review_date = self.data_date

        self.last_cycle_date = self.data_date
        self.save_portfolio()
        self.save_state("RUNNING", prices)
        self.log_summary(prices)

    def minervini_entries(self, prices: dict, regime_on: bool) -> None:
        if not regime_on:
            logger.info("Regime OFF — no new entries")
            return
        free = self.cfg.slots - len(self.positions)
        if free <= 0:
            logger.info("No free slots")
            return
        picks = self.minervini_picks(free)
        if not picks:
            logger.info("  No candidate cleared the Minervini template today")
            return
        logger.info("  Minervini picks: " + ", ".join(f"{p['symbol']}(#{p['rank']})" for p in picks))
        self.enter_picks(picks, prices)

    def weekly_review(self, prices: dict, regime_on: bool) -> None:
        """Turtle RS review, called every session: daily entries, rank rotation once a week."""
        logger.info("=" * 70)
        logger.info(f"REVIEW {self.data_date}")

        if not regime_on:
            if self.cfg.regime_exit and self.positions:
                logger.warning("Regime OFF — liquidating the book")
                for sym in list(self.positions.keys()):
                    self.close_position(sym, prices.get(sym, self.positions[sym].last_close),
                                        "regime")
            else:
                logger.info("Regime OFF — no new entries")
            return

        # Rank rotation: at most once per ISO week (it mutates the strike counters, and "two consecutive
        # reviews" must mean two weeks). Entries below still run every session.
        if rotation_due(self.last_rotation_date, self.data_date):
            self.last_rotation_date = self.data_date
            for sym, why in rank_rotation_exits(self.positions, self.ranks, self.data_date, self.cfg):
                logger.info(f"  Rotating out {sym}: {why}")
                self.close_position(sym, prices.get(sym, self.positions[sym].last_close), "rebalance")
        else:
            logger.info(f"  Rank rotation already ran this week ({self.last_rotation_date})")

        free = self.cfg.slots - len(self.positions)
        if free <= 0:
            logger.info("No free slots")
            return

        picks, rejects = select_candidates(self.ranking, self.positions, self.tables,
                                           self.industries, self.data_date, self.cooldowns,
                                           self.cfg, free)
        if rejects:
            logger.info("  Rejected: " + ", ".join(
                f"{r['symbol']}(#{r['rank']}: {r['reason']})" for r in rejects[:8]))
        if not picks:
            logger.info("  No candidates cleared the entry filters")
            return

        self.enter_picks(picks, prices)

    def log_summary(self, prices: dict) -> None:
        unrealised = sum(p.unrealised(prices.get(s, p.last_close))
                         for s, p in self.positions.items())
        invested = sum(p.entry_price * p.qty for p in self.positions.values())
        equity = self.cash + invested + unrealised
        logger.info("-" * 70)
        logger.info(f"Equity Rs {equity:,.0f} | cash Rs {self.cash:,.0f} | "
                    f"invested Rs {invested:,.0f} | unrealised Rs {unrealised:,.0f} | "
                    f"realized Rs {self.realized_pnl:,.0f}")
        for sym, pos in sorted(self.positions.items(),
                               key=lambda kv: kv[1].gain_pct(prices.get(kv[0], kv[1].last_close)),
                               reverse=True):
            px = prices.get(sym, pos.last_close)
            logger.info(f"  {sym:<14} {pos.qty:>5} @ {pos.entry_price:>9,.2f} → {px:>9,.2f}  "
                        f"{pos.gain_pct(px):>+7.2f}%  stop {pos.stop_price:>9,.2f} "
                        f"({pos.stage_label()}, rank {self.ranks.get(sym, '-')})")

    # ── scheduling ───────────────────────────────────────────────────────────
    def next_run_time(self) -> datetime:
        hh, mm = (int(x) for x in self.run_at.split(":"))
        now = datetime.now()
        target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        while not is_nse_trading_day(target):              # skip weekends and NSE holidays
            target += timedelta(days=1)
        return target

    def sleep_until(self, target: datetime) -> bool:
        """Sleep in 1s ticks so the dashboard stop button works overnight.
        False if a shutdown was requested."""
        logger.info(f"Sleeping until {target:%Y-%m-%d %H:%M} "
                    f"({(target - datetime.now()).total_seconds() / 3600:.1f}h)")
        while datetime.now() < target:
            if check_shutdown_trigger(self.state_key):
                return False
            time.sleep(1)
        return True

    def run(self) -> None:
        self.helper = DhanHelper(get_dhan_client())
        self.load_portfolio()
        self.save_state("INITIALIZING")

        if self.run_once:
            self.daily_cycle()
            self.save_state("STOPPED")
            logger.info("--once complete, exiting")
            return

        while True:
            if check_shutdown_trigger(self.state_key):
                logger.info("Shutdown requested — exiting cleanly (positions are preserved)")
                self.save_state("STOPPED")
                return
            try:
                self.daily_cycle()
            except Exception:
                logger.error(f"Cycle failed:\n{traceback.format_exc()}")
                self.save_state("ERROR")
            if not self.sleep_until(self.next_run_time()):
                logger.info("Shutdown requested during sleep — exiting cleanly")
                self.save_state("STOPPED")
                return


def main() -> None:
    p = argparse.ArgumentParser(
        description="Nifty 500 momentum investing portfolio.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Paper run, one cycle, then exit (safe to run any time)
  venv\\Scripts\\python.exe strategies/momentum_investing/nifty500_momentum.py --once

  # Paper daemon, cycles daily at 15:20
  venv\\Scripts\\python.exe strategies/momentum_investing/nifty500_momentum.py

  # Live delivery trading (Phase 4 — not implemented yet)
  venv\\Scripts\\python.exe strategies/momentum_investing/nifty500_momentum.py --live
""")
    p.add_argument("--live", action="store_true", default=False,
                   help="place real CNC orders (default: paper)")
    p.add_argument("--model", choices=["turtle_rs", "minervini", "ema_supertrend"], default="turtle_rs",
                   help="turtle_rs: composite-RS breakout, weekly entries/rotation (default). "
                        "minervini: Trend Template (rising 200 SMA, RS>=70, pivot breakout), entries scanned DAILY. "
                        "ema_supertrend: EMA 20>50>200 ribbon + Supertrend Green, entries scanned DAILY. "
                        "A portfolio file belongs to one model; use --instance-id to run both")
    p.add_argument("--breakout-days", type=int, default=None,
                   help="breakout lookback in days (turtle_rs default 55; minervini pivot 20, or 10 for a tight VCP)")
    p.add_argument("--once", action="store_true", help="run one cycle and exit")
    p.add_argument("--run-at", default="15:20", help="daily cycle time IST (default 15:20)")
    p.add_argument("--capital", type=float, default=500_000.0)
    p.add_argument("--slots", type=int, default=10)
    p.add_argument("--universe", choices=["nifty500", "nifty50"], default="nifty500")
    p.add_argument("--stop", type=float, default=12.0, help="initial stop loss %%")
    p.add_argument("--target", default="none",
                   help="profit target %%, or 'none' (default) to let winners run")
    p.add_argument("--trail-pct", type=float, default=25.0)
    p.add_argument("--buy-rank-limit", type=int, default=20)
    p.add_argument("--sell-rank-limit", type=int, default=25)
    p.add_argument("--sector-cap", type=int, default=2)
    p.add_argument("--max-new-per-review", type=int, default=None)
    p.add_argument("--no-compound", action="store_true",
                   help="size slots off the starting --capital instead of current equity")
    p.add_argument("--benchmark", choices=["nifty50", "nifty500"], default="nifty50",
                   help="benchmark index for RS ranking and regime: nifty50 (proven default) or nifty500")
    p.add_argument("--regime-interval", choices=["weekly", "daily"], default="weekly",
                   help="regime check frequency: weekly (prior week close, proven default) or daily")
    p.add_argument("--no-regime-exit", action="store_true",
                   help="stay invested when the regime turns off (still blocks new buys)")
    p.add_argument("--no-regime", action="store_true",
                   help="disable the market filter entirely — always eligible to be invested. "
                        "Backtested 2019-2026: near-identical CAGR (13.35%% vs 13.63%%) but max "
                        "drawdown worsens from -13.1%% to -18.1%%")
    p.add_argument("--regime-sma", type=int, default=200,
                   help="daily Nifty 500 close vs this SMA (default 200)")
    p.add_argument("--instance-id", default=None,
                   help="run a second independent instance under its own state files")
    args = p.parse_args()

    breakout_days = args.breakout_days if args.breakout_days is not None else (20 if args.model == "minervini" else 55)
    if args.model == "minervini" and breakout_days not in (10, 20):
        logger.error("[CONFIG ERROR] --model minervini needs --breakout-days 10 or 20")
        sys.exit(1)
    target = None if str(args.target).strip().lower() in ("none", "off", "") else float(args.target)
    cfg = MomentumConfig(
        universe=args.universe, capital=args.capital, slots=args.slots,
        stop_pct=args.stop, target_pct=target, trail_pct=args.trail_pct,
        buy_rank_limit=args.buy_rank_limit, sell_rank_limit=args.sell_rank_limit,
        sector_cap=args.sector_cap, max_new_per_review=args.max_new_per_review,
        benchmark=args.benchmark,
        compound=not args.no_compound,
        regime_interval=args.regime_interval,
        regime_exit=not args.no_regime_exit,
        regime_enabled=not args.no_regime,
        regime_sma=args.regime_sma, breakout_days=breakout_days,
    )
    try:
        cfg.validate()
    except ValueError as e:
        logger.error(f"Invalid configuration: {e}")
        sys.exit(1)

    state_key = f"nifty500_momentum_{args.instance_id}" if args.instance_id else "nifty500_momentum"

    logger.info("=" * 60)
    logger.info("NIFTY 500 MOMENTUM INVESTING PORTFOLIO")
    logger.info(f"  Mode        : {'LIVE (real CNC orders)' if args.live else 'PAPER (dry run)'}")
    logger.info(f"  State key   : {state_key}")
    logger.info(f"  Universe    : {cfg.universe}   Slots: {cfg.slots}")
    logger.info(f"  Capital     : Rs {cfg.capital:,.0f}"
                f"{' (slots compound with equity)' if cfg.compound else ' (fixed slots)'}")
    logger.info(f"  Ladder      : {'no target' if cfg.target_pct is None else f'target +{cfg.target_pct:g}%'}, "
                f"stop -{cfg.stop_pct:g}%, BE +{cfg.breakeven_trigger_pct:g}%, "
                f"trail {cfg.trail_pct:g}% from peak at +{cfg.trail_trigger_pct:g}%")
    logger.info(f"  Model       : {args.model}"
                f"{' (entries scanned every session)' if args.model == 'minervini' else ' (entries at the weekly review)'}")
    logger.info(f"  Entry       : rank<={cfg.buy_rank_limit}, {cfg.breakout_days}d breakout, "
                f"sector cap {cfg.sector_cap}")
    if cfg.regime_enabled:
        bench_label = "Nifty 50" if cfg.benchmark == "nifty50" else "Nifty 500"
        logger.info(f"  Regime      : {cfg.regime_interval} {bench_label} > {cfg.regime_sma} SMA"
                    f"{', liquidate when off' if cfg.regime_exit else ', stay invested when off'}")
    else:
        logger.warning("  Regime      : DISABLED — no market filter. The strategy will stay "
                       "invested through downtrends; backtested max drawdown worsens from "
                       "-13.1% to -18.1%.")
    logger.info(f"  Schedule    : {'single cycle' if args.once else f'daily at {args.run_at}'}")
    logger.info("=" * 60)

    strat = MomentumPortfolioStrategy(cfg, dry_run=not args.live, state_key=state_key,
                                      run_at=args.run_at, run_once=args.once, model=args.model)
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.info("Interrupted — portfolio is saved; positions are NOT exited")
        strat.save_portfolio()
        strat.save_state("STOPPED")
        sys.exit(0)


if __name__ == "__main__":
    main()

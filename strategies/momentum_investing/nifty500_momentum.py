"""
Nifty 500 Momentum Investing Portfolio — autonomous positional equity strategy.

Holds up to N momentum stocks ranked by composite relative strength versus the Nifty 50.
Exits on a trailing stop ladder or a rank-rotation review; freed capital is redeployed into
the next qualifying names at the following weekly review.

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
import logging
import os
import sys
import time
import traceback
from datetime import date, datetime, timedelta

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, PROJECT_ROOT)

from login import get_dhan_client                                        # noqa: E402
from lib.dhan_helper import DhanHelper                                   # noqa: E402
from lib.strategy_state_helper import (                                  # noqa: E402
    save_strategy_state, check_shutdown_trigger, instance_log_suffix,
)
from lib.momentum import (                                               # noqa: E402
    MomentumConfig, Position,
    build_regime_weekly, build_rs_matrix, build_tables,
    load_benchmark, load_price_map, load_universe,
    latest_data_date, rank_rotation_exits, rank_universe, ranks_by_symbol,
    select_candidates, size_position,
)

# ── logging ───────────────────────────────────────────────────────────────────
LOG_DIR = os.path.join(PROJECT_ROOT, "debug", "logs", "momentum_investing")
os.makedirs(LOG_DIR, exist_ok=True)


class FlushingFileHandler(logging.FileHandler):
    """Flush on every record so the dashboard's log tail is live, not buffered."""

    def emit(self, record):
        super().emit(record)
        self.flush()


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(),
        FlushingFileHandler(os.path.join(
            LOG_DIR, f"{datetime.now().strftime('%Y%m%d')}{instance_log_suffix()}.log")),
    ],
    force=True,
)
logger = logging.getLogger(__name__)

DEBUG_DIR = os.path.join(PROJECT_ROOT, "debug")
PORTFOLIO_VERSION = 1


class MomentumPortfolioStrategy:
    def __init__(self, cfg: MomentumConfig, dry_run: bool = True,
                 state_key: str = "nifty500_momentum", run_at: str = "15:20",
                 run_once: bool = False):
        self.cfg = cfg
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

        self.cash = float(data.get("cash", self.cfg.capital))
        self.realized_pnl = float(data.get("realized_pnl", 0.0))
        self.closed_trades = data.get("closed_trades", [])
        self.positions = {p["symbol"]: Position.from_dict(p, self.cfg)
                          for p in data.get("positions", [])}
        self.cooldowns = {s: datetime.fromisoformat(d).date()
                          for s, d in (data.get("cooldowns") or {}).items()}
        for key in ("last_cycle_date", "last_review_date"):
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
        next_review = (self.calendar.next_review_day(self.data_date)
                       if self.calendar and self.data_date else None)

        save_strategy_state(self.state_key, {
            "strategy": "Nifty 500 Momentum Portfolio",
            "status": status,
            "dry_run": self.dry_run,
            "capital": self.cfg.capital,
            "cash": round(self.cash, 2),
            "invested": round(invested, 2),
            "deployed_pct": round(invested / self.cfg.capital * 100, 1) if self.cfg.capital else 0,
            "positions": len(self.positions),
            "slots": self.cfg.slots,
            "realized_pnl": round(self.realized_pnl, 2),
            "unrealised_pnl": round(unrealised, 2),
            "total_pnl": round(self.realized_pnl + unrealised, 2),
            "equity": round(self.cash + invested + unrealised, 2),
            "holdings": holdings,
            "top_ranks": [{"symbol": s, "rs": round(rs, 4)} for s, rs in self.ranking[:25]],
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
        self.bench = load_benchmark()
        self.price_map = load_price_map([u["symbol"] for u in self.universe],
                                        min_bars=self.cfg.min_history_bars)
        if not self.price_map:
            self.last_alert = "No price data loaded"
            logger.error(self.last_alert)
            return False

        self.tables = build_tables(self.price_map, self.cfg)
        self.calendar = build_regime_weekly(self.bench, self.cfg)
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

        matrix = build_rs_matrix(self.price_map, self.bench)
        self.ranking = rank_universe(self.price_map, self.bench, self.data_date, self.cfg,
                                     matrix=matrix)
        self.ranks = ranks_by_symbol(self.ranking)
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
        # Phase 4 wires the real CNC order here (place_entry with product_type=CNC,
        # then wait_for_fill). Refusing to trade is the safe default until then.
        logger.error(f"  LIVE BUY not implemented yet — skipping {qty} {symbol}")
        self.last_alert = "Live execution not implemented (Phase 4)"
        return None

    def execute_sell(self, symbol: str, qty: int, price: float, reason: str) -> float | None:
        if self.dry_run:
            logger.info(f"  [PAPER] SELL {qty} {symbol} @ Rs {price:,.2f}  ({reason})")
            return price
        logger.error(f"  LIVE SELL not implemented yet — skipping {qty} {symbol}")
        self.last_alert = "Live execution not implemented (Phase 4)"
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

    def open_position(self, symbol: str, rank: int, price: float, industry: str) -> bool:
        spendable = (self.cash - self.cfg.fixed_fee) / (
            1.0 + (self.cfg.fee_pct + self.cfg.slippage_pct) / 100.0)
        qty = size_position(price, rank, self.cfg, max(spendable, 0.0))
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
            reason = pos.update(prices.get(sym, pos.last_close), self.cfg)
            if reason:
                self.close_position(sym, prices[sym], reason)

        # 2. Weekly review.
        is_review = self.calendar.is_review_day(self.data_date)
        already_reviewed = self.last_review_date == self.data_date
        if is_review and not already_reviewed:
            self.weekly_review(prices, regime_on)
            self.last_review_date = self.data_date
        elif is_review:
            logger.info("Review already done for this date — skipping")
        else:
            nxt = self.calendar.next_review_day(self.data_date)
            logger.info(f"Not a review day. Next review: {nxt}")

        self.last_cycle_date = self.data_date
        self.save_portfolio()
        self.save_state("RUNNING", prices)
        self.log_summary(prices)

    def weekly_review(self, prices: dict, regime_on: bool) -> None:
        logger.info("=" * 70)
        logger.info(f"WEEKLY REVIEW {self.data_date}")

        if not regime_on:
            if self.cfg.regime_exit and self.positions:
                logger.warning("Regime OFF — liquidating the book")
                for sym in list(self.positions.keys()):
                    self.close_position(sym, prices.get(sym, self.positions[sym].last_close),
                                        "regime")
            else:
                logger.info("Regime OFF — no new entries")
            return

        # Rank rotation. Mutates strike counters, so exactly once per review day.
        for sym, why in rank_rotation_exits(self.positions, self.ranks, self.data_date, self.cfg):
            logger.info(f"  Rotating out {sym}: {why}")
            self.close_position(sym, prices.get(sym, self.positions[sym].last_close), "rebalance")

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
            self.open_position(sym, pick["rank"], price, pick["industry"])

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
        while target.weekday() >= 5:                       # skip weekends
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
    p.add_argument("--once", action="store_true", help="run one cycle and exit")
    p.add_argument("--run-at", default="15:20", help="daily cycle time IST (default 15:20)")
    p.add_argument("--capital", type=float, default=175_000.0)
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
    p.add_argument("--no-regime-exit", action="store_true",
                   help="stay invested when the regime turns off (still blocks new buys)")
    p.add_argument("--no-regime", action="store_true",
                   help="disable the market filter entirely — always eligible to be invested. "
                        "Backtested 2019-2026: near-identical CAGR (13.35%% vs 13.63%%) but max "
                        "drawdown worsens from -13.1%% to -18.1%%")
    p.add_argument("--regime-sma", type=int, default=200,
                   help="weekly Nifty close vs this SMA (default 200)")
    p.add_argument("--instance-id", default=None,
                   help="run a second independent instance under its own state files")
    args = p.parse_args()

    target = None if str(args.target).strip().lower() in ("none", "off", "") else float(args.target)
    cfg = MomentumConfig(
        universe=args.universe, capital=args.capital, slots=args.slots,
        stop_pct=args.stop, target_pct=target, trail_pct=args.trail_pct,
        buy_rank_limit=args.buy_rank_limit, sell_rank_limit=args.sell_rank_limit,
        sector_cap=args.sector_cap, max_new_per_review=args.max_new_per_review,
        regime_exit=not args.no_regime_exit,
        regime_enabled=not args.no_regime,
        regime_sma=args.regime_sma,
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
    logger.info(f"  Capital     : Rs {cfg.capital:,.0f}")
    logger.info(f"  Ladder      : {'no target' if cfg.target_pct is None else f'target +{cfg.target_pct:g}%'}, "
                f"stop -{cfg.stop_pct:g}%, BE +{cfg.breakeven_trigger_pct:g}%, "
                f"trail {cfg.trail_pct:g}% from peak at +{cfg.trail_trigger_pct:g}%")
    logger.info(f"  Entry       : rank<={cfg.buy_rank_limit}, {cfg.breakout_days}d breakout, "
                f"sector cap {cfg.sector_cap}")
    if cfg.regime_enabled:
        logger.info(f"  Regime      : weekly Nifty > {cfg.regime_sma} SMA"
                    f"{', liquidate when off' if cfg.regime_exit else ', stay invested when off'}")
    else:
        logger.warning("  Regime      : DISABLED — no market filter. The strategy will stay "
                       "invested through downtrends; backtested max drawdown worsens from "
                       "-13.1% to -18.1%.")
    logger.info(f"  Schedule    : {'single cycle' if args.once else f'daily at {args.run_at}'}")
    logger.info("=" * 60)

    strat = MomentumPortfolioStrategy(cfg, dry_run=not args.live, state_key=state_key,
                                      run_at=args.run_at, run_once=args.once)
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.info("Interrupted — portfolio is saved; positions are NOT exited")
        strat.save_portfolio()
        strat.save_state("STOPPED")
        sys.exit(0)


if __name__ == "__main__":
    main()

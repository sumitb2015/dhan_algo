"""
Nifty 50 intraday equity auto-trader — VWAP + trend confluence, RS-gated.

Multi-symbol intraday cash-equity strategy. Every signal decision comes from
lib/intraday_signals.py, the SAME module scripts/analysis/backtest_intraday_vwap_rs.py
replays, so a dry-run session and a replay of that session must produce identical
trades. Nothing about entry, sizing, stops or exits is reimplemented here.

    ⚠️  THE RULE SET IS NOT VALIDATED. Backtested 2026-08-09 over 81 sessions:
        the original 1m/5m settings returned -0.282R expectancy; the best
        configuration found (5m base / 30m confirm, VWAP exit off — now the
        defaults) still returns -0.09R, and -0.09R at ZERO cost, against a
        required gate of +0.15R. It lost money in a market that drifted +4.5%
        higher. The remaining gap is entry selectivity: 16% of trades reach the
        2.48R target where break-even needs 21.5%.

        DO NOT RUN WITH --live until the backtest clears the gate out-of-sample.
        This file exists so the execution machinery is ready and can be exercised
        in dry run; --live additionally requires
        --i-understand-the-backtest-failed, which is deliberate friction.

WHAT IS STRUCTURALLY NEW HERE
-----------------------------
Every other strategy in this repo trades ONE instrument. This one tracks 50 and
may hold several at once, under a 1 req/s quote limit. Three tiers keep it inside
that budget:

  1. LTP for all 50 + NIFTY comes from ONE get_ltps() call per second. It serves
     from the WebSocket's live_data first, then a 1s cache, then a single batched
     REST call for whatever is missing. With a healthy socket that is zero REST
     calls. There is no per-symbol get_ltp() anywhere in this file.
  2. Candles cost one REST call per symbol, so refreshing all 50 would take ~55s
     per cycle. Instead a full sweep every --rerank-minutes picks a WATCHLIST of
     the top --watchlist-size names, and only those are polled each cycle. Open
     positions are always polled regardless of rank.
  3. Fills come from the order-update WebSocket, with wait_for_fill as fallback.

The 1-second hot loop only reads a snapshot dict the poller thread publishes. It
never touches pandas and never makes a network call.

Usage:
    venv\\Scripts\\python.exe strategies/intraday_equity/nifty50_vwap_rs.py
    venv\\Scripts\\python.exe strategies/intraday_equity/nifty50_vwap_rs.py --max-positions 2

Stop from the dashboard, or by writing debug/nifty50_vwap_rs_shutdown.trigger.
"""

import argparse
import json
import logging
import os
import sys
import threading
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client                                    # noqa: E402
from lib.dhan_helper import DhanHelper                               # noqa: E402
from lib.strategy_risk import resolve_exit_qty                       # noqa: E402
from lib.strategy_state_helper import (                              # noqa: E402
    save_strategy_state, check_shutdown_trigger, instance_log_suffix, flush_state,
)
from lib.intraday_signals import (                                   # noqa: E402
    NIFTY50, IntradayConfig, Candidate, Position,
    build_features, exit_reason, initial_stop, position_size,
    rank_candidates, select_new_entries, sector_of, target_price, trail_stop,
)

STRATEGY_KEY = "nifty50_vwap_rs"

NSE_EQ_WS = 1          # MarketFeed exchange code for NSE cash
IDX_WS = 0             # MarketFeed exchange code for indices
FEED_QUOTE = 17
NIFTY_INDEX_SID = "13"  # Nifty 50 index (spot). NOT 26000, which is the options underlying.

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEBUG_DIR = os.path.join(PROJECT_ROOT, "debug")
LOG_DIR = os.path.join(DEBUG_DIR, "logs", "intraday_equity")
BARS_DIR = os.path.join(DEBUG_DIR, "intraday_bars")
os.makedirs(LOG_DIR, exist_ok=True)


class FlushingFileHandler(logging.FileHandler):
    def emit(self, record):
        super().emit(record)
        self.flush()


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(),
        # encoding: FileHandler otherwise opens with the system ANSI codepage and
        # silently DROPS any line containing a non-ANSI glyph.
        FlushingFileHandler(
            os.path.join(LOG_DIR, f"{datetime.now().strftime('%Y%m%d')}{instance_log_suffix()}.log"),
            encoding="utf-8"),
    ],
    force=True,
)
logger = logging.getLogger(__name__)


def _now_hhmm() -> str:
    return datetime.now().strftime("%H:%M")


class IntradayEquityStrategy:
    def __init__(self, cfg: IntradayConfig, dry_run: bool = True,
                 state_key: str = STRATEGY_KEY,
                 watchlist_size: int = 12, poll_seconds: int = 20,
                 rank_time: str = "09:35", rerank_minutes: int = 15,
                 max_daily_loss: float = 6000.0, target_profit: float = 10000.0,
                 candle_days: int = 3, entry_retry_seconds: int = 30,
                 candle_pace: float = 0.8):
        cfg.validate()
        self.cfg = cfg
        self.candle_pace = candle_pace
        self._next_fetch_at = 0.0
        self.dry_run = dry_run
        self.state_key = state_key
        self.watchlist_size = watchlist_size
        self.poll_seconds = poll_seconds
        self.rank_time = rank_time
        self.rerank_minutes = rerank_minutes
        self.max_daily_loss = abs(max_daily_loss)
        self.target_profit = abs(target_profit)
        self.candle_days = candle_days
        self.entry_retry_seconds = entry_retry_seconds

        self.status = "INITIALIZING"
        self.positions: Dict[str, Position] = {}
        self.realized_pnl = 0.0
        self.trades_today = 0
        self.symbol_trades: Dict[str, int] = {}
        self.cooldown_until: Dict[str, float] = {}
        self.blacklist: Dict[str, str] = {}
        self.entry_retry_at: Dict[str, float] = {}
        self.last_entry_ts = 0.0
        self.events: List[dict] = []
        self.equity_curve: List[dict] = []
        self.halt_reason: Optional[str] = None

        # Poller-owned, read under the lock by the hot loop.
        self._snap_lock = threading.Lock()
        self._feat: Dict[str, pd.Series] = {}
        self._bars: Dict[str, pd.DataFrame] = {}
        self._watchlist: List[str] = []
        self._last_poll: Optional[datetime] = None
        self._poll_thread: Optional[threading.Thread] = None
        self._stop_evt = threading.Event()

        self.sid_of: Dict[str, str] = {}
        self.sym_of: Dict[str, str] = {}
        self.ltps: Dict[str, float] = {}
        self.bench_ltp = 0.0
        self.bench_open = 0.0
        self._last_monitor = 0.0

        dhan = get_dhan_client()
        if not dhan:
            raise SystemExit("Authentication failed — run login.py")
        self.helper = DhanHelper(dhan)

    # ── Events / state ────────────────────────────────────────────────────
    def event(self, level: str, etype: str, msg: str, symbol: str = ""):
        self.events.append({"ts": datetime.now().strftime("%H:%M:%S"), "level": level,
                            "type": etype, "symbol": symbol, "msg": msg})
        # The state file is rewritten whole ~2x/second; an unbounded log would
        # grow it without limit and slow every dashboard poll.
        if len(self.events) > 200:
            self.events = self.events[-200:]
        getattr(logger, "error" if level == "ERROR" else "info")(f"[{etype}] {symbol} {msg}".strip())

    def day_pnl(self) -> Tuple[float, bool]:
        """(day P&L, fully_priced).

        `fully_priced` is False when ANY open position has no usable LTP. The
        caller must not evaluate the daily target/stop in that case: marking one
        unpriced position at a total loss would trip the daily stop on nothing
        more than a missing quote.
        """
        unreal = 0.0
        priced = True
        for pos in self.positions.values():
            ltp = self.ltps.get(pos.symbol, 0.0)
            if not ltp:
                priced = False
                continue
            unreal += pos.unrealized(ltp)
        return self.realized_pnl + unreal, priced

    def save_state(self):
        day, priced = self.day_pnl()
        deployed = sum(p.notional() for p in self.positions.values())
        with self._snap_lock:
            feat = dict(self._feat)
            watch = list(self._watchlist)
            last_poll = self._last_poll

        # Every one of the 50 is reported, gated or not, with the reason it is
        # blocked — a terminal that only shows what fired is a black box.
        cands = [c.to_dict() for c in rank_candidates(feat, self.cfg, include_ungated=True)][:50]
        for c in cands:
            c["ltp"] = round(self.ltps.get(c["symbol"], 0.0), 2)

        save_strategy_state(self.state_key, {
            "strategy": STRATEGY_KEY,
            "status": self.status,
            "dry_run": self.dry_run,
            "mode": "LONG_ONLY" if not self.cfg.allow_short else "LONG_SHORT",
            "backtest_validated": False,
            "as_of": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "session": {"entry_start": self.cfg.entry_start,
                        "entry_cutoff": self.cfg.entry_cutoff,
                        "square_off": self.cfg.square_off},
            "benchmark": {"symbol": "NIFTY 50", "ltp": round(self.bench_ltp, 2),
                          "day_pct": round((self.bench_ltp / self.bench_open - 1) * 100, 2)
                          if self.bench_open else 0.0},
            "risk": {"max_positions": self.cfg.max_positions, "open": len(self.positions),
                     "max_per_sector": self.cfg.max_per_sector,
                     "risk_per_trade": self.cfg.risk_per_trade,
                     "max_daily_loss": self.max_daily_loss,
                     "daily_loss_used": round(max(0.0, -day), 2),
                     "target_profit": self.target_profit,
                     "max_deployed": self.cfg.max_deployed, "deployed": round(deployed, 2),
                     "trades_today": self.trades_today,
                     "max_trades": self.cfg.max_trades_per_day},
            "pnl": {"realized": round(self.realized_pnl, 2),
                    "unrealized": round(day - self.realized_pnl, 2),
                    "day": round(day, 2), "priced": priced},
            "positions": [p.to_dict(self.ltps.get(p.symbol, 0.0)) for p in self.positions.values()],
            "candidates": cands,
            "watchlist": watch,
            "cooldowns": {s: datetime.fromtimestamp(t).strftime("%H:%M:%S")
                          for s, t in self.cooldown_until.items() if t > time.time()},
            "blacklist": self.blacklist,
            "events": self.events[-60:],
            "equity_curve": self.equity_curve[-400:],
            "halt_reason": self.halt_reason,
            "last_poll": last_poll.strftime("%H:%M:%S") if last_poll else None,
            "poll_lag_s": round((datetime.now() - last_poll).total_seconds(), 1) if last_poll else None,
            "ws_healthy": bool(self.helper.live_data),
        })

    def _restore_daily_pnl(self):
        """Carry today's realized P&L across a restart, so a mid-day restart does
        not reset the daily stop and allow a second full loss."""
        path = os.path.join(DEBUG_DIR, f"{self.state_key}_state.json")
        if not os.path.exists(path):
            return
        try:
            if datetime.fromtimestamp(os.path.getmtime(path)).date() != datetime.now().date():
                return
            with open(path) as f:
                data = json.load(f)
            self.realized_pnl = float(data.get("pnl", {}).get("realized", 0.0) or 0.0)
            self.trades_today = int(data.get("risk", {}).get("trades_today", 0) or 0)
            if self.realized_pnl or self.trades_today:
                logger.info(f"Restored today's realized P&L {self.realized_pnl:.0f} "
                            f"over {self.trades_today} trades")
        except Exception as e:
            logger.error(f"Could not restore daily P&L: {e}")

    # ── Setup ─────────────────────────────────────────────────────────────
    def resolve_universe(self):
        missing = []
        for sym in NIFTY50:
            try:
                sec = self.helper.find_equity(sym)
                if sec is None:
                    missing.append(sym)
                    continue
                sid = str(int(sec["SECURITY_ID"]))
                self.sid_of[sym] = sid
                self.sym_of[sid] = sym
            except Exception as e:
                missing.append(f"{sym}({e})")
        logger.info(f"Resolved {len(self.sid_of)}/50 symbols")
        if missing:
            logger.warning(f"Unresolved: {missing}")
        if not self.sid_of:
            raise SystemExit("No symbols resolved — cannot start")

    def start_feeds(self):
        instruments = [(NSE_EQ_WS, sid, FEED_QUOTE) for sid in self.sid_of.values()]
        instruments.append((IDX_WS, NIFTY_INDEX_SID, FEED_QUOTE))
        # 50 equity subscriptions is the largest this repo has proven
        # (scripts/tools/live_equity_ws.py); the index makes 51. If the socket
        # rejects it, the strategy still runs — get_ltps falls back to one
        # batched REST call per second for whatever the socket does not supply.
        self.helper.start_websocket(instruments)
        time.sleep(3)
        try:
            self.helper.start_order_update_websocket()
        except Exception as e:
            logger.warning(f"Order-update WS unavailable ({e}) — falling back to wait_for_fill")

    def refresh_ltps(self):
        pairs = [("NSE_EQ", sid) for sid in self.sid_of.values()]
        pairs.append(("IDX_I", NIFTY_INDEX_SID))
        try:
            # ONE call for all 51 instruments. This is the entire quote budget.
            raw = self.helper.get_ltps(pairs)
        except Exception as e:
            logger.error(f"get_ltps failed: {e}")
            return
        for key, px in (raw or {}).items():
            sid = str(key).split(":")[-1]
            if sid == NIFTY_INDEX_SID:
                if px:
                    self.bench_ltp = float(px)
                    if not self.bench_open:
                        self.bench_open = float(px)
                continue
            sym = self.sym_of.get(sid)
            if sym and px:
                self.ltps[sym] = float(px)

    # ── Poller ────────────────────────────────────────────────────────────
    def _poller_loop(self):
        last_rank = 0.0
        while not self._stop_evt.is_set():
            try:
                now = time.time()
                do_full = (not self._watchlist) or (now - last_rank >= self.rerank_minutes * 60)
                if do_full and _now_hhmm() >= self.rank_time:
                    self._sweep(list(self.sid_of))
                    last_rank = now
                    self._rebuild_watchlist()
                else:
                    targets = list(dict.fromkeys(list(self._watchlist) + list(self.positions)))
                    if targets:
                        self._sweep(targets)
                with self._snap_lock:
                    self._last_poll = datetime.now()
            except Exception as e:
                logger.error(f"Poller error: {e}")
            self._stop_evt.wait(self.poll_seconds)

    def _sweep(self, symbols: List[str]):
        """Fetch candles and recompute features, one REST call per symbol.

        These calls are paced HERE, deliberately. DhanHelper's _rest_quote_limiter
        covers the quote endpoints only — the intraday/historical endpoint is a
        separate bucket with no pacing in the helper at all, and firing this loop
        back-to-back reliably returns DH-904 Rate_Limit (observed 2026-08-09).
        That is why the watchlist exists: it bounds how many of these a cycle costs.
        """
        bench_df = self._fetch("NIFTY", instrument="INDEX")
        for sym in symbols:
            if self._stop_evt.is_set():
                return
            self._pace()
            df = self._fetch(sym)
            if df is None or len(df) < 60:
                continue
            feats = build_features(df, bench_df, self.cfg)
            if len(feats) < 2:
                continue
            # iloc[-2] = last CONFIRMED bar. iloc[-1] is still forming and would
            # make the live path act on data the backtest never saw.
            with self._snap_lock:
                self._feat[sym] = feats.iloc[-2]
                self._bars[sym] = df.tail(200)
        self._dump_bars()

    def _pace(self):
        """Minimum spacing between intraday-data calls. See _sweep for why."""
        wait = self._next_fetch_at - time.monotonic()
        if wait > 0:
            self._stop_evt.wait(wait)
        self._next_fetch_at = time.monotonic() + self.candle_pace

    def _fetch(self, symbol: str, instrument: str = "EQUITY") -> Optional[pd.DataFrame]:
        try:
            df = self.helper.get_latest_candles(symbol, interval="1", days=self.candle_days)
            if df is None or len(df) == 0:
                # Data-API errors are silent by default — an empty frame is not
                # proof of "no data", so surface what the API actually said.
                err = getattr(self.helper, "last_api_error", None)
                if err:
                    logger.warning(f"{symbol}: empty candles — API said {err}")
                return None
            return df
        except Exception as e:
            logger.error(f"Candle fetch failed for {symbol}: {e}")
            return None

    def _rebuild_watchlist(self):
        with self._snap_lock:
            feat = dict(self._feat)
        ranked = rank_candidates(feat, self.cfg, include_ungated=True)
        watch = [c.symbol for c in ranked[:self.watchlist_size]]
        for sym in self.positions:            # never drop an open position
            if sym not in watch:
                watch.append(sym)
        with self._snap_lock:
            self._watchlist = watch
        logger.info(f"Watchlist ({len(watch)}): {', '.join(watch[:12])}")

    def _dump_bars(self):
        """Publish recent bars for the terminal's chart, so the dashboard needs
        no second market-data path."""
        os.makedirs(BARS_DIR, exist_ok=True)
        with self._snap_lock:
            bars = {s: df for s, df in self._bars.items()
                    if s in self._watchlist or s in self.positions}
        for sym, df in bars.items():
            try:
                payload = {"symbol": sym, "updated_at": datetime.now().isoformat(),
                           "bars": [{"t": ts.strftime("%Y-%m-%d %H:%M:%S"),
                                     "o": float(r.Open), "h": float(r.High),
                                     "l": float(r.Low), "c": float(r.Close),
                                     "v": float(r.Volume)} for ts, r in df.iterrows()]}
                tmp = os.path.join(BARS_DIR, f"{sym}.json.tmp")
                with open(tmp, "w") as f:
                    json.dump(payload, f)
                os.replace(tmp, os.path.join(BARS_DIR, f"{sym}.json"))
            except Exception as e:
                logger.error(f"Bar dump failed for {sym}: {e}")

    # ── Orders ────────────────────────────────────────────────────────────
    def _enter(self, cand: Candidate) -> bool:
        sym = cand.symbol
        sid = self.sid_of.get(sym)
        if not sid:
            return False
        ltp = self.ltps.get(sym) or cand.price
        if not ltp or not cand.atr or cand.atr <= 0:
            return False

        stop = initial_stop(ltp, cand.atr, cand.side, self.cfg)
        deployed = sum(p.notional() for p in self.positions.values())
        qty = position_size(ltp, stop, self.cfg, deployed=deployed)
        if qty <= 0:
            # An unsizable setup is a SKIPPED setup. Falling back to 1 share
            # would turn a rejected trade into an unsized one.
            self.event("INFO", "SKIP", f"unsizable at {ltp:.2f} (stop {stop:.2f})", sym)
            return False

        pos = Position(symbol=sym, security_id=sid, side=cand.side, qty=qty,
                       entry_price=ltp, stop=stop,
                       target=target_price(ltp, stop, cand.side, self.cfg),
                       entry_ts=pd.Timestamp.now(), entry_score=cand.score)

        if self.dry_run:
            self.event("INFO", "ENTRY", f"DRY {cand.side} {qty} @ {ltp:.2f} "
                                        f"stop {stop:.2f} tgt {pos.target:.2f} score {cand.score:.0f}", sym)
        else:
            try:
                oid = (self.helper.buy(sid, qty) if cand.side == "LONG"
                       else self.helper.sell(sid, qty))
            except Exception as e:
                self._entry_failed(sym, f"order error: {e}")
                return False
            if not oid:
                self._entry_failed(sym, "order rejected")
                return False

            self.helper.wait_for_fill(oid, timeout=15)
            filled, avg = self._fill_details(oid)
            if filled <= 0:
                self._entry_failed(sym, f"no fill on order {oid}")
                return False
            # Equity market orders partially fill. Track what we ACTUALLY got,
            # or the exit will try to sell shares that were never bought.
            if filled != qty:
                self.event("WARN", "PARTIAL", f"requested {qty}, filled {filled}", sym)
            pos.qty = filled
            pos.order_id = str(oid)
            if avg > 0:
                pos.entry_price = avg
                pos.stop = initial_stop(avg, cand.atr, cand.side, self.cfg)
                pos.target = target_price(avg, pos.stop, cand.side, self.cfg)
                pos.risk_per_share = abs(avg - pos.stop)
                pos.high_water = avg
            self.event("INFO", "ENTRY", f"{cand.side} {filled} @ {pos.entry_price:.2f} "
                                        f"stop {pos.stop:.2f} tgt {pos.target:.2f} oid {oid}", sym)

        self.positions[sym] = pos
        self.trades_today += 1
        self.symbol_trades[sym] = self.symbol_trades.get(sym, 0) + 1
        self.last_entry_ts = time.time()
        self.entry_retry_at.pop(sym, None)
        self._log_order("ENTRY", pos, pos.entry_price, "")
        return True

    def _entry_failed(self, sym: str, msg: str):
        """Exponential backoff, then a day blacklist — a persistently failing
        symbol must not be resubmitted every cycle."""
        prev = self.entry_retry_at.get(sym, 0.0)
        backoff = self.entry_retry_seconds if prev <= time.time() else min(300, (prev - time.time()) * 2)
        self.entry_retry_at[sym] = time.time() + backoff
        if backoff >= 300:
            self.blacklist[sym] = msg
            self.event("ERROR", "BLACKLIST", f"{msg} — no further attempts today", sym)
        else:
            self.event("ERROR", "REJECT", f"{msg} — retry in {backoff:.0f}s", sym)

    def _fill_details(self, order_id) -> Tuple[int, float]:
        try:
            od = self.helper.get_order_by_id(order_id) or {}
        except Exception:
            return 0, 0.0
        if isinstance(od, dict) and "data" in od:
            od = od.get("data") or {}
        if isinstance(od, list) and od:
            od = od[0]
        qty = od.get("filledQty", od.get("filled_qty", od.get("tradedQuantity", 0)))
        avg = od.get("averageTradedPrice", od.get("avgFilledPrice", od.get("price", 0)))
        try:
            return int(qty or 0), float(avg or 0)
        except (TypeError, ValueError):
            return 0, 0.0

    def _exit(self, pos: Position, reason: str) -> bool:
        sym = pos.symbol
        ltp = self.ltps.get(sym, pos.entry_price)

        if self.dry_run:
            fill = ltp
        else:
            side = "SELL" if pos.side == "LONG" else "BUY"
            # NEVER close_position()/get_net_quantity() — those are account-wide
            # and would flatten another strategy's leg in the same security.
            qty, net = resolve_exit_qty(self.helper, pos.security_id, pos.qty, side, logger)
            if qty <= 0:
                self.event("WARN", "EXIT", f"already flat at broker (net {net}) — dropping", sym)
                self._finalize(pos, ltp, reason)
                return True
            try:
                oid = (self.helper.sell(pos.security_id, qty) if side == "SELL"
                       else self.helper.buy(pos.security_id, qty))
            except Exception as e:
                self.event("ERROR", "EXIT", f"order error: {e}", sym)
                return False
            if not oid:
                self.event("ERROR", "EXIT", "exit order rejected", sym)
                return False
            self.helper.wait_for_fill(oid, timeout=15)
            _, avg = self._fill_details(oid)
            fill = avg if avg > 0 else ltp

        self._finalize(pos, fill, reason)
        return True

    def _finalize(self, pos: Position, fill: float, reason: str):
        pnl = (fill - pos.entry_price) * pos.sign * pos.qty
        self.realized_pnl += pnl
        self.positions.pop(pos.symbol, None)
        self.cooldown_until[pos.symbol] = time.time() + self.cfg.symbol_cooldown_s
        self.event("INFO", "EXIT", f"{reason} {pos.qty} @ {fill:.2f} "
                                   f"(entry {pos.entry_price:.2f}) P&L {pnl:+.0f}", pos.symbol)
        self._log_order("EXIT", pos, fill, reason)
        self.equity_curve.append({"ts": datetime.now().strftime("%H:%M"),
                                  "day_pnl": round(self.realized_pnl, 2)})

    def _log_order(self, kind: str, pos: Position, price: float, reason: str):
        """Append-only order log — never rewritten, unlike the state file."""
        try:
            os.makedirs(DEBUG_DIR, exist_ok=True)
            with open(os.path.join(DEBUG_DIR, f"{self.state_key}_orders.jsonl"), "a") as f:
                f.write(json.dumps({
                    "ts": datetime.now().isoformat(), "kind": kind, "symbol": pos.symbol,
                    "side": pos.side, "qty": pos.qty, "price": round(price, 2),
                    "reason": reason, "dry_run": self.dry_run,
                    "entry_price": round(pos.entry_price, 2), "stop": round(pos.stop, 2),
                    "target": round(pos.target, 2), "score": round(pos.entry_score, 1),
                }) + "\n")
        except Exception as e:
            logger.error(f"Order log write failed: {e}")

    # ── Main loop ─────────────────────────────────────────────────────────
    def _flatten_all(self, reason: str) -> bool:
        ok = True
        for pos in list(self.positions.values()):
            if not self._exit(pos, reason):
                ok = False
        return ok

    def _square_off(self):
        """Retry until 15:25, then escalate loudly and STAY ALIVE.

        sys.exit() here would leave real positions open with nothing reporting
        on them. A process that keeps shouting is strictly better.
        """
        self.status = "SQUARING_OFF"
        deadline = datetime.now().replace(hour=15, minute=25, second=0, microsecond=0)
        while self.positions:
            if self._flatten_all("SQUARE_OFF"):
                break
            if datetime.now() >= deadline:
                self.event("ERROR", "CRITICAL",
                           f"MANUAL INTERVENTION REQUIRED — could not square off "
                           f"{list(self.positions)}")
                logger.critical(f"MANUAL INTERVENTION REQUIRED: {list(self.positions)} still open")
                break
            self.save_state()
            time.sleep(15)

    def run(self):
        mode = "DRY RUN" if self.dry_run else "*** LIVE ***"
        logger.info("=" * 66)
        logger.info(f"Nifty50 Intraday VWAP+RS — {mode}")
        logger.info(f"  max_positions={self.cfg.max_positions} per_sector={self.cfg.max_per_sector} "
                    f"risk/trade={self.cfg.risk_per_trade:.0f}")
        logger.info(f"  entry {self.cfg.entry_start}-{self.cfg.entry_cutoff}, "
                    f"square-off {self.cfg.square_off}")
        if not self.dry_run:
            logger.warning("  RULE SET IS NOT BACKTEST-VALIDATED (see module docstring)")
        logger.info("=" * 66)

        self._restore_daily_pnl()
        self.save_state()
        self.resolve_universe()
        self.start_feeds()

        self._poll_thread = threading.Thread(target=self._poller_loop, daemon=True,
                                             name="intraday-poller")
        self._poll_thread.start()
        self.status = "SCANNING"

        try:
            while True:
                if check_shutdown_trigger(self.state_key):
                    self.event("INFO", "SHUTDOWN", "trigger received")
                    self._flatten_all("SHUTDOWN")
                    break

                hhmm = _now_hhmm()
                if hhmm >= self.cfg.square_off and self.positions:
                    self._square_off()
                    self.status = "STOPPED"
                    self.save_state()
                    break
                if hhmm >= self.cfg.square_off:
                    self.status = "STOPPED"
                    self.save_state()
                    break

                self.refresh_ltps()
                self._manage_positions(hhmm)

                if self._risk_halt():
                    break

                if not self.halt_reason:
                    self._consider_entries(hhmm)

                self.status = "RUNNING" if self.positions else "SCANNING"
                self.save_state()
                self._monitor_log()
                time.sleep(1)
        except KeyboardInterrupt:
            logger.info("KeyboardInterrupt — flattening")
            self._flatten_all("INTERRUPT")
        finally:
            self._stop_evt.set()
            self.status = "STOPPED"
            self.save_state()
            flush_state()
            logger.info(f"Stopped. Realized P&L {self.realized_pnl:+.0f} "
                        f"over {self.trades_today} trades.")

    def _manage_positions(self, hhmm: str):
        with self._snap_lock:
            feat = dict(self._feat)
        for pos in list(self.positions.values()):
            row = feat.get(pos.symbol)
            ltp = self.ltps.get(pos.symbol, 0.0)
            if row is None:
                # Price levels still apply even with no fresh candle — a stale
                # feature frame must never disable the stop.
                if ltp:
                    reason = ("STOP" if (ltp <= pos.stop if pos.side == "LONG" else ltp >= pos.stop)
                              else "TARGET" if (ltp >= pos.target if pos.side == "LONG"
                                                else ltp <= pos.target) else None)
                    if reason:
                        self._exit(pos, reason)
                continue
            pos.stop = trail_stop(pos, row, self.cfg, ltp=ltp or None)
            reason = exit_reason(pos, row, self.cfg, hhmm, ltp=ltp or None)
            if reason:
                self._exit(pos, reason)

    def _risk_halt(self) -> bool:
        day, priced = self.day_pnl()
        if not priced:
            # Skip the check entirely rather than act on a partial mark.
            if time.time() - self._last_monitor > 30:
                logger.warning("Daily risk check skipped — an open position has no LTP")
            return False
        if day <= -self.max_daily_loss:
            self.halt_reason = f"Daily stop hit ({day:+.0f})"
        elif day >= self.target_profit:
            self.halt_reason = f"Daily target hit ({day:+.0f})"
        if self.halt_reason:
            self.event("INFO", "HALT", self.halt_reason)
            self._flatten_all("RISK_HALT")
            self.status = "STOPPED"
            self.save_state()
            return True
        return False

    def _consider_entries(self, hhmm: str):
        if not (self.cfg.entry_start <= hhmm < self.cfg.entry_cutoff):
            return
        if len(self.positions) >= self.cfg.max_positions:
            return
        if self.trades_today >= self.cfg.max_trades_per_day:
            return
        if time.time() - self.last_entry_ts < self.cfg.entry_spacing_s:
            return

        now = time.time()
        excluded = set(self.positions) | set(self.blacklist)
        excluded |= {s for s, t in self.cooldown_until.items() if now < t}
        excluded |= {s for s, t in self.entry_retry_at.items() if now < t}
        excluded |= {s for s, n in self.symbol_trades.items() if n >= self.cfg.max_symbol_trades}

        with self._snap_lock:
            feat = {s: r for s, r in self._feat.items() if s not in excluded}
        if not feat:
            return

        ranked = rank_candidates(feat, self.cfg, exclude=excluded)
        for cand in select_new_entries(ranked, self.cfg, list(self.positions.values())):
            if self._enter(cand):
                break        # entry_spacing_s throttles the next one

    def _monitor_log(self):
        if time.time() - self._last_monitor < 30:
            return
        self._last_monitor = time.time()
        day, priced = self.day_pnl()
        with self._snap_lock:
            n = len(self._feat)
        logger.info(f"[MONITOR] {self.status} pos={len(self.positions)}/{self.cfg.max_positions} "
                    f"trades={self.trades_today} day={day:+.0f}{'' if priced else ' (UNPRICED)'} "
                    f"tracked={n} nifty={self.bench_ltp:.1f}")


# ── CLI ───────────────────────────────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser(
        description="Nifty 50 intraday equity auto-trader (VWAP + RS).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "The rule set is NOT backtest-validated (best config -0.09R over 81\n"
            "sessions vs a +0.15R gate). Dry run is the default and the only\n"
            "justified mode today.\n\n"
            "Examples:\n"
            "  nifty50_vwap_rs.py\n"
            "  nifty50_vwap_rs.py --max-positions 2 --risk-per-trade 1000\n"
        ))
    p.add_argument("--live", action="store_true", help="Place REAL orders (see --i-understand…)")
    p.add_argument("--i-understand-the-backtest-failed", dest="ack", action="store_true",
                   help="Required alongside --live while the rules remain unvalidated")
    p.add_argument("--instance-id", default="")

    p.add_argument("--max-positions", type=int, default=3)
    p.add_argument("--max-per-sector", type=int, default=2)
    p.add_argument("--risk-per-trade", type=float, default=2000.0)
    p.add_argument("--max-order-value", type=float, default=200_000.0)
    p.add_argument("--max-deployed", type=float, default=600_000.0)
    p.add_argument("--max-trades", type=int, default=12)
    p.add_argument("--max-symbol-trades", type=int, default=2)
    p.add_argument("--symbol-cooldown", type=int, default=900)
    p.add_argument("--entry-spacing", type=int, default=60)
    p.add_argument("--max-daily-loss", type=float, default=6000.0)
    p.add_argument("--target-profit", type=float, default=10000.0)
    p.add_argument("--min-score", type=float, default=60.0)
    p.add_argument("--adx-min", type=float, default=20.0)
    p.add_argument("--atr-stop-mult", type=float, default=1.5)
    p.add_argument("--target-r", type=float, default=2.0)
    p.add_argument("--allow-short", action="store_true")
    # Off by default — it fired on 222/338 trades at -0.75R. Flag re-enables it.
    p.add_argument("--vwap-exit", dest="vwap_exit", action="store_true", default=False)
    p.add_argument("--base-tf", type=int, default=5, help="Signal timeframe, minutes")
    p.add_argument("--htf", type=int, default=30, help="Supertrend/ADX timeframe, minutes")

    p.add_argument("--entry-start", default="09:30")
    p.add_argument("--entry-cutoff", default="14:45")
    p.add_argument("--square-off", default="15:17")
    p.add_argument("--watchlist-size", type=int, default=12)
    p.add_argument("--poll-seconds", type=int, default=20)
    p.add_argument("--rank-time", default="09:35")
    p.add_argument("--rerank-minutes", type=int, default=15)
    p.add_argument("--candle-days", type=int, default=3)
    p.add_argument("--candle-pace", type=float, default=0.8,
                   help="Seconds between intraday-data calls (DH-904 guard)")
    args = p.parse_args()

    if args.live and not args.ack:
        p.error("--live requires --i-understand-the-backtest-failed.\n"
                "Best known config still returns -0.09R expectancy over 81 sessions\n"
                "(-0.09R even at zero cost) against a +0.15R gate, and lost money in a\n"
                "market that rose 4.5%. Fix the rules in lib/intraday_signals.py and\n"
                "re-run scripts/analysis/backtest_intraday_vwap_rs.py before risking capital.")
    if args.watchlist_size < 1:
        p.error("--watchlist-size must be >= 1")
    if args.poll_seconds < 5:
        p.error("--poll-seconds must be >= 5 (one REST call per watchlist symbol per cycle)")
    # Each cycle costs (watchlist + benchmark) calls at --candle-pace apart. If that
    # exceeds the cycle length the poller can never keep up and every snapshot is stale.
    cycle_cost = (args.watchlist_size + 1) * args.candle_pace
    if cycle_cost > args.poll_seconds:
        p.error(f"--watchlist-size {args.watchlist_size} at --candle-pace {args.candle_pace}s "
                f"needs {cycle_cost:.0f}s per cycle but --poll-seconds is {args.poll_seconds}. "
                f"Raise --poll-seconds to >= {int(cycle_cost) + 1} or shrink the watchlist.")

    cfg = IntradayConfig(
        max_positions=args.max_positions, max_per_sector=args.max_per_sector,
        risk_per_trade=args.risk_per_trade, max_order_value=args.max_order_value,
        max_deployed=args.max_deployed, max_trades_per_day=args.max_trades,
        max_symbol_trades=args.max_symbol_trades, symbol_cooldown_s=args.symbol_cooldown,
        entry_spacing_s=args.entry_spacing, min_score=args.min_score, adx_min=args.adx_min,
        atr_stop_mult=args.atr_stop_mult, target_r=args.target_r,
        allow_short=args.allow_short, exit_on_vwap_loss=args.vwap_exit,
        base_tf_min=args.base_tf, htf_min=args.htf,
        entry_start=args.entry_start, entry_cutoff=args.entry_cutoff,
        square_off=args.square_off,
    )

    state_key = f"{STRATEGY_KEY}_{args.instance_id}" if args.instance_id else STRATEGY_KEY
    IntradayEquityStrategy(
        cfg=cfg, dry_run=not args.live, state_key=state_key,
        watchlist_size=args.watchlist_size, poll_seconds=args.poll_seconds,
        rank_time=args.rank_time, rerank_minutes=args.rerank_minutes,
        max_daily_loss=args.max_daily_loss, target_profit=args.target_profit,
        candle_days=args.candle_days, candle_pace=args.candle_pace,
    ).run()


if __name__ == "__main__":
    main()

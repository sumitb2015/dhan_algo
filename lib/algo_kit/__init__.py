"""algo_kit: plug-and-play building blocks for strategies.

Each module is independent, imports no broker SDK, and does one job, so a strategy keeps its
own run() loop and picks only the pieces it needs:

    files      project root, flushing log handler, atomic JSON write, one-call logging setup
    cli        standard flag groups + validation (--live, --lots, --instance-id, --broker,
               --target-profit/--stop-loss, --trail-*, --start-time/--eod-time)
    position_store   crash-safe position file with the live/paper and expired-contract refusals,
                     plus today's-state restore for daily P&L caps
    confirm    broker-aware 'is this order filled' (Dhan status vs Zerodha/Kotak net position)
    legs       LegExecutor: all-or-nothing multi-leg entry with rollback, and a close that never lies
    fills      confirmed average fill price (wait_for_fill returns a bool, not a price)
    quotes     quote validity + field extraction, batched LTP lookup by named leg
    waits      shutdown-aware sleep
    risk       TargetSpec (rupee or percent), TrailingStop, Cooldown, time-window helpers

Order sizing and phantom-leg checks stay in lib/strategy_risk.py; dashboard state and the shutdown
trigger stay in lib/strategy_state_helper.py. See docs/ALGO_KIT.md for how to compose them.
"""
from .files import FlushingFileHandler, atomic_write_json, find_project_root, setup_strategy_logging
from .confirm import confirm_order_fill
from .legs import CloseResult, ExitResult, LegExecutor, OpenResult, leg_pnl
from .fills import confirmed_fill_price, read_order_fill_price
from .position_store import PositionFileError, PositionStore, load_today_state
from . import cli  # noqa: F401
from .quotes import (
    QuoteFields, extract_flat_chain_fields, extract_quote_fields, fetch_named_ltps, is_quote_invalid,
)
from .risk import Cooldown, TargetSpec, TrailingStop, hhmm_now, in_window, past_time, update_trail
from .waits import interruptible_sleep

__all__ = [
    "cli",
    "FlushingFileHandler", "atomic_write_json", "find_project_root", "setup_strategy_logging",
    "CloseResult", "ExitResult", "LegExecutor", "OpenResult", "leg_pnl",
    "confirm_order_fill", "confirmed_fill_price", "read_order_fill_price",
    "PositionFileError", "PositionStore", "load_today_state",
    "QuoteFields", "extract_flat_chain_fields", "extract_quote_fields", "fetch_named_ltps", "is_quote_invalid",
    "Cooldown", "TargetSpec", "TrailingStop", "hhmm_now", "in_window", "past_time", "update_trail",
    "interruptible_sleep",
]

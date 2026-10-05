"""Standard CLI flag groups. Add only the groups a strategy needs; each has a matching validator.

    p = argparse.ArgumentParser(...)
    cli.add_execution_args(p)         # --live --lots --instance-id --broker
    cli.add_exit_args(p)              # --target-profit --stop-loss --trail-start-rs --trail-gap-rs
    cli.add_window_args(p)            # --start-time --eod-time
    args = p.parse_args()
    errors = cli.validate_execution(args) + cli.validate_exit(args) + cli.validate_window(args)
    cli.exit_on_errors(errors, logger)
    state_key = cli.build_state_key(STRATEGY_KEY_DEFAULT, args.instance_id)

A flag the dashboard sends must exist here or the process exits 2 at spawn and the card sits at
STOPPED with no explanation (82f56a4): add the group, not a one-off flag.
"""
import re
import sys
from datetime import datetime
from typing import List, Optional

_INSTANCE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,20}$")


def _pct(text) -> str:
    """argparse %-formats help strings, so a literal % (a "10%" default) must be written %%."""
    return str(text).replace("%", "%%")


def add_execution_args(p, lots_default: int = 1, brokers: bool = True) -> None:
    p.add_argument("--live", action="store_true", default=False, help="Place real orders. Default: dry run.")
    p.add_argument("--lots", type=int, default=lots_default, metavar="N",
                   help=f"Lots per leg (default: {lots_default}).")
    p.add_argument("--instance-id", type=str, default="", metavar="ID",
                   help="Suffix for state/log files to run a second concurrent copy of this strategy.")
    if brokers:
        p.add_argument("--broker", choices=["dhan", "zerodha", "kotak"], default="dhan",
                       help="Execution broker. Market data always comes from Dhan. Zerodha/Kotak stops are "
                            "software-managed only (no resting broker-side stop order).")


def add_exit_args(p, target: str = "4000", stop: str = "4000", trail_start: float = 2000.0,
                  trail_gap: float = 1000.0, trail: bool = True) -> None:
    p.add_argument("--target-profit", type=str, default=target, metavar="INR|%",
                   help=f"Profit target in rupees or a percent of entry value, e.g. 4000 or 25%% (default: {_pct(target)}).")
    p.add_argument("--stop-loss", type=str, default=stop, metavar="INR|%",
                   help=f"Max loss in rupees or a percent of entry value (default: {_pct(stop)}).")
    if trail:
        p.add_argument("--trail-start-rs", type=float, default=trail_start, metavar="INR",
                       help=f"Arm the trailing stop at this MTM profit (default: {trail_start:g}).")
        p.add_argument("--trail-gap-rs", type=float, default=trail_gap, metavar="INR",
                       help=f"Exit on this giveback from the best MTM (default: {trail_gap:g}).")


def add_window_args(p, start: str = "09:20", eod: str = "15:17") -> None:
    p.add_argument("--start-time", type=str, default=start, metavar="HH:MM", help=f"Entry not before (default: {start}).")
    p.add_argument("--eod-time", type=str, default=eod, metavar="HH:MM", help=f"Square-off time (default: {eod}).")


def validate_execution(args) -> List[str]:
    errors = []
    if args.lots < 1:
        errors.append(f"--lots must be >= 1, got {args.lots}.")
    if args.instance_id and not _INSTANCE_ID_RE.match(args.instance_id):
        errors.append(f"--instance-id must match [A-Za-z0-9_-]{{1,20}}, got {args.instance_id!r}.")
    return errors


def validate_exit(args) -> List[str]:
    from lib.strategy_state_helper import parse_target_spec
    errors = []
    for flag in ("target_profit", "stop_loss"):
        try:
            parse_target_spec(getattr(args, flag))
        except ValueError as e:
            errors.append(f"--{flag.replace('_', '-')}: {e}")
    if hasattr(args, "trail_gap_rs"):
        if args.trail_gap_rs <= 0:
            errors.append(f"--trail-gap-rs must be > 0, got {args.trail_gap_rs}.")
        if args.trail_start_rs < 0:
            errors.append(f"--trail-start-rs must be >= 0, got {args.trail_start_rs}.")
    return errors


def validate_window(args) -> List[str]:
    errors = []
    for flag in ("start_time", "eod_time"):
        try:
            datetime.strptime(getattr(args, flag), "%H:%M")
        except ValueError:
            errors.append(f"--{flag.replace('_', '-')} must be HH:MM, got {getattr(args, flag)!r}.")
    if not errors and args.start_time >= args.eod_time:
        errors.append("--start-time must be earlier than --eod-time.")
    return errors


def build_state_key(default_key: str, instance_id: Optional[str]) -> str:
    """Must match strategyRegistry.ts and the state/trigger filenames byte for byte."""
    return f"{default_key}_{instance_id}" if instance_id else default_key


def exit_on_errors(errors: List[str], log) -> None:
    """Log every config problem, then exit 1 once, so the user fixes them all in one re-run."""
    if not errors:
        return
    for e in errors:
        log.error(f"[CONFIG ERROR] {e}")
    log.error("Aborting: fix the configuration errors above and retry.")
    sys.exit(1)

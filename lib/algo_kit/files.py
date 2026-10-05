"""File and logging plumbing every strategy needs before anything else runs."""
import json
import logging
import os
from datetime import datetime
from typing import Optional


def find_project_root(start: str) -> str:
    """Walk up from `start` to the folder holding login.py. Needed before `lib` is importable."""
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, "login.py")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            raise RuntimeError("Could not locate project root (login.py)")
        d = parent


class FlushingFileHandler(logging.FileHandler):
    """Flush every record so a crash does not lose the last lines the dashboard log viewer shows.

    Opens as UTF-8: strategies log P&L with the rupee sign, and a FileHandler left on the system ANSI
    codepage (cp1252 on Windows) fails to encode every such line and silently drops it, so the log
    looks intact while the P&L lines are missing exactly when you need them.
    """

    def __init__(self, filename, mode="a", encoding="utf-8", delay=False):
        super().__init__(filename, mode=mode, encoding=encoding, delay=delay)

    def emit(self, record):
        super().emit(record)
        self.flush()


def atomic_write_json(path: str, data: dict, indent: int = 2) -> None:
    """Write via a temp file and os.replace, so a crash can never leave a torn file behind."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=indent)
    os.replace(tmp, path)


def setup_strategy_logging(project_root: str, log_folder: str, instance_suffix: str = "",
                           level: int = logging.INFO, name: Optional[str] = None,
                           force: bool = False, log_file: Optional[str] = None) -> logging.Logger:
    """Configure file + console logging at import time and return the module logger.

    Log path: debug/logs/<log_folder>/YYYYMMDD[<instance_suffix>].log. Pass
    lib.strategy_state_helper.instance_log_suffix() as `instance_suffix` so a second copy of the
    strategy writes its own file. `log_folder` must match the dashboard's logs registry.
    `force=True` replaces handlers already installed on the root logger (basicConfig is otherwise a
    no-op once anything, such as an imported library, has configured logging).
    `log_file` overrides the whole path (absolute, or relative to `project_root`) for a strategy whose log
    predates the debug/logs/<folder>/ layout; `log_folder` is then ignored.
    """
    if log_file:
        path = log_file if os.path.isabs(log_file) else os.path.join(project_root, log_file)
    else:
        path = os.path.join(project_root, "debug", "logs", log_folder,
                            f"{datetime.now().strftime('%Y%m%d')}{instance_suffix}.log")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    logging.basicConfig(
        level=level,
        format="%(asctime)s - %(levelname)s - %(message)s",
        handlers=[
            FlushingFileHandler(path),
            logging.StreamHandler(),
        ],
        force=force,
    )
    return logging.getLogger(name)

import os
import re
import sys
import json
import copy
import atexit
import logging
import threading
from datetime import datetime

logger = logging.getLogger(__name__)

# --- Async state writer ---------------------------------------------------
# save_strategy_state() used to write the JSON file synchronously on every
# call, putting temp-write + os.replace on the strategy's 1-second hot loop.
# Now it only enqueues a snapshot; a single daemon thread coalesces pending
# states and writes each strategy's file at most once per wake (~0.5s).
_WRITE_COALESCE_SECS = 0.5

_pending_states = {}          # strategy_name -> latest state snapshot
_pending_lock = threading.Lock()
_dirty = threading.Event()
_writer_thread = None
_writer_lock = threading.Lock()


_INSTANCE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,20}$")


def get_instance_id():
    """
    Reads --instance-id straight from sys.argv.

    Logging is configured at import time, before argparse runs, so a second concurrent
    copy of a strategy needs to know its instance id earlier than parse_args() can tell
    it. Returns "" when the flag is absent (the normal single-instance case), so callers
    fall back to exactly the filenames they used before multi-instance support existed.
    """
    argv = sys.argv[1:]
    raw = None
    for i, arg in enumerate(argv):
        if arg == "--instance-id":
            raw = argv[i + 1] if i + 1 < len(argv) else None
            break
        if arg.startswith("--instance-id="):
            raw = arg.split("=", 1)[1]
            break
    if not raw or not _INSTANCE_ID_RE.match(raw):
        return ""
    return raw


def instance_log_suffix():
    """
    Filename suffix isolating this instance's log file: "" for the primary instance
    (unchanged filenames for every existing strategy), "_<id>" for a duplicated run.
    """
    instance_id = get_instance_id()
    return f"_{instance_id}" if instance_id else ""


def _write_state_file(strategy_name, state_dict):
    """Atomic temp-write + os.replace of debug/<strategy_name>_state.json."""
    try:
        # Resolve project root dynamically (parent of lib directory)
        lib_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.dirname(lib_dir)
        debug_dir = os.path.join(project_root, "debug")
        os.makedirs(debug_dir, exist_ok=True)

        file_path = os.path.join(debug_dir, f"{strategy_name}_state.json")
        temp_path = file_path + ".tmp"

        with open(temp_path, "w") as f:
            json.dump(state_dict, f, indent=2)

        # os.replace is atomic and replaces existing files on both Windows and Linux.
        os.replace(temp_path, file_path)
    except Exception as e:
        logger.error(f"Failed to save strategy state for {strategy_name}: {e}")


def _drain_pending():
    with _pending_lock:
        batch = dict(_pending_states)
        _pending_states.clear()
        _dirty.clear()
    for name, state in batch.items():
        _write_state_file(name, state)


def _writer_loop():
    while True:
        _dirty.wait()
        # Coalesce bursts: several loop iterations within the window become one write.
        threading.Event().wait(_WRITE_COALESCE_SECS)
        _drain_pending()


def flush_state():
    """Synchronously write any queued strategy states. Call before process exit."""
    _drain_pending()


def _ensure_writer_thread():
    global _writer_thread
    if _writer_thread is not None and _writer_thread.is_alive():
        return
    with _writer_lock:
        if _writer_thread is not None and _writer_thread.is_alive():
            return
        _writer_thread = threading.Thread(
            target=_writer_loop, daemon=True, name="strategy-state-writer"
        )
        _writer_thread.start()
        atexit.register(flush_state)


def save_strategy_state(strategy_name, state_dict):
    """
    Saves the current state of a strategy to a JSON file safely.
    Enqueues a snapshot for the background writer thread; the file on disk is
    at most ~0.5s behind the strategy loop (the dashboard polls far slower).
    """
    try:
        # Inject standard metadata
        state_dict["last_update"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        state_dict["pid"] = os.getpid()

        # Deep-copy so the strategy mutating its dict after this call cannot
        # race the writer thread's json.dump.
        snapshot = copy.deepcopy(state_dict)

        _ensure_writer_thread()
        with _pending_lock:
            _pending_states[strategy_name] = snapshot
        _dirty.set()
    except Exception as e:
        logger.error(f"Failed to queue strategy state for {strategy_name}: {e}")

def parse_target_spec(raw):
    """
    Parses a --target-profit / --stop-loss CLI value that may be an absolute
    rupee amount ("4000") or a percentage of entry value ("20%").

    Returns (value, is_percent): if is_percent is True, value is the percent
    (0-100) to resolve against the strategy's entry value once known; otherwise
    value is the absolute rupee amount, exactly as before this feature existed.

    Raises ValueError with a clear message on unparseable input.
    """
    s = str(raw).strip()
    if s.endswith('%'):
        try:
            return float(s[:-1].strip()), True
        except ValueError:
            raise ValueError(f"Invalid percentage value {raw!r} — expected e.g. '20%'")
    try:
        return float(s), False
    except ValueError:
        raise ValueError(f"Invalid target/stop-loss value {raw!r} — expected a number or a percentage like '20%'")


def exit_if_market_closed(helper, dry_run=False):
    """Exit immediately if the NSE market is not currently open. No-op in dry_run mode."""
    if dry_run:
        return
    if not helper.is_market_open():
        now = datetime.now()
        msg = (
            f"Market is closed ({now.strftime('%A %d-%b %Y %H:%M')}). "
            "Run with --dry-run to bypass. Exiting."
        )
        print(msg)
        logger.info(msg)
        sys.exit(0)

def check_shutdown_trigger(strategy_name):
    """
    Checks if a shutdown trigger file exists for the strategy.
    If so, returns True and deletes the trigger file.
    """
    try:
        lib_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.dirname(lib_dir)
        trigger_path = os.path.join(project_root, "debug", f"{strategy_name}_shutdown.trigger")
        if os.path.exists(trigger_path):
            try:
                os.remove(trigger_path)
            except Exception as delete_err:
                logger.error(f"Failed to remove trigger file {trigger_path}: {delete_err}")
            return True
    except Exception as e:
        logger.error(f"Error checking shutdown trigger for {strategy_name}: {e}")
    return False

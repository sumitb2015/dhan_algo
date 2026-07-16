import os
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

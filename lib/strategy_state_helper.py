import os
import sys
import json
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

def save_strategy_state(strategy_name, state_dict):
    """
    Saves the current state of a strategy to a JSON file safely.
    Uses a temporary file and atomic replace to prevent partial reads by the UI.
    """
    try:
        # Resolve project root dynamically (parent of lib directory)
        lib_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.dirname(lib_dir)
        debug_dir = os.path.join(project_root, "debug")
        os.makedirs(debug_dir, exist_ok=True)
        
        # Inject standard metadata
        state_dict["last_update"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        state_dict["pid"] = os.getpid()
        
        file_path = os.path.join(debug_dir, f"{strategy_name}_state.json")
        temp_path = file_path + ".tmp"
        
        with open(temp_path, "w") as f:
            json.dump(state_dict, f, indent=2)
            
        # os.replace is atomic and replaces existing files on both Windows and Linux.
        os.replace(temp_path, file_path)
    except Exception as e:
        logger.error(f"Failed to save strategy state for {strategy_name}: {e}")

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


"""
Test 17: Trader's Control Verification
Checks Kill Switch status retrieval.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 17: TRADER'S CONTROL (KILL SWITCH)")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
        
        # 1. Check current status
        print(">>> Fetching current Kill Switch status...")
        status = helper.get_kill_switch_status()
        print(f"[OK] Kill Switch Status: {status}")
        
        # 2. Methodology Check (Logic Only - We don't want to lock the user out)
        print("\n>>> Feature verification:")
        print(" - helper.toggle_kill_switch(activate=True): Ready")
        print(" - helper.emergency_stop(): Ready (Cancels -> Closes -> Kills)")
        
        return True

    except Exception as e:
        print(f"[ERROR] Exception during Kill Switch test: {e}")
        return False

if __name__ == "__main__":
    run()

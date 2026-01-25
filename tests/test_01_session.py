
"""
Test 01: Session and Basic Connectivity
"""
import sys
import os
import logging
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("TEST_01")

def run(helper=None):
    print("="*60)
    print("TEST 01: SESSION CHECK")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            if not dhan:
                print("[FAIL] Could not get Dhan Client (check login)")
                return False
            helper = DhanHelper(dhan)
            print("[OK] DhanHelper initialized (Locally)")
        else:
            print("[OK] DhanHelper initialized (Shared)")
        
        # Validate Session
        if helper.validate_session():
            print("[OK] Session Validated")
        else:
            print("[FAIL] Session Validation Failed (check token)")
            return False
            
        # Check Funds (basic read)
        funds = helper.funds()
        print(f"[OK] Funds fetch successful: {funds}")
        
        return True
        
    except Exception as e:
        print(f"[ERROR] Exception during session test: {e}")
        return False

if __name__ == "__main__":
    run()

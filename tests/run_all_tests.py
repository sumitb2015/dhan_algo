
"""
Master Orchestrator for Dhan Algo Test Suite
Runs all tests sequentially and reports status.
"""
import sys
import os
import importlib
import time

# Ensure project root is in path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# List of test modules in order
TEST_MODULES = [
    "test_01_session",
    "test_02_lookup",
    "test_03_market_data",
    "test_04_option_chain",
    "test_05_historical",
    "test_06_orders",
    "test_07_websocket",
    "test_08_portfolio",
    "test_09_expiry_logic",
    "test_10_trade_audit",
    "test_11_maintenance",
    "test_12_lot_size",
    "test_13_advanced_logic",
    "test_14_margin",
    "test_15_indicators",
    "test_16_comparison",
    "test_17_traders_control",
    "test_18_expired_options",
    "test_19_market_hub"
]

def main():
    print("="*80)
    print("DHAN ALGO - COMPREHENSIVE SYSTEM CHECK")
    print(f"Date: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*80)
    
    results = {}
    
    # Initialize Helper ONCE
    print("\n[INIT] Initializing Dhan Client and Master List...")
    try:
        # Import here to avoid circular dependencies if any, though likely safe at top
        from login import get_dhan_client
        from lib.dhan_helper import DhanHelper
        
        dhan = get_dhan_client()
        if not dhan:
            print("[CRITICAL FAIL] Could not get Dhan Client. Aborting tests.")
            return

        helper = DhanHelper(dhan)
        print("[INIT] DhanHelper Initialized Successfully.")
        
    except Exception as e:
        print(f"[CRITICAL FAIL] Exception during initialization: {e}")
        return

    for module_name in TEST_MODULES:
        print(f"\n>>> RUNNING {module_name}...")
        try:
            # Dynamically import and run
            mod = importlib.import_module(module_name)
            
            # Assuming each test module has a run() function that returns True/False
            if hasattr(mod, 'run'):
                # Try passing helper, if it fails (TypeError), try without arguments (backward compatibility)
                try:
                    success = mod.run(helper)
                except TypeError:
                     print(f"[WARN] Module {module_name} run() does not accept helper. Running without it.")
                     success = mod.run()
                     
                results[module_name] = "PASS" if success else "FAIL"
            else:
                print(f"[WARN] Module {module_name} has no run() function.")
                results[module_name] = "SKIP (No run())"
                
        except ImportError as e:
            print(f"[ERROR] Could not import {module_name}: {e}")
            results[module_name] = "ERROR (Import)"
        except Exception as e:
            print(f"[ERROR] Exception running {module_name}: {e}")
            results[module_name] = "ERROR (Runtime)"
            
    # Final Report
    print("\n\n" + "="*80)
    print("TEST REPORT SUMMARY")
    print("="*80)
    
    passed = 0
    total = len(TEST_MODULES)
    
    for name in TEST_MODULES:
        status = results.get(name, "UNKNOWN")
        print(f"{name:<30} : {status}")
        if status == "PASS":
            passed += 1
            
    print("-" * 80)
    print(f"TOTAL PASSED: {passed}/{total}")
    print("="*80)

if __name__ == "__main__":
    main()

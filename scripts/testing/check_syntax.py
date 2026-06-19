import py_compile
import os
import sys

# Get project root (grandparent of scripts/testing)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))

files_to_check = [
    os.path.join(PROJECT_ROOT, "lib", "dhan_helper.py"),
    os.path.join(PROJECT_ROOT, "strategies", "nifty_short_straddle.py")
]

print("Checking syntax...")
for f in files_to_check:
    try:
        py_compile.compile(f, doraise=True)
        print(f"[OK] {os.path.basename(f)}: Syntax OK")
    except py_compile.PyCompileError as e:
        print(f"[ERROR] {os.path.basename(f)}: Syntax Error")
        print(e)
    except Exception as e:
        print(f"[ERROR] {os.path.basename(f)}: Error {e}")

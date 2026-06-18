import py_compile
import os
import sys

files_to_check = [
    r"c:\dhan_algo\lib\dhan_helper.py",
    r"c:\dhan_algo\strategies\nifty_short_straddle.py"
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

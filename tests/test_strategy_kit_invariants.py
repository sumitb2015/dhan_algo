"""Every strategy imports cleanly, logs through lib/algo_kit (UTF-8, flushed per record) into the folder the
dashboard's log viewer reads, and has not re-grown a private logging class.

Stub broker, no network, no orders. Imports every strategy in ONE subprocess so global logging / sys.modules
stubs cannot leak into other tests.

Run: venv/bin/python -m pytest tests/test_strategy_kit_invariants.py -q
"""
import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROUTE = os.path.join(ROOT, "rs_dashboard", "app", "api", "strategies", "logs", "route.ts")

# Strategies whose log is deliberately not in the dashboard registry (so its viewer cannot show them yet),
# or that live outside debug/logs/<folder>/. Adding one here is a decision; see docs/ALGO_KIT.md.
NOT_IN_DASHBOARD_LOG_REGISTRY = {"nifty_overnight_fly", "nifty50_vwap_rs", "nifty_vwap_straddle"}

_CHILD = r'''
import sys, os, json, types, importlib.util, logging, glob
ROOT = sys.argv[1]; sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0], "--instance-id", "kitinv"]
login = types.ModuleType("login"); login.get_dhan_client = lambda: object(); sys.modules["login"] = login
dh = types.ModuleType("lib.dhan_helper")
class _H:
    def __init__(self, *a, **k): pass
dh.DhanHelper = _H; sys.modules["lib.dhan_helper"] = dh
out = {}
for path in sorted(glob.glob(os.path.join(ROOT, "strategies", "*", "*.py"))):
    if "Archives" in path or path.endswith("__init__.py"): continue
    name = os.path.basename(path)[:-3]
    root = logging.getLogger()
    for h in root.handlers[:]: root.removeHandler(h)
    try:
        spec = importlib.util.spec_from_file_location("kitinv_" + name, path); m = importlib.util.module_from_spec(spec)
        try: spec.loader.exec_module(m)
        except SystemExit: pass
        fh = [h for h in root.handlers if hasattr(h, "baseFilename")]
        out[name] = {"key": getattr(m, "STRATEGY_KEY", None) or getattr(m, "STRATEGY_KEY_DEFAULT", None),
                     "files": [{"path": os.path.relpath(h.baseFilename, ROOT), "encoding": h.encoding,
                                "flushes": type(h).emit is not logging.FileHandler.emit} for h in fh]}
    except Exception as e:
        out[name] = {"error": f"{type(e).__name__}: {e}"}
print("JSON:" + json.dumps(out))
for f in glob.glob(os.path.join(ROOT, "debug", "logs", "*", "*kitinv*.log")) + glob.glob(os.path.join(ROOT, "debug", "*kitinv*.log")): os.remove(f)
'''


def _imports():
    r = subprocess.run([sys.executable, "-c", _CHILD, ROOT], capture_output=True, text=True, timeout=300)
    line = [l for l in r.stdout.splitlines() if l.startswith("JSON:")]
    assert line, f"child produced no result:\n{r.stdout[-500:]}\n{r.stderr[-500:]}"
    return json.loads(line[0][5:])


def _dashboard_log_dirs():
    text = open(ROUTE, encoding="utf-8").read()
    block = text[text.index("STRATEGY_LOG_DIRS"):]
    block = block[:block.index("};")]
    return dict(re.findall(r"(\w+):\s*'([\w-]+)'", block))


def test_every_strategy_imports_and_logs_through_the_kit():
    result = _imports()
    assert len(result) >= 25, f"expected the full strategy set, found {sorted(result)}"
    bad = {k: v["error"] for k, v in result.items() if "error" in v}
    assert not bad, f"strategies that fail to import: {bad}"
    for name, info in result.items():
        assert len(info["files"]) == 1, f"{name}: expected exactly one file log handler, got {info['files']}"
        f = info["files"][0]
        assert f["encoding"] == "utf-8", f"{name}: file log is not UTF-8 (rupee lines are dropped on Windows)"
        assert f["flushes"], f"{name}: file log does not flush per record (a crash loses the last lines)"


def test_log_folder_matches_the_dashboard_log_registry():
    registry, result = _dashboard_log_dirs(), _imports()
    mismatched, checked = {}, 0
    for name, info in result.items():
        # the registry key is the script's file name; a STRATEGY_KEY constant, when present, agrees with it
        key = next((k for k in (name, info["key"]) if k in registry), None)
        if key is None:
            continue
        checked += 1
        folder = os.path.basename(os.path.dirname(info["files"][0]["path"]))
        if registry[key] != folder:
            mismatched[name] = {"writes_to": folder, "dashboard_reads": registry[key]}
    assert checked >= 20, f"only {checked} strategies matched the registry; the key lookup is broken"
    assert not mismatched, f"log viewer would show the wrong (or no) log: {mismatched}"


def test_registered_strategies_all_have_a_matching_script():
    registry, result = _dashboard_log_dirs(), _imports()
    keys = {i["key"] for i in result.values()} | set(result)
    missing = sorted(k for k in registry if k not in keys and k not in NOT_IN_DASHBOARD_LOG_REGISTRY
                     and k not in {"nifty_vwap_straddle", "nifty_intraday_vwap_straddle"})
    assert not missing, f"dashboard log registry lists strategies with no script: {missing}"


def test_no_strategy_defines_its_own_flushing_handler():
    offenders = []
    for p in glob.glob(os.path.join(ROOT, "strategies", "*", "*.py")):
        if "Archives" in p:
            continue
        if re.search(r"^class FlushingFileHandler\b", open(p, encoding="utf-8").read(), re.M):
            offenders.append(os.path.relpath(p, ROOT))
    assert not offenders, f"use lib.algo_kit.setup_strategy_logging instead of a private handler: {offenders}"

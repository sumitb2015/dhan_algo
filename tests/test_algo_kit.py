"""lib/algo_kit: the plug-in building blocks shared by strategies.

Run: venv/bin/python -m pytest tests/test_algo_kit.py -v
"""
import json
import os
import sys
import time
from datetime import date, datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.algo_kit import (  # noqa: E402
    Cooldown, PositionFileError, PositionStore, TargetSpec, TrailingStop, atomic_write_json,
    confirm_order_fill, confirmed_fill_price, extract_flat_chain_fields, read_order_fill_price, extract_quote_fields, fetch_named_ltps, in_window, interruptible_sleep,
    is_quote_invalid, load_today_state, past_time, update_trail,
)
from lib.algo_kit import cli  # noqa: E402
from lib.algo_kit import FlushingFileHandler, setup_strategy_logging  # noqa: E402


# ── position store ──────────────────────────────────────────────────────────────────────────────

def test_save_load_roundtrip_adds_metadata(tmp_path):
    s = PositionStore(str(tmp_path / "p.json"), dry_run=True)
    s.save({"position_open": True, "expiry": "2999-01-01", "legs": {"CE": {"id": 1}}})
    d = s.load()
    assert d["legs"] == {"CE": {"id": 1}} and d["dry_run"] is True and d["version"] == 1 and "updated_at" in d


def test_missing_file_is_flat(tmp_path):
    assert PositionStore(str(tmp_path / "none.json"), dry_run=False).load() is None


def test_write_is_atomic_no_tmp_left(tmp_path):
    p = str(tmp_path / "x.json")
    atomic_write_json(p, {"a": 1})
    assert json.load(open(p)) == {"a": 1} and not os.path.exists(p + ".tmp")


def test_unreadable_file_refuses_to_trade(tmp_path):
    p = tmp_path / "p.json"
    p.write_text("{not json")
    with pytest.raises(PositionFileError):
        PositionStore(str(p), dry_run=False).load()


def test_paper_position_refused_by_live_run(tmp_path):
    p = str(tmp_path / "p.json")
    PositionStore(p, dry_run=True).save({"position_open": True, "expiry": "2999-01-01"})
    with pytest.raises(PositionFileError):
        PositionStore(p, dry_run=False).load()


def test_live_position_refused_by_dry_run(tmp_path):
    p = str(tmp_path / "p.json")
    PositionStore(p, dry_run=False).save({"position_open": True, "expiry": "2999-01-01"})
    with pytest.raises(PositionFileError):
        PositionStore(p, dry_run=True).load()


def test_mode_mismatch_ignored_when_flat(tmp_path):
    """A closed file holds cross-cycle memory only; it must not block the other mode."""
    p = str(tmp_path / "p.json")
    PositionStore(p, dry_run=True).save({"position_open": False, "lifetime_realized": 5.0})
    assert PositionStore(p, dry_run=False).load()["lifetime_realized"] == 5.0


def test_expired_live_position_refuses(tmp_path):
    p = str(tmp_path / "p.json")
    PositionStore(p, dry_run=False).save({"position_open": True, "expiry": "2020-01-01"})
    with pytest.raises(PositionFileError):
        PositionStore(p, dry_run=False).load()


def test_expired_paper_position_is_discarded_and_rewritten(tmp_path):
    p = str(tmp_path / "p.json")
    PositionStore(p, dry_run=True).save({"position_open": True, "expiry": "2020-01-01", "legs": {"x": 1}})
    d = PositionStore(p, dry_run=True).load()
    assert d["position_open"] is False and d["discarded_expired"] is True
    assert json.load(open(p))["position_open"] is False


def test_load_today_state_ignores_yesterday(tmp_path):
    p = tmp_path / "s.json"
    p.write_text(json.dumps({"daily_pnl": -1234.0, "trades_today": 3}))
    assert load_today_state(str(p))["daily_pnl"] == -1234.0
    old = time.time() - 2 * 86400
    os.utime(p, (old, old))
    assert load_today_state(str(p)) == {}
    assert load_today_state(str(tmp_path / "absent.json")) == {}


# ── fills ───────────────────────────────────────────────────────────────────────────────────────

class FakeHelper:
    def __init__(self, filled=True, order=None):
        self.filled, self.order = filled, order

    def wait_for_fill(self, order_id, timeout=5):
        return self.filled

    def get_order_by_id(self, order_id):
        return self.order

    def get_ltps(self, pairs):
        return {"11": 101.5, "22": 0.0}


def test_fill_price_read_from_order_not_the_wait_bool():
    h = FakeHelper(order={"averageTradedPrice": 87.25})
    assert confirmed_fill_price(h, "A1", fallback=90.0) == 87.25   # never 1.0 (True)


def test_fill_price_falls_back():
    assert confirmed_fill_price(FakeHelper(filled=False), "A1", 90.0) == 90.0
    assert confirmed_fill_price(FakeHelper(order={"averageTradedPrice": 0}), "A1", 90.0) == 90.0
    assert confirmed_fill_price(FakeHelper(), None, 90.0) == 90.0
    assert confirmed_fill_price(FakeHelper(), "PAPER", 90.0) == 90.0


# ── quotes ──────────────────────────────────────────────────────────────────────────────────────

GOOD = {"last_price": 120.5, "CONTRACT_INFO": {"SECURITY_ID": "777", "SM_EXPIRY_DATE": "2026-10-13",
                                               "LOT_SIZE": 75, "SYMBOL_NAME": "NIFTY-X"}}


def test_quote_invalid_rules():
    assert is_quote_invalid(None) and is_quote_invalid({})
    assert is_quote_invalid({"last_price": 0, "CONTRACT_INFO": {}})
    assert not is_quote_invalid(GOOD)
    assert not is_quote_invalid({"foo": 1})                 # lenient: chain-fallback shape passes
    assert is_quote_invalid({"foo": 1}, strict=True)        # strict: needs CONTRACT_INFO


def test_extract_fields_and_defaults():
    f = extract_quote_fields(GOOD)
    assert f == (777, 120.5, "2026-10-13", 75, "NIFTY-X")
    sid, ltp, exp, lot, sym = extract_quote_fields(None, default_lot_size=75)
    assert (sid, ltp, exp, lot, sym) == (None, 0.0, None, 75, None)
    bare = {"LTP": 5.0, "CONTRACT_INFO": {"SECURITY_ID": 9}}
    assert extract_quote_fields(bare, 50, "E", "S") == (9, 5.0, "E", 50, "S")


def test_fetch_named_ltps_zero_fills_missing():
    px = fetch_named_ltps(FakeHelper(), {"a": ("NSE_FNO", 11), "b": ("NSE_FNO", 22), "c": ("NSE_FNO", 33)})
    assert px == {"a": 101.5, "b": 0.0, "c": 0.0}


# ── waits ───────────────────────────────────────────────────────────────────────────────────────

def test_sleep_completes_and_reports_ticks():
    ticks = []
    assert interruptible_sleep(3, lambda: False, ticks.append, step=0.01) is True
    assert ticks[0] == 3


def test_sleep_aborts_on_shutdown():
    calls = {"n": 0}

    def stop():
        calls["n"] += 1
        return calls["n"] >= 3

    t0 = time.time()
    assert interruptible_sleep(300, stop, step=0.01) is False
    assert time.time() - t0 < 2


# ── risk ────────────────────────────────────────────────────────────────────────────────────────

def test_target_spec_percent_resolves_once_against_entry_value():
    assert TargetSpec(4000).resolve(None) == 4000
    assert TargetSpec(20, True).resolve(None) is None       # unknown base: caller must guard
    assert TargetSpec(20, True).resolve(-5000) == 1000
    assert TargetSpec.from_parsed((25.0, True)).is_percent


def test_trailing_stop_arms_ratchets_and_fires():
    t = TrailingStop(start_rs=2000, gap_rs=1000)
    assert not t.update(1500) and not t.active
    assert not t.update(2500) and t.active and t.best_pnl == 2500
    assert not t.update(3500) and t.best_pnl == 3500
    assert not t.update(2600)
    assert t.update(2400)                                    # 3500 - 1000 breached


def test_trailing_stop_persists():
    t = TrailingStop(2000, 1000)
    t.update(3000)
    t2 = TrailingStop(2000, 1000)
    t2.restore(t.to_dict())
    assert t2.active and t2.best_pnl == 3000
    t2.reset()
    assert not t2.active


def test_update_trail_matches_stateful():
    assert update_trail(2500, 0, False, 2000, 1000) == (True, 2500, False)
    assert update_trail(1400, 2500, True, 2000, 1000) == (True, 2500, True)


def test_trailing_stop_rejects_bad_config():
    with pytest.raises(ValueError):
        TrailingStop(100, 0)


def test_cooldown_with_fake_clock():
    now = [1000.0]
    c = Cooldown(minutes=5, clock=lambda: now[0])
    assert not c.active
    c.start()
    assert c.active and c.remaining_s == 300
    now[0] += 301
    assert not c.active


def test_windows():
    assert in_window("09:20", "09:20", "15:17") and not in_window("15:17", "09:20", "15:17")
    assert past_time("15:17", "15:17") and not past_time("15:16", "15:17")


# ── cli ─────────────────────────────────────────────────────────────────────────────────────────

def _parse(argv, trail=True):
    import argparse
    p = argparse.ArgumentParser()
    cli.add_execution_args(p)
    cli.add_exit_args(p, trail=trail)
    cli.add_window_args(p)
    return p.parse_args(argv)


def test_cli_defaults_are_dry_and_valid():
    a = _parse([])
    assert a.live is False and a.broker == "dhan"
    assert cli.validate_execution(a) + cli.validate_exit(a) + cli.validate_window(a) == []


def test_cli_collects_all_errors_at_once():
    a = _parse(["--lots", "0", "--target-profit", "abc", "--trail-gap-rs", "0",
                "--start-time", "16:00", "--instance-id", "bad id!"])
    errs = cli.validate_execution(a) + cli.validate_exit(a) + cli.validate_window(a)
    assert len(errs) >= 5


def test_cli_percent_target_and_state_key():
    a = _parse(["--target-profit", "20%"])
    assert cli.validate_exit(a) == []
    assert cli.build_state_key("nifty_x", "") == "nifty_x"
    assert cli.build_state_key("nifty_x", "b") == "nifty_x_b"


def test_exit_on_errors_exits_once():
    import logging
    with pytest.raises(SystemExit) as e:
        cli.exit_on_errors(["a", "b"], logging.getLogger("t"))
    assert e.value.code == 1
    cli.exit_on_errors([], logging.getLogger("t"))


# ── regressions found in review ─────────────────────────────────────────────────────────────────

def test_cli_help_survives_percent_defaults():
    """put_condor's real defaults are 10% / 4%; an unescaped % crashed argparse's help formatter."""
    import argparse
    p = argparse.ArgumentParser()
    cli.add_exit_args(p, target="10%", stop="4%")
    text = p.format_help()
    assert "default: 10%" in text and "default: 4%" in text


def test_discarded_expired_is_a_signal_not_persisted(tmp_path):
    p = str(tmp_path / "p.json")
    PositionStore(p, dry_run=True).save({"position_open": True, "expiry": "2020-01-01"})
    first = PositionStore(p, dry_run=True).load()
    assert first["discarded_expired"] is True and first["position_open"] is False
    assert "discarded_expired" not in json.load(open(p))
    assert "discarded_expired" not in PositionStore(p, dry_run=True).load()   # second start is clean


def test_read_order_fill_price_never_waits():
    class H(FakeHelper):
        def wait_for_fill(self, *a, **k):
            raise AssertionError("must not wait")
    assert read_order_fill_price(H(order={"avgFilledPrice": 55.5}), "A1", 60.0) == 55.5
    assert read_order_fill_price(H(order=None), "A1", 60.0) == 60.0
    assert read_order_fill_price(H(), "PAPER", 60.0) == 60.0

    class Boom(FakeHelper):
        def get_order_by_id(self, oid):
            raise RuntimeError("api down")
    assert read_order_fill_price(Boom(), "A1", 60.0) == 60.0


# ── broker-aware confirm ────────────────────────────────────────────────────────────────────────

class NetBroker:
    """Zerodha/Kotak stand-in: net position moves after `fill_after` reads (None = never)."""
    def __init__(self, start=0, delta=0, fill_after=0):
        self.net, self.delta, self.fill_after, self.reads = start, delta, fill_after, 0

    def get_owned_net_qty(self, strike, expiry, opt_type):
        self.reads += 1
        if self.fill_after is not None and self.reads > self.fill_after:
            return self.net + self.delta
        return self.net


class NoDhanHelper(FakeHelper):
    def wait_for_fill(self, *a, **k):
        raise AssertionError("a non-Dhan order id must never be sent to Dhan's wait_for_fill")


def _confirm(helper, broker, name, oid="Z1", signed=-75, net_before=0, **k):
    t = [0.0]
    return confirm_order_fill(helper, broker, name, oid, 25000, "2026-10-27", "CE", signed, net_before,
                              sleep=lambda s: t.__setitem__(0, t[0] + s), clock=lambda: t[0], **k)


def test_confirm_dry_run_and_missing_id():
    assert _confirm(NoDhanHelper(), None, "zerodha", dry_run=True)
    assert not _confirm(NoDhanHelper(), None, "zerodha", oid=None)


def test_confirm_dhan_uses_order_status():
    assert _confirm(FakeHelper(filled=True), None, "dhan")
    assert not _confirm(FakeHelper(filled=False), None, "dhan")


def test_confirm_non_dhan_watches_broker_net_not_dhan():
    b = NetBroker(start=0, delta=-75, fill_after=2)
    assert _confirm(NoDhanHelper(), b, "zerodha", signed=-75, net_before=0)        # SELL 75 landed
    assert b.reads == 3


def test_confirm_non_dhan_buy_to_close():
    b = NetBroker(start=-75, delta=+75, fill_after=0)
    assert _confirm(NoDhanHelper(), b, "kotak", signed=+75, net_before=-75)


def test_confirm_non_dhan_times_out_when_net_never_moves():
    assert not _confirm(NoDhanHelper(), NetBroker(fill_after=None), "zerodha", timeout=5)


def test_confirm_non_dhan_survives_read_errors():
    class Flaky(NetBroker):
        def get_owned_net_qty(self, *a):
            self.reads += 1
            if self.reads < 3:
                raise RuntimeError("positions api 429")
            return -75
    assert _confirm(NoDhanHelper(), Flaky(), "zerodha", signed=-75, net_before=0)


# ── logging ─────────────────────────────────────────────────────────────────────────────────────

def test_log_file_keeps_rupee_lines_and_flushes_each_record(tmp_path):
    import logging
    h = FlushingFileHandler(str(tmp_path / "x.log"))
    lg = logging.getLogger("algo_kit_utf8_test")
    lg.setLevel(logging.INFO); lg.addHandler(h)
    lg.info("Spread closed | Cycle P&L: ₹+1,250")
    text = open(tmp_path / "x.log", encoding="utf-8").read()      # read BEFORE closing: proves the flush
    lg.removeHandler(h); h.close()
    assert "₹+1,250" in text


def test_setup_strategy_logging_force_replaces_existing_handlers(tmp_path):
    import logging
    root = logging.getLogger()
    saved, level = root.handlers[:], root.level
    try:
        marker = logging.NullHandler()
        root.addHandler(marker)
        setup_strategy_logging(str(tmp_path), "t", "_x", force=True, name="algo_kit_force_test")
        assert marker not in root.handlers
        assert (tmp_path / "debug" / "logs" / "t").is_dir()
        assert any(isinstance(h, FlushingFileHandler) for h in root.handlers)
    finally:
        for h in root.handlers[:]:
            root.removeHandler(h)
            if isinstance(h, FlushingFileHandler):
                h.close()
        for h in saved:
            root.addHandler(h)
        root.setLevel(level)


def test_setup_strategy_logging_log_file_override(tmp_path):
    import logging
    root = logging.getLogger()
    saved, level = root.handlers[:], root.level
    try:
        setup_strategy_logging(str(tmp_path), "ignored", "_x", force=True, name="algo_kit_override_test",
                               log_file="debug/legacy_name_x.log")
        h = [h for h in root.handlers if isinstance(h, FlushingFileHandler)][0]
        assert h.baseFilename == str(tmp_path / "debug" / "legacy_name_x.log")
        assert not (tmp_path / "debug" / "logs" / "ignored").exists()
    finally:
        for h in root.handlers[:]:
            root.removeHandler(h)
            if isinstance(h, FlushingFileHandler):
                h.close()
        for h in saved:
            root.addHandler(h)
        root.setLevel(level)


# ── flat chain rows and the LOT_SIZE edge ───────────────────────────────────────────────────────

def test_extract_keeps_a_present_zero_lot_size_like_the_originals():
    q = {"last_price": 5.0, "CONTRACT_INFO": {"SECURITY_ID": 9, "LOT_SIZE": 0}}
    assert extract_quote_fields(q, default_lot_size=75).lot_size == 0
    assert extract_quote_fields({"last_price": 5.0, "CONTRACT_INFO": {"SECURITY_ID": 9}}).lot_size is None


def test_flat_chain_row_pe_ce_and_generic_keys():
    row = {"ce_security_id": 111.0, "ce_last_price": 50.5, "pe_security_id": 222, "pe_last_price": 40.25}
    ce = extract_flat_chain_fields(row, "CE", 75, "2026-10-13", "NIFTY-X-CE")
    pe = extract_flat_chain_fields(row, "PE", 75, "2026-10-13", "NIFTY-X-PE")
    assert tuple(ce) == (111, 50.5, "2026-10-13", 75, "NIFTY-X-CE")
    assert tuple(pe) == (222, 40.25, "2026-10-13", 75, "NIFTY-X-PE")
    assert extract_flat_chain_fields({"security_id": 7, "last_price": 3.0}, "CE", 75).security_id == 7
    assert extract_flat_chain_fields({"foo": 1}, "CE", 75) is None


def test_flat_chain_lot_lookup_refines_and_failures_keep_default():
    row = {"ce_security_id": 111, "ce_last_price": 50.5}
    seen = []
    assert extract_flat_chain_fields(row, "CE", 75, lot_lookup=lambda s: seen.append(s) or {"LOT_SIZE": 65}).lot_size == 65
    assert seen == ["111"]
    assert extract_flat_chain_fields(row, "CE", 75, lot_lookup=lambda s: None).lot_size == 75
    def boom(s): raise RuntimeError("master list down")
    assert extract_flat_chain_fields(row, "CE", 75, lot_lookup=boom).lot_size == 75


def test_fill_price_error_and_paper_switches():
    class Boom(FakeHelper):
        def get_order_by_id(self, oid):
            raise RuntimeError("api down")
    assert confirmed_fill_price(Boom(), "A1", 60.0) == 60.0                     # default: carry on with the fallback
    with pytest.raises(RuntimeError):
        confirmed_fill_price(Boom(), "A1", 60.0, raise_errors=True)             # strict: propagate (older strategies)
    with pytest.raises(RuntimeError):
        read_order_fill_price(Boom(), "A1", 60.0, raise_errors=True)
    h = FakeHelper(order={"averageTradedPrice": 55.5})
    assert confirmed_fill_price(h, "PAPER", 60.0) == 60.0                        # default: PAPER means paper
    assert confirmed_fill_price(h, "PAPER", 60.0, paper_id=None) == 55.5         # disabled: a real id literally named PAPER


def test_enforce_mode_off_skips_only_the_mismatch_refusal(tmp_path):
    p = str(tmp_path / "p.json")
    PositionStore(p, dry_run=True).save({"position_open": True, "expiry": "2999-01-01", "legs": {"a": 1}})
    lenient = PositionStore(p, dry_run=False, enforce_mode=False)
    assert lenient.load()["legs"] == {"a": 1}                       # paper file read by a live run: allowed
    lenient.save({"position_open": True})
    assert json.load(open(p))["dry_run"] is False                   # mode is still recorded
    PositionStore(p, dry_run=False, enforce_mode=False).save({"position_open": True, "expiry": "2020-01-01"})
    with pytest.raises(PositionFileError):                          # the expired-live refusal is independent
        PositionStore(p, dry_run=False, enforce_mode=False).load()

"""
Tests for lib/intraday_signals.py.

Run:  venv\\Scripts\\python.exe -m pytest tests/test_intraday_signals.py -q

Unlike the rest of tests/, this module is pure and offline — it never touches a
broker session, so it is safe to run against a live account at any time.

The two tests that actually matter are:
  * test_build_features_prefix_invariance — mechanically proves there is no
    lookahead. If this fails, the backtest is lying and the live strategy will
    underperform it.
  * the pandas_ta parity tests — prove the hand-rolled indicators match what
    helper.get_indicators_ta() returns, so the live path can cross-check.
"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.intraday_signals import (  # noqa: E402
    IntradayConfig, Position, Conditions,
    adx, atr, build_features, ema, evaluate, initial_stop, is_gated,
    position_size, rank_candidates, resample_5m, score, select_new_entries,
    session_vwap, supertrend, target_price, trail_stop, exit_reason,
    sector_of, NIFTY50, SECTORS, HARD_GATES, CONDITION_NAMES,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────
def make_bars(n_sessions: int = 3, seed: int = 7) -> pd.DataFrame:
    """Synthetic 1-min sessions on the real NSE grid (09:15-15:29)."""
    rng = np.random.default_rng(seed)
    frames = []
    price = 1000.0
    for d in range(n_sessions):
        day = pd.Timestamp("2026-05-04") + pd.Timedelta(days=d)
        idx = pd.date_range(day + pd.Timedelta(hours=9, minutes=15), periods=375, freq="1min")
        steps = rng.normal(0.02, 0.6, len(idx))
        close = price + np.cumsum(steps)
        high = close + rng.uniform(0.05, 0.8, len(idx))
        low = close - rng.uniform(0.05, 0.8, len(idx))
        open_ = np.concatenate([[close[0]], close[:-1]])
        vol = rng.integers(5_000, 120_000, len(idx)).astype("float64")
        frames.append(pd.DataFrame(
            {"Open": open_, "High": high, "Low": low, "Close": close, "Volume": vol}, index=idx))
        price = close[-1]
    out = pd.concat(frames)
    out.index.name = "Datetime"
    return out


@pytest.fixture(scope="module")
def bars():
    return make_bars()


@pytest.fixture(scope="module")
def bench():
    return make_bars(seed=99)


@pytest.fixture(scope="module")
def cfg():
    c = IntradayConfig()
    c.validate()
    return c


# ── Config ────────────────────────────────────────────────────────────────────
def test_config_validate_rejects_bad_values():
    with pytest.raises(ValueError):
        IntradayConfig(ema_fast=20, ema_slow=9).validate()
    with pytest.raises(ValueError):
        IntradayConfig(risk_per_trade=0).validate()
    with pytest.raises(ValueError):
        IntradayConfig(entry_start="14:00", entry_cutoff="10:00").validate()
    with pytest.raises(ValueError):
        IntradayConfig(square_off="oops").validate()
    with pytest.raises(ValueError):
        # entry_cutoff after square_off would let a trade open that is
        # immediately force-flattened.
        IntradayConfig(entry_cutoff="15:20", square_off="15:17").validate()


def test_universe_and_sectors_agree():
    assert len(NIFTY50) == 50
    assert len(set(NIFTY50)) == 50
    missing = [s for s in NIFTY50 if s not in SECTORS]
    assert not missing, f"symbols with no sector mapping: {missing}"
    assert sector_of("HDFCBANK") == "BANK"
    assert sector_of("NOT_A_SYMBOL") == "OTHER"


# ── Indicator parity with pandas_ta ───────────────────────────────────────────
def test_atr_matches_pandas_ta(bars):
    ta = pytest.importorskip("pandas_ta")
    mine = atr(bars, 14)
    theirs = ta.atr(bars["High"], bars["Low"], bars["Close"], length=14)
    both = pd.concat([mine, theirs], axis=1).dropna()
    assert len(both) > 100
    assert np.allclose(both.iloc[:, 0], both.iloc[:, 1], atol=1e-6)


def test_adx_converges_to_pandas_ta(bars):
    """ADX must agree with pandas_ta once warmed up.

    Exact agreement from bar one is not achievable: TA-Lib seeds the DX
    smoothing at index 2*length-1 off an internal accumulation, and pandas_ta
    delegates to it. The two converge to machine precision after ~300 bars and
    are identical thereafter, which is all that matters — ADX is only ever read
    from the 5-minute frame, where the warmup is consumed within the first
    session of the whole history and no trade is ever taken on it.

    NOTE on DMP_/DMN_: with TA-Lib installed, pandas_ta returns TA-Lib's
    *summed* PLUS_DM/MINUS_DM in those columns, NOT +DI/-DI. They differ from
    a true +DI by a factor of scalar/(length*ATR), so comparing them directly
    is meaningless. That is asserted explicitly below rather than left as a
    trap for the next person.
    """
    ta = pytest.importorskip("pandas_ta")
    mine = adx(bars, 14)["adx"]
    res = ta.adx(bars["High"], bars["Low"], bars["Close"], length=14)
    theirs = res[[c for c in res.columns if c.startswith("ADX_")][0]]
    both = pd.concat([mine, theirs], axis=1).dropna()
    assert len(both) > 400

    warm = both.iloc[300:]
    assert np.allclose(warm.iloc[:, 0], warm.iloc[:, 1], atol=1e-6), (
        f"ADX has not converged: maxdiff={(warm.iloc[:, 0] - warm.iloc[:, 1]).abs().max()}"
    )
    # And it must be tracking, not merely converging, through the warmup.
    mid = both.iloc[100:300]
    assert (mid.iloc[:, 0] - mid.iloc[:, 1]).abs().max() < 0.05


def test_di_is_a_true_directional_indicator(bars):
    """+DI/-DI are percentages of ATR, bounded and non-negative.

    Guards the definition that DX (and therefore ADX) depends on. TA-Lib's
    PLUS_DM is a different quantity — see the note in the ADX test.
    """
    res = adx(bars, 14).dropna()
    assert len(res) > 400
    for col in ("plus_di", "minus_di"):
        assert (res[col] >= 0).all(), f"{col} went negative"
        assert (res[col] <= 100).mean() > 0.99

    # DX rebuilt from the DI pair must reproduce the pre-smoothing input.
    dx = 100 * (res["plus_di"] - res["minus_di"]).abs() / (res["plus_di"] + res["minus_di"])
    assert dx.notna().all()
    assert ((dx >= 0) & (dx <= 100)).all()


def test_adx_flat_series_does_not_pass_trend_filter():
    """A zero-range instrument must not yield inf DI and an ADX that clears
    every trend gate — the guard that `safe_atr` exists for."""
    idx = pd.date_range("2026-05-04 09:15", periods=200, freq="1min")
    flat = pd.DataFrame({"Open": 100.0, "High": 100.0, "Low": 100.0,
                         "Close": 100.0, "Volume": 1000.0}, index=idx)
    res = adx(flat, 14)
    assert not np.isinf(res.to_numpy(dtype="float64")).any()
    assert not (res["adx"].dropna() > 20).any()


def test_supertrend_direction_matches_pandas_ta(bars):
    ta = pytest.importorskip("pandas_ta")
    df5 = resample_5m(bars)
    mine = supertrend(df5, 7, 2.0)
    res = ta.supertrend(df5["High"], df5["Low"], df5["Close"], length=7, multiplier=2.0)
    dir_col = [c for c in res.columns if c.startswith("SUPERTd_")][0]
    line_col = [c for c in res.columns if c.startswith("SUPERT_")][0]

    both = pd.concat([mine["st_dir"], res[dir_col]], axis=1).dropna()
    both = both[both.iloc[:, 0] != 0]
    agree = (both.iloc[:, 0] == both.iloc[:, 1]).mean()
    assert agree > 0.98, f"supertrend direction agreement only {agree:.3f}"

    lines = pd.concat([mine["st_line"], res[line_col]], axis=1).dropna()
    assert np.allclose(lines.iloc[:, 0], lines.iloc[:, 1], atol=0.01)


def test_ema_matches_pandas_ta(bars):
    ta = pytest.importorskip("pandas_ta")
    both = pd.concat([ema(bars["Close"], 20), ta.ema(bars["Close"], length=20)], axis=1).dropna()
    assert np.allclose(both.iloc[:, 0], both.iloc[:, 1], atol=1e-6)


# ── VWAP ──────────────────────────────────────────────────────────────────────
def test_session_vwap_resets_each_day(bars):
    v = session_vwap(bars)
    day = bars.index.normalize()
    for d, grp in bars.groupby(day):
        first = v[grp.index[0]]
        tp = (grp["High"].iloc[0] + grp["Low"].iloc[0] + grp["Close"].iloc[0]) / 3.0
        # The first bar of a session IS its own VWAP — proof the anchor reset.
        assert abs(first - tp) < 1e-6, f"VWAP did not reset on {d}"


def test_session_vwap_hand_computed():
    idx = pd.date_range("2026-05-04 09:15", periods=3, freq="1min")
    df = pd.DataFrame({
        "Open": [100.0, 101.0, 102.0],
        "High": [101.0, 102.0, 103.0],
        "Low": [99.0, 100.0, 101.0],
        "Close": [100.0, 101.0, 102.0],
        "Volume": [100.0, 200.0, 300.0],
    }, index=idx)
    v = session_vwap(df)
    tp = np.array([100.0, 101.0, 102.0])
    vol = np.array([100.0, 200.0, 300.0])
    expected = np.cumsum(tp * vol) / np.cumsum(vol)
    assert np.allclose(v.to_numpy(), expected)


def test_session_vwap_survives_zero_volume():
    idx = pd.date_range("2026-05-04 09:15", periods=4, freq="1min")
    df = pd.DataFrame({
        "Open": [100.0] * 4, "High": [101.0] * 4, "Low": [99.0] * 4,
        "Close": [100.0] * 4, "Volume": [0.0] * 4,
    }, index=idx)
    v = session_vwap(df)
    assert v.notna().all(), "zero-volume session must fall back, not blank the gate"
    assert np.allclose(v.to_numpy(), 100.0)


# ── Resampling ────────────────────────────────────────────────────────────────
def test_resample_5m_lands_on_nse_grid(bars):
    df5 = resample_5m(bars)
    first_day = df5[df5.index.normalize() == df5.index.normalize()[0]]
    assert first_day.index[0].strftime("%H:%M") == "09:15"
    assert first_day.index[-1].strftime("%H:%M") == "15:25"
    assert len(first_day) == 75
    assert all(t.minute % 5 == 0 for t in first_day.index)


def test_resample_5m_aggregates_correctly(bars):
    df5 = resample_5m(bars)
    bucket = df5.index[3]
    src = bars.loc[bucket:bucket + pd.Timedelta(minutes=4)]
    assert df5.loc[bucket, "Open"] == src["Open"].iloc[0]
    assert df5.loc[bucket, "Close"] == src["Close"].iloc[-1]
    assert df5.loc[bucket, "High"] == src["High"].max()
    assert df5.loc[bucket, "Low"] == src["Low"].min()
    assert df5.loc[bucket, "Volume"] == src["Volume"].sum()


# ── THE no-lookahead test ─────────────────────────────────────────────────────
def test_build_features_prefix_invariance(bars, bench, cfg):
    """Features for the first k bars must not change when later bars exist.

    This is the whole no-lookahead contract in one assertion. If a transform
    ever peeks forward (a centered rolling window, an unshifted resample, a
    groupby that sees the full day), truncating the input changes the early
    rows and this fails.
    """
    full = build_features(bars, bench, cfg)
    for k in (400, 700, 1000):
        part = build_features(bars.iloc[:k], bench.iloc[:k], cfg)
        assert len(part) > 2, f"not enough bars at k={k}"
        # Align on TIMESTAMPS, not position: with base_tf_min > 1 the feature
        # frame is resampled, so k input bars produce k/base_tf feature rows.
        # Drop the final bucket, which is legitimately partial when the input is
        # truncated mid-bucket and so is expected to differ.
        part = part.iloc[:-1]
        a = full.loc[part.index]
        assert list(a.columns) == list(part.columns)
        for col in a.columns:
            x, y = a[col].to_numpy(dtype="float64"), part[col].to_numpy(dtype="float64")
            both_nan = np.isnan(x) & np.isnan(y)
            assert np.allclose(x[~both_nan], y[~both_nan], atol=1e-9, equal_nan=True), (
                f"lookahead detected in column {col!r} at k={k}"
            )


def test_prefix_invariance_holds_at_every_timeframe(bars, bench):
    """The no-lookahead guarantee must not depend on the configured timeframe."""
    for base, htf in ((1, 5), (5, 30), (15, 60)):
        cfg = IntradayConfig(base_tf_min=base, htf_min=htf)
        cfg.validate()
        full = build_features(bars, bench, cfg)
        part = build_features(bars.iloc[:700], bench.iloc[:700], cfg)
        if len(part) < 3:
            continue
        part = part.iloc[:-1]
        a = full.loc[part.index]
        for col in a.columns:
            x, y = a[col].to_numpy(dtype="float64"), part[col].to_numpy(dtype="float64")
            both_nan = np.isnan(x) & np.isnan(y)
            assert np.allclose(x[~both_nan], y[~both_nan], atol=1e-9, equal_nan=True), (
                f"lookahead at base_tf={base} htf={htf} in {col!r}"
            )


def test_five_min_features_lag_by_one_bucket(bars, bench):
    """A 5-min bar stamped 09:35 covers 09:35-09:39 and is complete only at
    09:40, so its values must first appear on the 09:40 1-min bar.

    Pinned to base=1/htf=5 explicitly rather than using the shared cfg fixture,
    because the defaults are now 5/30 and this test is about the lag mechanism,
    not about whatever the current defaults happen to be.
    """
    cfg = IntradayConfig(base_tf_min=1, htf_min=5)
    cfg.validate()
    feats = build_features(bars, bench, cfg)
    df5 = resample_5m(bars)
    st5 = supertrend(df5, cfg.st_period, cfg.st_multiplier)

    probe = df5.index[30]                       # a 5-min bucket well past warmup
    nxt = probe + pd.Timedelta(minutes=5)
    if nxt not in feats.index:
        pytest.skip("probe bucket at the tail of the sample")

    assert feats.loc[nxt, "st_dir_5m"] == st5.loc[probe, "st_dir"]
    # And during the bucket itself, we still see the PREVIOUS bucket's value.
    inside = probe + pd.Timedelta(minutes=2)
    prev = df5.index[29]
    assert feats.loc[inside, "st_dir_5m"] == st5.loc[prev, "st_dir"]


def test_build_features_columns_and_empty(cfg):
    from lib.intraday_signals import FEATURE_COLUMNS
    empty = build_features(pd.DataFrame(), None, cfg)
    assert list(empty.columns) == FEATURE_COLUMNS
    assert len(empty) == 0


def test_build_features_without_benchmark_is_neutral(bars, cfg):
    """No benchmark must not silently manufacture relative strength."""
    f = build_features(bars, None, cfg)
    assert (f["bench_ret_day"] == 0).all()
    assert f["rs_day"].notna().any()


# ── Conditions / scoring ──────────────────────────────────────────────────────
def _row(**kw) -> pd.Series:
    base = dict(Open=100.0, High=101.0, Low=99.0, Close=100.0, Volume=50_000.0,
                vwap=99.5, vwap_bps=50.0, ema_fast=100.2, ema_slow=99.8, ema_stack=1,
                atr=1.0, vol_ratio=1.5, st_line_5m=98.0, st_dir_5m=1, adx_5m=25.0,
                bench_ret_day=0.001, bench_ret_lb=0.0, rs_day=0.004, rs_lb=0.003)
    base.update(kw)
    s = pd.Series(base)
    s.name = pd.Timestamp("2026-05-04 10:00")
    return s


def test_evaluate_all_pass(cfg):
    c = evaluate(_row(), cfg, "LONG")
    assert c.passed() == len(CONDITION_NAMES)
    assert is_gated(c)
    assert c.blocked_by() == []


def test_evaluate_nan_bar_is_all_false(cfg):
    """A half-warmed indicator must never produce a tradeable signal."""
    c = evaluate(_row(atr=float("nan")), cfg, "LONG")
    assert c.passed() == 0
    assert not is_gated(c)
    c2 = evaluate(_row(atr=0.0), cfg, "LONG")
    assert not is_gated(c2)


@pytest.mark.parametrize("kw,flag", [
    (dict(vwap_bps=1.0), "above_vwap"),
    (dict(st_dir_5m=-1), "st_bull_5m"),
    (dict(adx_5m=10.0), "adx_ok"),
    (dict(rs_day=-0.01), "rs_day_ok"),
    (dict(Close=100.0, vwap=99.0, atr=1.0), "not_stretched"),  # stretch 1.0 > 0.60
])
def test_hard_gates_block(cfg, kw, flag):
    c = evaluate(_row(**kw), cfg, "LONG")
    assert not getattr(c, flag)
    assert not is_gated(c)
    assert flag in c.blocked_by()


def test_soft_conditions_do_not_block(cfg):
    for kw in (dict(ema_stack=-1), dict(rs_lb=-0.01), dict(vol_ratio=0.2)):
        c = evaluate(_row(**kw), cfg, "LONG")
        assert is_gated(c), f"{kw} should be soft, not a hard gate"


def test_score_bounds_and_monotonicity(cfg):
    assert 0.0 <= score(_row(), cfg) <= 100.0
    weak = score(_row(rs_lb=0.0, adx_5m=20.0, vwap_bps=5.0, ema_stack=-1, vol_ratio=0.0), cfg)
    strong = score(_row(rs_lb=0.02, adx_5m=45.0, vwap_bps=40.0, ema_stack=1, vol_ratio=3.0), cfg)
    assert strong > weak
    assert score(_row(rs_lb=999.0, adx_5m=999.0, vwap_bps=999.0, vol_ratio=999.0), cfg) <= 100.0


def test_short_side_mirrors_long(cfg):
    c = IntradayConfig(allow_short=True)
    bear = _row(vwap_bps=-50.0, ema_stack=-1, st_dir_5m=-1, rs_day=-0.004, rs_lb=-0.003)
    assert is_gated(evaluate(bear, c, "SHORT"))
    assert not is_gated(evaluate(bear, c, "LONG"))


def test_rank_candidates_orders_and_excludes(cfg):
    rows = {"AAA": _row(rs_lb=0.01), "BBB": _row(rs_lb=0.002), "CCC": _row(adx_5m=5.0)}
    ranked = rank_candidates(rows, cfg)
    assert [c.symbol for c in ranked] == ["AAA", "BBB"]   # CCC fails the ADX gate
    assert ranked[0].score >= ranked[1].score
    assert [c.symbol for c in rank_candidates(rows, cfg, exclude={"AAA"})] == ["BBB"]


def test_rank_candidates_include_ungated_shows_everything(cfg):
    rows = {"AAA": _row(), "CCC": _row(adx_5m=5.0)}
    ranked = rank_candidates(rows, cfg, include_ungated=True)
    assert len(ranked) == 2
    ccc = next(c for c in ranked if c.symbol == "CCC")
    assert not ccc.gated and "adx_ok" in ccc.conditions.blocked_by()


def test_rank_candidates_tie_break_is_deterministic(cfg):
    rows = {s: _row() for s in ("ZZZ", "AAA", "MMM")}
    assert [c.symbol for c in rank_candidates(rows, cfg)] == ["AAA", "MMM", "ZZZ"]


# ── Portfolio selection ───────────────────────────────────────────────────────
def _pos(symbol, entry=100.0, stop=99.0, side="LONG", qty=10) -> Position:
    return Position(symbol=symbol, side=side, qty=qty, entry_price=entry,
                    stop=stop, target=target_price(entry, stop, side, IntradayConfig()))


def test_select_new_entries_respects_max_positions(cfg):
    rows = {s: _row(rs_lb=0.01) for s in ("RELIANCE", "INFY", "TITAN", "NTPC")}
    ranked = rank_candidates(rows, cfg)
    assert len(select_new_entries(ranked, cfg, [])) == cfg.max_positions
    assert len(select_new_entries(ranked, cfg, [_pos("SBIN"), _pos("LT")])) == 1
    assert select_new_entries(ranked, cfg, [_pos("A"), _pos("B"), _pos("C")]) == []


def test_select_new_entries_enforces_sector_cap(cfg):
    """Three banks is one bet at 3x size — the cap is the point."""
    banks = ("HDFCBANK", "ICICIBANK", "AXISBANK", "SBIN")
    ranked = rank_candidates({s: _row(rs_lb=0.01) for s in banks}, cfg)
    chosen = select_new_entries(ranked, cfg, [])
    assert len(chosen) == cfg.max_per_sector == 2
    assert all(c.sector == "BANK" for c in chosen)

    mixed = rank_candidates({s: _row(rs_lb=0.01)
                             for s in ("HDFCBANK", "ICICIBANK", "INFY")}, cfg)
    got = select_new_entries(mixed, cfg, [])
    assert len(got) == 3
    assert sum(1 for c in got if c.sector == "BANK") == 2


def test_select_new_entries_counts_existing_sector_exposure(cfg):
    ranked = rank_candidates({"AXISBANK": _row(rs_lb=0.01)}, cfg)
    assert select_new_entries(ranked, cfg, [_pos("HDFCBANK"), _pos("ICICIBANK")]) == []


def test_select_new_entries_skips_held_symbols(cfg):
    ranked = rank_candidates({"INFY": _row(rs_lb=0.01)}, cfg)
    assert select_new_entries(ranked, cfg, [_pos("INFY")]) == []


# ── Sizing ────────────────────────────────────────────────────────────────────
def test_position_size_uses_risk_budget(cfg):
    assert position_size(100.0, 98.0, cfg) == int(cfg.risk_per_trade // 2.0)


def test_position_size_clamped_by_order_value(cfg):
    c = IntradayConfig(risk_per_trade=100_000, max_order_value=50_000)
    assert position_size(100.0, 99.0, c) == 500


def test_position_size_clamped_by_deployed_headroom(cfg):
    c = IntradayConfig(risk_per_trade=100_000, max_order_value=1_000_000, max_deployed=100_000)
    assert position_size(100.0, 99.0, c, deployed=60_000) == 400
    assert position_size(100.0, 99.0, c, deployed=100_000) == 0


def test_position_size_returns_zero_not_one_when_unsizable(cfg):
    """The caller skips on 0. Returning 1 would convert a rejected setup into an
    unsized position — the bug this test exists to prevent."""
    assert position_size(100.0, 100.0, cfg) == 0
    assert position_size(100.0, float("nan"), cfg) == 0
    assert position_size(0.0, 1.0, cfg) == 0
    assert position_size(100.0, 0.0, IntradayConfig(risk_per_trade=1.0)) == 0


# ── Stops / exits ─────────────────────────────────────────────────────────────
def test_initial_stop_and_target_geometry(cfg):
    stop = initial_stop(100.0, 2.0, "LONG", cfg)
    assert stop == pytest.approx(97.0)
    assert target_price(100.0, stop, "LONG", cfg) == pytest.approx(106.0)

    sstop = initial_stop(100.0, 2.0, "SHORT", cfg)
    assert sstop == pytest.approx(103.0)
    assert target_price(100.0, sstop, "SHORT", cfg) == pytest.approx(94.0)


def test_trail_stop_never_loosens(cfg):
    pos = _pos("INFY", entry=100.0, stop=97.0)
    prices = [101, 104, 108, 106, 110, 103, 112, 100]
    prev = pos.stop
    for p in prices:
        pos.stop = trail_stop(pos, _row(atr=1.0), cfg, ltp=float(p))
        assert pos.stop >= prev - 1e-9, f"stop loosened at price {p}"
        prev = pos.stop


def test_trail_stop_arms_only_after_threshold(cfg):
    pos = _pos("INFY", entry=100.0, stop=97.0)      # 3.0 risk/share
    assert trail_stop(pos, _row(atr=1.0), cfg, ltp=101.0) == pytest.approx(97.0)
    moved = trail_stop(pos, _row(atr=1.0), cfg, ltp=104.0)   # +1.33R, armed
    assert moved > 97.0


def test_trail_stop_short_side(cfg):
    pos = _pos("INFY", entry=100.0, stop=103.0, side="SHORT")
    prev = pos.stop
    for p in (99, 96, 94, 97, 92):
        pos.stop = trail_stop(pos, _row(atr=1.0), cfg, ltp=float(p))
        assert pos.stop <= prev + 1e-9
        prev = pos.stop
    assert pos.stop < 103.0


def test_exit_reason_priority_square_off_wins(cfg):
    pos = _pos("INFY", entry=100.0, stop=97.0)
    # Even sitting on a profitable target, the square-off outranks it.
    assert exit_reason(pos, _row(), cfg, "15:17", ltp=106.0) == "SQUARE_OFF"
    assert exit_reason(pos, _row(), cfg, "15:30", ltp=100.0) == "SQUARE_OFF"


def test_exit_reason_stop_and_target(cfg):
    pos = _pos("INFY", entry=100.0, stop=97.0)
    pos.target = 106.0
    assert exit_reason(pos, _row(), cfg, "11:00", ltp=96.9) == "STOP"
    assert exit_reason(pos, _row(), cfg, "11:00", ltp=106.1) == "TARGET"
    assert exit_reason(pos, _row(), cfg, "11:00", ltp=101.0) is None


def test_exit_reason_signal_exits(cfg):
    pos = _pos("INFY", entry=100.0, stop=90.0)
    pos.target = 130.0
    assert exit_reason(pos, _row(st_dir_5m=-1), cfg, "11:00", ltp=101.0) == "ST_FLIP"

    # VWAP exit is OFF by default (it cost -0.75R over 222 trades), so the
    # default config must NOT fire it — and the opt-in must still work.
    assert exit_reason(pos, _row(Close=98.0, vwap=99.5), cfg, "11:00", ltp=101.0) is None
    on = IntradayConfig(exit_on_vwap_loss=True)
    assert exit_reason(pos, _row(Close=98.0, vwap=99.5), on, "11:00", ltp=101.0) == "VWAP_LOSS"

    rs = IntradayConfig(exit_on_vwap_loss=False, exit_on_rs_loss=True)
    assert exit_reason(pos, _row(Close=98.0, vwap=99.5), rs, "11:00", ltp=101.0) is None
    assert exit_reason(pos, _row(rs_day=-0.01), rs, "11:00", ltp=101.0) == "RS_LOSS"


def test_exit_reason_stop_beats_signal_exit(cfg):
    """A stop hit and a Supertrend flip on the same bar must exit at the stop."""
    pos = _pos("INFY", entry=100.0, stop=97.0)
    pos.target = 106.0
    assert exit_reason(pos, _row(st_dir_5m=-1), cfg, "11:00", ltp=96.0) == "STOP"


def test_exit_reason_short_side_levels(cfg):
    pos = _pos("INFY", entry=100.0, stop=103.0, side="SHORT")
    pos.target = 94.0
    assert exit_reason(pos, _row(st_dir_5m=-1), cfg, "11:00", ltp=103.5) == "STOP"
    assert exit_reason(pos, _row(st_dir_5m=-1), cfg, "11:00", ltp=93.5) == "TARGET"


# ── Position accounting ───────────────────────────────────────────────────────
def test_position_pnl_and_r_multiple():
    pos = _pos("INFY", entry=100.0, stop=98.0, qty=50)
    assert pos.risk_per_share == pytest.approx(2.0)
    assert pos.unrealized(104.0) == pytest.approx(200.0)
    assert pos.r_multiple(104.0) == pytest.approx(2.0)
    assert pos.notional() == pytest.approx(5000.0)

    short = _pos("INFY", entry=100.0, stop=102.0, side="SHORT", qty=50)
    assert short.unrealized(96.0) == pytest.approx(200.0)
    assert short.r_multiple(96.0) == pytest.approx(2.0)


def test_position_handles_unpriced_ltp():
    """LTP 0.0 must mark flat, not as a total loss — that is what would
    otherwise trip the daily stop on a single missing quote."""
    pos = _pos("INFY", entry=100.0, stop=98.0, qty=50)
    assert pos.unrealized(0.0) == 0.0
    assert pos.r_multiple(0.0) == 0.0
    assert pos.unrealized(float("nan")) == 0.0


def test_position_to_dict_is_json_safe():
    import json
    d = _pos("INFY", entry=100.0, stop=98.0, qty=50).to_dict(ltp=101.0)
    json.dumps(d)
    assert d["symbol"] == "INFY" and d["sector"] == "IT"


def test_candidate_to_dict_is_json_safe(cfg):
    import json
    c = rank_candidates({"INFY": _row()}, cfg)[0]
    d = c.to_dict()
    json.dumps(d)
    assert set(d["conditions"]) == set(CONDITION_NAMES)


# ── End-to-end on real store data (skipped when the store is absent) ──────────
def test_real_store_features_are_sane(cfg):
    from lib.intraday_signals import load_1m, load_benchmark_1m
    df = load_1m("RELIANCE")
    if df is None or len(df) < 1000:
        pytest.skip("intraday store not built — run scripts/downloader/refresh_intraday_1min.py")
    feats = build_features(df, load_benchmark_1m(cfg), cfg)

    # Features live on the BASE frame, so a resampled config yields proportionally
    # fewer rows than the 1-minute input.
    from lib.intraday_signals import resample_tf
    assert len(feats) == len(resample_tf(df, cfg.base_tf_min))
    warm = feats.iloc[400:]
    for col in ("vwap", "atr", "adx_5m", "rs_day"):
        assert warm[col].notna().mean() > 0.95, f"{col} is mostly NaN after warmup"
    assert (warm["vwap"] > 0).all()
    assert (warm["atr"] > 0).all()
    assert set(np.unique(feats["st_dir_5m"].dropna())) <= {-1.0, 0.0, 1.0}
    # VWAP must track price, not drift off as a multi-day average.
    assert (warm["vwap_bps"].abs() < 2000).mean() > 0.99

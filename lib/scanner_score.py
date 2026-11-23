"""
Relative Strength Scanner score — Python port of rs_dashboard/lib/scannerMath.ts (the /scanner page).

The Scanner Top-N momentum model (scripts/analysis/simulate_momentum_replay.py --strategy scanner_top, and
strategies/momentum_investing/nifty500_momentum.py --model scanner_top) trades the scanner's OWN ranking, so this
file must reproduce it exactly: tests/test_scanner_score_parity.py checks it against lib/scannerMath.parity.json,
which the TypeScript test regenerates. Change a formula only together with scannerMath.ts.

Per stock, as of each of its rows (exactly what computeScanner() sees when that row is the latest):
  score (0-15) = 1 close>EMA20 + 1 close>EMA50 + 2 close>EMA200 + 2 Supertrend(7,3) up + 1 RSI14>60
               + 2 MACD(12,26,9) line>signal + 1 ADX14>25 + 1 volume/20d-avg>1.5
               + 2 RS rising over 20 bars + 2 RS above its 21-bar mean
  RS = (stock/stock[L]) / (index/index[L]) - 1 on dates shared with the index, L = min(252, bars-1).
Universe ranking on a date: every stock with >= 60 rows by then, using its latest row on or before that date;
order = score desc, RS percentile (rounded 0-100) desc, volume ratio desc.

Inputs mirror rs_dashboard/lib/dataLoader.ts: weekend rows and holiday placeholders (flat OHLC with zero volume) are
dropped, corporate actions are applied (lib/corporate_actions.py), a missing volume is 0, and duplicate dates are
not merged. The scanner's live-quote patch of today's row is not reproduced; the live bot runs after
fetch_today_quotes.py has written today's row into the CSVs.
"""

from __future__ import annotations

import bisect
import math
import os
from datetime import date
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

from lib.corporate_actions import adjust_frame

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
STOCK_DIR = os.path.join(ROOT, "Daily_Historical_Data_Fresh")
NIFTY500_INDEX_CSV = os.path.join(ROOT, "Historical Data", "NIFTY_500_Daily.csv")

DEFAULT_PARAMS = dict(rsiPeriod=14, emaPeriod1=20, emaPeriod2=50, emaPeriod3=200, macdFast=12, macdSlow=26,
                      macdSignal=9, stPeriod=7, stMultiplier=3.0, adxPeriod=14, volMaPeriod=20)
MIN_ROWS = 60          # computeScanner returns null below this
RS_LOOKBACK = 252
RSI_WINDOW = 60        # max(60, rsiPeriod * 3)
MAX_SCORE = 15

# Scanner Top-N momentum model defaults (live bot --model scanner_top and the replay's scanner_top): the tune-window
# winner of scripts/analysis/optimise_scanner_top.py (32 configs, 2020-01..2023-12, ranked by Calmar). It did NOT
# hold up on the held-out 2024-01..2026-11 window: -4.0% CAGR, -26.7% max DD, PF 0.90, against +6.3% / -21.0% for
# turtle_rs. Paper-trade only; see strategies/momentum_investing/strategy.md, "Model: Scanner Top-N".
# sell_mult: rotation sells a holding ranked below sell_mult x N for two consecutive weekly reviews.
SCANNER_TOP_DEFAULTS = dict(n=15, sell_mult=3, stop_pct=20.0, sector_cap=2)


# ── loaders (mirror dataLoader.ts) ────────────────────────────────────────────

def _read_csv_rows(path: str) -> Optional[pd.DataFrame]:
    try:
        raw = pd.read_csv(path, dtype=str, keep_default_na=False, on_bad_lines="skip", engine="python")
    except (OSError, ValueError):
        return None
    cols = {c.strip(): c for c in raw.columns}
    dcol = next((cols[c] for c in ("Datetime", "Date", "date", "datetime") if c in cols), None)
    if dcol is None or "Close" not in cols:
        return None

    def num(col: str) -> pd.Series:
        if col not in cols:
            return pd.Series(0.0, index=raw.index)
        return pd.to_numeric(raw[cols[col]].str.strip(), errors="coerce")

    df = pd.DataFrame({"date": raw[dcol].str.strip().str.slice(0, 10), "close": num("Close")})
    for c in ("Open", "High", "Low", "Volume"):
        df[c.lower()] = num(c).fillna(0.0)            # parseFloat(x) || 0
    df = df[(df["date"].str.len() == 10) & df["close"].notna()]
    wd = pd.to_datetime(df["date"], errors="coerce").dt.weekday
    df = df[wd.notna() & (wd < 5)]
    return df[["date", "open", "high", "low", "close", "volume"]]


def load_scanner_rows(symbol: str, stock_dir: str = STOCK_DIR) -> Optional[pd.DataFrame]:
    """A stock's rows exactly as the scanner reads them (raw CSV → weekend/placeholder filter → sort → adjust)."""
    df = _read_csv_rows(os.path.join(stock_dir, f"{symbol}_Daily_2Y.csv"))
    if df is None or df.empty:
        return None
    placeholder = (df["volume"] == 0) & (df["open"] == df["high"]) & (df["high"] == df["low"]) & (df["low"] == df["close"])
    df = df[~placeholder].sort_values("date", kind="stable").reset_index(drop=True)
    return adjust_frame(symbol, df).reset_index(drop=True)


def load_scanner_bench(path: str = NIFTY500_INDEX_CSV) -> pd.DataFrame:
    df = _read_csv_rows(path)
    if df is None or df.empty:
        raise FileNotFoundError(f"Nifty 500 index CSV missing or unreadable: {path}")
    return df.sort_values("date", kind="stable").reset_index(drop=True)


# ── per-stock indicator series ────────────────────────────────────────────────

def _ema(values: np.ndarray, period: int) -> np.ndarray:
    return pd.Series(values, dtype=float).ewm(span=period, adjust=False).mean().to_numpy()


def _rsi_series(closes: np.ndarray, period: int) -> np.ndarray:
    """wilderRSI(closes.slice(-60)) as of every row with >= 60 rows (NaN before)."""
    n = len(closes)
    out = np.full(n, np.nan)
    if n < RSI_WINDOW:
        return out
    diffs = sliding_window_view(np.diff(closes), RSI_WINDOW - 1)        # row i uses diffs of closes[i-59..i]
    gains, losses = np.maximum(diffs, 0.0), np.maximum(-diffs, 0.0)
    ag, al = gains[:, :period].mean(axis=1), losses[:, :period].mean(axis=1)
    for k in range(period, RSI_WINDOW - 1):
        ag = (ag * (period - 1) + gains[:, k]) / period
        al = (al * (period - 1) + losses[:, k]) / period
    with np.errstate(divide="ignore", invalid="ignore"):
        rsi = np.where(al == 0, 100.0, 100.0 - 100.0 / (1.0 + ag / al))
    out[RSI_WINDOW - 1:] = rsi
    return out


def _adx_series(h: np.ndarray, l: np.ndarray, c: np.ndarray, period: int) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """computeADX(rows[0..i]) for every i: (adx, plusDI, minusDI). Mirrors the zero/25 fallbacks."""
    n = len(c)
    adx, pdi, mdi = np.zeros(n), np.full(n, 25.0), np.full(n, 25.0)
    if n < 2:
        return adx, pdi, mdi
    tr = np.maximum.reduce([h[1:] - l[1:], np.abs(h[1:] - c[:-1]), np.abs(l[1:] - c[:-1])])
    up, dn = h[1:] - h[:-1], l[:-1] - l[1:]
    pdm = np.where((up > dn) & (up > 0), up, 0.0)
    mdm = np.where((dn > up) & (dn > 0), dn, 0.0)
    m = len(tr)                                              # trs for rows[0..i] has length i
    if m <= period:
        return adx, pdi, mdi
    st, sp, sm = tr[:period].sum(), pdm[:period].sum(), mdm[:period].sum()
    di_p, di_m, dx = np.zeros(m), np.zeros(m), np.zeros(m)
    for k in range(period, m):
        st = st - st / period + tr[k]
        sp = sp - sp / period + pdm[k]
        sm = sm - sm / period + mdm[k]
        a = sp / st * 100.0 if st > 0 else 0.0
        b = sm / st * 100.0 if st > 0 else 0.0
        di_p[k], di_m[k] = a, b
        dx[k] = abs(a - b) / (a + b) * 100.0 if a + b > 0 else 0.0
    adx_run = np.zeros(m + 1)                               # adx_run[c] = ADX after c DX values
    for cnt in range(period, m - period + 1):
        if cnt == period:
            adx_run[cnt] = dx[period:2 * period].mean()
        else:
            adx_run[cnt] = (adx_run[cnt - 1] * (period - 1) + dx[period + cnt - 1]) / period
    for i in range(n):
        if i + 1 < period * 2 + 2:
            continue                                         # zero = { adx: 0, plusDI: 25, minusDI: 25 }
        cnt = i - period                                     # DX values available when rows[0..i]
        pdi[i], mdi[i] = di_p[i - 1], di_m[i - 1]
        adx[i] = adx_run[cnt] if cnt >= period else 0.0
    return adx, pdi, mdi


def _supertrend_series(h: np.ndarray, l: np.ndarray, c: np.ndarray, period: int, mult: float) -> np.ndarray:
    """computeSupertrend(rows[0..i]) for every i (the scanner's own band/trend logic, not lib/intraday_signals)."""
    n = len(c)
    bull = np.zeros(n, dtype=bool)
    if n < period + 1:
        return bull
    tr = np.maximum.reduce([h[1:] - l[1:], np.abs(h[1:] - c[:-1]), np.abs(l[1:] - c[:-1])])
    atr = tr[:period].sum() / period
    upper = lower = 0.0
    trend = 1
    for ri in range(period, n):
        if ri > period:
            atr = (atr * (period - 1) + tr[ri - 1]) / period
        hl2 = (h[ri] + l[ri]) / 2.0
        bu, bl = hl2 + mult * atr, hl2 - mult * atr
        if ri == period:
            upper, lower = bu, bl
        else:
            pc = c[ri - 1]
            upper = bu if (bu < upper or pc > upper) else upper
            lower = bl if (bl > lower or pc < lower) else lower
        if c[ri] > upper:
            trend = 1
        elif c[ri] < lower:
            trend = -1
        bull[ri] = trend == 1
    return bull


def _rs_series(rows: pd.DataFrame, bench: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """computeRS(rows[0..i], index) for every i: (rsRatio, rsRising20, rsAboveMA)."""
    n = len(rows)
    ratio, rising, above = np.zeros(n), np.zeros(n, dtype=bool), np.zeros(n, dtype=bool)
    imap: Dict[str, float] = {}
    for d_, c_ in zip(bench["date"], bench["close"]):
        imap[d_] = float(c_)                                 # Map.set: a duplicate date keeps the last
    dates = rows["date"].tolist()
    in_idx = np.array([d_ in imap for d_ in dates])
    s = rows["close"].to_numpy(dtype=float)[in_idx]
    b = np.array([imap[d_] for d_, k in zip(dates, in_idx) if k], dtype=float)
    aligned_upto = np.cumsum(in_idx)                         # aligned rows available as of row i
    m = len(s)
    a_ratio, a_rise, a_above = np.zeros(m), np.zeros(m, dtype=bool), np.zeros(m, dtype=bool)

    def window(j: int) -> None:
        cnt = j + 1
        if cnt < 21:
            return
        eff = min(RS_LOOKBACK, cnt - 1)
        if eff < 20:
            return
        vals = []
        for k in range(max(eff, cnt - 21), cnt):
            bs, bb = s[k - eff], b[k - eff]
            if bs == 0 or bb == 0:
                continue
            vals.append((s[k] / bs) / (b[k] / bb) - 1.0)
        if not vals:
            return
        a_ratio[j] = vals[-1]
        a_rise[j] = len(vals) >= 2 and vals[-1] > vals[0]
        a_above[j] = vals[-1] > sum(vals) / len(vals)

    fast_from = RS_LOOKBACK + 20                             # eff = 252 and start = cnt - 21 from here on
    for j in range(min(m, fast_from)):
        window(j)
    if m > fast_from:
        with np.errstate(divide="ignore", invalid="ignore"):
            r = (s[RS_LOOKBACK:] / s[:-RS_LOOKBACK]) / (b[RS_LOOKBACK:] / b[:-RS_LOOKBACK]) - 1.0   # r[k-252]
        zero_base = (s[:-RS_LOOKBACK] == 0) | (b[:-RS_LOOKBACK] == 0)
        if zero_base.any():
            for j in range(fast_from, m):
                window(j)
        else:
            win = sliding_window_view(r, 21)                 # win[t] = r for k in t+252 .. t+272
            js = np.arange(fast_from, m)
            w = win[js - fast_from]
            a_ratio[js] = w[:, -1]
            a_rise[js] = w[:, -1] > w[:, 0]
            a_above[js] = w[:, -1] > w.sum(axis=1) / 21.0
    for i in range(n):
        j = aligned_upto[i] - 1
        if j >= 0:
            ratio[i], rising[i], above[i] = a_ratio[j], a_rise[j], a_above[j]
    return ratio, rising, above


def compute_symbol(rows: pd.DataFrame, bench: pd.DataFrame, params: Optional[dict] = None) -> pd.DataFrame:
    """Scanner fields for every row of one stock, as of that row. Rows with < 60 bars have ok=False."""
    p = dict(DEFAULT_PARAMS, **(params or {}))
    c = rows["close"].to_numpy(dtype=float)
    h, l = rows["high"].to_numpy(dtype=float), rows["low"].to_numpy(dtype=float)
    v = rows["volume"].to_numpy(dtype=float)
    n = len(c)
    bars = np.arange(1, n + 1)

    ema1, ema2, ema3 = _ema(c, p["emaPeriod1"]), _ema(c, p["emaPeriod2"]), _ema(c, p["emaPeriod3"])
    ema3 = np.where(bars >= p["emaPeriod3"], ema3, 0.0)
    macd = _ema(c, p["macdFast"]) - _ema(c, p["macdSlow"])
    sig = _ema(macd, p["macdSignal"])
    rsi = _rsi_series(c, p["rsiPeriod"])
    adx, pdi, mdi = _adx_series(h, l, c, p["adxPeriod"])
    st = _supertrend_series(h, l, c, p["stPeriod"], p["stMultiplier"])
    vol_avg = pd.Series(v).rolling(p["volMaPeriod"], min_periods=1).mean().to_numpy()
    vr = np.where(vol_avg > 0, v / np.where(vol_avg > 0, vol_avg, 1.0), 0.0)
    rs, rs_up, rs_ma = _rs_series(rows, bench)

    above20 = (ema1 > 0) & (c > ema1)
    above50 = (ema2 > 0) & (c > ema2)
    above200 = (ema3 > 0) & (c > ema3)
    macd_bull = macd > sig
    score = (above20 * 1 + above50 * 1 + above200 * 2 + st * 2 + (rsi > 60) * 1 + macd_bull * 2
             + (adx > 25) * 1 + (vr > 1.5) * 1 + rs_up * 2 + rs_ma * 2)
    return pd.DataFrame({
        "date": rows["date"].to_numpy(), "close": c, "ok": bars >= MIN_ROWS,
        "ema20": ema1, "ema50": ema2, "ema200": ema3, "rsi14": rsi, "macdLine": macd, "macdSignal": sig,
        "adx14": adx, "plusDI": pdi, "minusDI": mdi, "supertrendBullish": st, "volumeRatio": vr,
        "rsRatio": rs, "rsRising20": rs_up, "rsAboveMA": rs_ma, "score": score.astype(int),
    })


# ── universe ranking ──────────────────────────────────────────────────────────

def _js_round(x: float) -> int:
    return int(math.floor(x + 0.5))                          # Math.round (half up), not Python's banker's round


def rank_snapshot(latest: Dict[str, Tuple[int, float, float]]) -> List[Tuple[str, int, int, float, float]]:
    """{symbol: (score, rsRatio, volumeRatio)} → [(symbol, score, rsScore, rsRatio, volumeRatio)] in scanner order.

    Ties at every key keep the input order (the scanner's own tie order depends on file-read completion order)."""
    syms = list(latest)
    n = len(syms)
    by_rs = sorted(syms, key=lambda s: latest[s][1])
    rs_score = {s: (50 if n <= 1 else _js_round(i / (n - 1) * 100)) for i, s in enumerate(by_rs)}
    order = sorted(syms, key=lambda s: (-latest[s][0], -rs_score[s], -latest[s][2]))
    return [(s, latest[s][0], rs_score[s], latest[s][1], latest[s][2]) for s in order]


class ScannerBook:
    """Every stock's scanner fields, indexable by date for the replay and the live bot."""

    def __init__(self, fields: Dict[str, pd.DataFrame]):
        self.fields = fields                                      # symbol -> compute_symbol() output
        self._syms = list(fields)
        self._dates = {s: list(f["date"]) for s, f in fields.items()}
        self._arr = {s: (f["ok"].to_numpy(), f["score"].to_numpy(), f["rsRatio"].to_numpy(),
                         f["volumeRatio"].to_numpy()) for s, f in fields.items()}
        self._rank_cache: Dict[str, list] = {}

    def latest(self, d) -> Dict[str, Tuple[int, float, float]]:
        """{symbol: (score, rsRatio, volumeRatio)} from each stock's latest row on or before `d` (>= 60 rows)."""
        key = d if isinstance(d, str) else d.isoformat()
        out: Dict[str, Tuple[int, float, float]] = {}
        for sym in self._syms:
            i = bisect.bisect_right(self._dates[sym], key) - 1
            if i < 0:
                continue
            ok, sc, rs, vr = self._arr[sym]
            if ok[i]:
                out[sym] = (int(sc[i]), float(rs[i]), float(vr[i]))
        return out

    def ranked_rows(self, d) -> List[Tuple[str, int, int, float, float]]:
        """[(symbol, score, rsScore, rsRatio, volumeRatio)] in the scanner's order as of `d` (cached per date)."""
        key = d if isinstance(d, str) else d.isoformat()
        if key not in self._rank_cache:
            self._rank_cache[key] = rank_snapshot(self.latest(key))
        return self._rank_cache[key]

    def ranking(self, d, mode: str = "scanner") -> List[Tuple[str, float]]:
        """[(symbol, score)] as of `d` — the shape the momentum engine ranks with.

        mode "scanner": the /scanner page's own order (score, RS percentile, volume ratio).
        mode "score_rs": only names with a positive 252-day RS ratio, ordered by score then RS ratio — a research
        variant (scanner_rs) that drops 1-year laggards and the one-day volume tie-break."""
        rows = self.ranked_rows(d)
        if mode == "score_rs":
            rows = sorted((r for r in rows if r[3] > 0), key=lambda r: (-r[1], -r[3]))
        return [(s, float(sc)) for s, sc, _rs, _r, _v in rows]


def build_book(rows_by_symbol: Dict[str, pd.DataFrame], bench: pd.DataFrame,
               params: Optional[dict] = None) -> ScannerBook:
    return ScannerBook({sym: compute_symbol(rows, bench, params)
                        for sym, rows in rows_by_symbol.items() if rows is not None and len(rows)})


def load_book(symbols: Sequence[str], params: Optional[dict] = None) -> Tuple[ScannerBook, Dict[str, pd.DataFrame]]:
    """Load the scanner's inputs for `symbols` (adjusted) and build the book. Also returns the adjusted rows."""
    bench = load_scanner_bench()
    rows = {s: r for s in symbols if (r := load_scanner_rows(s)) is not None and len(r)}
    return build_book(rows, bench, params), rows


def engine_frame(rows: pd.DataFrame) -> pd.DataFrame:
    """Scanner rows → the momentum engine's price frame (date objects, volume 0 → NaN as lib.momentum does).
    Duplicate dates keep the last row, matching lib.momentum._read_ohlcv."""
    df = rows.copy()
    df["date"] = pd.to_datetime(df["date"]).dt.date
    df = df.drop_duplicates(subset=["date"], keep="last").reset_index(drop=True)
    df.loc[df["volume"] <= 0, "volume"] = np.nan
    return df[["date", "open", "high", "low", "close", "volume"]]


def as_date(s: str) -> date:
    return date.fromisoformat(s[:10])

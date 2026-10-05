"""Options pricing library — the ONE place option maths lives on the Python side.

A line-for-line port of ``rs_dashboard/lib/optionsPricing.ts``. Strategies, scanners, trackers and backtests import from here
instead of carrying their own Black-Scholes, normal CDF, IV solver, expiry clock or rate, so a number can only be wrong in one place
and the dashboard and the strategies price off the same maths.

    model    Black-76 on a futures/forward price (``is_futures=True``) or Black-Scholes on spot (``is_futures=False``).
    units    delta per unit; gamma per index point; theta rupees per calendar day; vega rupees per 1% IV; rho per 1% rate;
             vanna = d(delta) per 1% IV; vomma = d(vega) per 1% IV; charm = d(delta) per calendar day. IV is a FRACTION (0.14).
    clock    time to 15:40 IST on the expiry date, /365 calendar days, floored at 0.25 day.
    rate     RISK_FREE_RATE = 6.5%.

Parity is enforced, not hoped for: ``rs_dashboard/lib/optionsPricing.parity.json`` holds cases generated from the TypeScript library;
``tests/test_options_pricing_parity.py`` (Python) and ``lib/optionsPricing.test.ts`` (TypeScript) both check against it. Change a
formula in one language and the other's test fails until they agree again.

The normal CDF is Hart's double-precision rational approximation (|error| < 3e-16) in BOTH languages, so they agree to ~1e-15 and
norm_cdf(0) is exactly 0.5.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Union

RISK_FREE_RATE = 0.065
CALENDAR_DAYS_PER_YEAR = 365
# F&O close is 15:40 IST = 10:10 UTC.
FNO_CLOSE_UTC = (10, 10)

Number = Union[int, float]


def normalize_option_type(opt: str) -> str:
    """'ce'/'CALL'/'c' -> 'CE', 'pe'/'PUT'/'p' -> 'PE'. Anything else raises: a typo must never silently price as a put."""
    o = str(opt).strip().upper()
    if o in ("CE", "CALL", "C"):
        return "CE"
    if o in ("PE", "PUT", "P"):
        return "PE"
    raise ValueError(f"unknown option type {opt!r} (expected CE or PE)")


# ── Normal distribution ──────────────────────────────────────────────────────

def norm_cdf(x: float) -> float:
    """Standard normal CDF to double precision (|error| < 3e-16 vs erfc; exactly 0.5 at 0): Hart's rational approximation, the same
    algorithm as ``normCdf`` in optionsPricing.ts, so the two languages agree to ~1e-15."""
    ax = abs(x)
    if ax > 37.0:
        cum = 0.0
    else:
        e = math.exp(-ax * ax / 2.0)
        if ax < 7.07106781186547:
            b = 3.52624965998911e-02 * ax + 0.700383064443688
            b = b * ax + 6.37396220353165
            b = b * ax + 33.912866078383
            b = b * ax + 112.079291497871
            b = b * ax + 221.213596169931
            b = b * ax + 220.206867912376
            cum = e * b
            b = 8.83883476483184e-02 * ax + 1.75566716318264
            b = b * ax + 16.064177579207
            b = b * ax + 86.7807322029461
            b = b * ax + 296.564248779674
            b = b * ax + 637.333633378831
            b = b * ax + 793.826512519948
            b = b * ax + 440.413735824752
            cum = cum / b
        else:
            b = ax + 0.65
            b = ax + 4.0 / b
            b = ax + 3.0 / b
            b = ax + 2.0 / b
            b = ax + 1.0 / b
            cum = e / b / 2.506628274631
    return 1.0 - cum if x > 0 else cum


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


# ── Expiry clock ─────────────────────────────────────────────────────────────

def expiry_epoch_ms(expiry: str) -> float:
    """Epoch ms of the F&O close on an expiry date ('YYYY-MM-DD')."""
    y, m, d = (int(p) for p in expiry.split("-"))
    return datetime(y, m, d, FNO_CLOSE_UTC[0], FNO_CLOSE_UTC[1], tzinfo=timezone.utc).timestamp() * 1000.0


def _now_ms(now: Optional[Number]) -> float:
    return datetime.now(timezone.utc).timestamp() * 1000.0 if now is None else float(now)


def time_to_expiry_years(expiry: str, now: Optional[Number] = None) -> float:
    """Remaining time in years (calendar/365), intraday precision, floored at 0.25 day. ``now`` is epoch ms (injectable for tests)."""
    if not expiry:
        return 2.0 / CALENDAR_DAYS_PER_YEAR
    try:
        diff_ms = expiry_epoch_ms(expiry) - _now_ms(now)
    except (ValueError, TypeError):
        return 2.0 / CALENDAR_DAYS_PER_YEAR
    floor = 0.25 / CALENDAR_DAYS_PER_YEAR
    if diff_ms <= 0:
        return floor
    return max(floor, diff_ms / (CALENDAR_DAYS_PER_YEAR * 24 * 3600 * 1000))


def years_from_days(days: float, min_days: float = 0.25) -> float:
    """Years for a caller that only has calendar days to expiry (backtests). Same floor and 365 base as the live clock."""
    return max(float(days), min_days) / CALENDAR_DAYS_PER_YEAR


def roll_forward(F: float, from_expiry: str, to_expiry: str, r: float = RISK_FREE_RATE, now: Optional[Number] = None) -> float:
    """Forward for ``to_expiry`` implied by a futures price on ``from_expiry`` (same cost of carry)."""
    return F * math.exp(-r * (time_to_expiry_years(from_expiry, now) - time_to_expiry_years(to_expiry, now)))


def spot_from_futures(F: float, futures_expiry: str, r: float = RISK_FREE_RATE, now: Optional[Number] = None) -> float:
    return F * math.exp(-r * time_to_expiry_years(futures_expiry, now))


# ── Pricing core ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class BsGreeks:
    price: float
    delta: float
    gamma: float
    theta: float
    vega: float
    rho: float
    vanna: float
    vomma: float
    charm: float


def _delta_core(opt: str, F: float, K: float, t: float, v: float, r: float, is_futures: bool) -> float:
    d1 = (math.log(F / K) + (0.0 if is_futures else r * t) + 0.5 * v * v * t) / (v * math.sqrt(t))
    carry = math.exp(-r * t) if is_futures else 1.0
    if opt == "CE":
        return carry * norm_cdf(d1)
    return -carry * norm_cdf(-d1) if is_futures else norm_cdf(d1) - 1.0


def _black_core(opt: str, F: float, K: float, t: float, v: float, r: float, is_futures: bool) -> BsGreeks:
    sqrt_t = math.sqrt(t)
    drift = 0.0 if is_futures else r * t
    d1 = (math.log(F / K) + drift + 0.5 * v * v * t) / (v * sqrt_t)
    d2 = d1 - v * sqrt_t
    discount = math.exp(-r * t)
    carry = discount if is_futures else 1.0
    pdf = norm_pdf(d1)

    if is_futures:
        if opt == "CE":
            price = discount * (F * norm_cdf(d1) - K * norm_cdf(d2))
            delta = discount * norm_cdf(d1)
        else:
            price = discount * (K * norm_cdf(-d2) - F * norm_cdf(-d1))
            delta = -discount * norm_cdf(-d1)
        rho = (-t * price) / 100.0
    elif opt == "CE":
        price = F * norm_cdf(d1) - K * discount * norm_cdf(d2)
        delta = norm_cdf(d1)
        rho = (K * t * discount * norm_cdf(d2)) / 100.0
    else:
        price = K * discount * norm_cdf(-d2) - F * norm_cdf(-d1)
        delta = norm_cdf(d1) - 1.0
        rho = (-K * t * discount * norm_cdf(-d2)) / 100.0

    gamma = (carry * pdf) / (F * v * sqrt_t)
    raw_vega = F * carry * sqrt_t * pdf
    vega = raw_vega * 0.01
    vanna = (-carry * pdf * d2) / v / 100.0
    vomma = (raw_vega * d1 * d2) / v / 10000.0

    term1 = -(F * carry * pdf * v) / (2.0 * sqrt_t)
    if is_futures:
        raw_theta = term1 + r * price
    elif opt == "CE":
        raw_theta = term1 - r * K * discount * norm_cdf(d2)
    else:
        raw_theta = term1 + r * K * discount * norm_cdf(-d2)

    charm = _delta_core(opt, F, K, max(t - 1.0 / CALENDAR_DAYS_PER_YEAR, 1e-6), v, r, is_futures) - delta
    return BsGreeks(price, delta, gamma, raw_theta / CALENDAR_DAYS_PER_YEAR, vega, rho, vanna, vomma, charm)


def compute_bs_greeks_exact(
    opt: str, underlying: float, strike: float, time_years: float, iv: float,
    r: float = RISK_FREE_RATE, is_futures: bool = False,
) -> BsGreeks:
    """Unrounded price + Greeks. Inputs are clamped for numerical safety (t >= 0.0001 years, iv >= 1%).
    A non-positive underlying or strike has no price: all zeros (never NaN, never an exception inside a trading loop)."""
    opt = normalize_option_type(opt)
    if not (underlying > 0) or not (strike > 0):
        return BsGreeks(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    return _black_core(opt, underlying, strike, max(time_years, 0.0001), max(iv, 0.01), r, is_futures)


def greeks_from_days(
    opt: str, spot: float, strike: float, dte_days: float, iv: float,
    r: float = RISK_FREE_RATE, min_days: float = 0.25, is_futures: bool = False,
) -> BsGreeks:
    """Greeks for a caller that holds calendar DAYS to expiry rather than an expiry date (strategies' sizing maths, backtests).
    Same 365-day year and 0.25-day floor as the live clock; spot Black-Scholes unless ``is_futures``."""
    return compute_bs_greeks_exact(opt, spot, strike, years_from_days(dte_days, min_days), iv, r, is_futures)


def price_option(
    opt: str, U: float, K: float, t: float, iv: float, r: float = RISK_FREE_RATE, is_futures: bool = False,
) -> float:
    """Unrounded, unclamped price; intrinsic when t <= 0, iv <= 0 or the underlying/strike is non-positive."""
    opt = normalize_option_type(opt)
    if not (t > 0) or not (iv > 0) or not (U > 0) or not (K > 0):
        return max(U - K, 0.0) if opt == "CE" else max(K - U, 0.0)
    return _black_core(opt, U, K, t, iv, r, is_futures).price


def risk_neutral_prob_above(S: float, K: float, t: float, iv: float, r: float = RISK_FREE_RATE) -> float:
    """Risk-neutral P(S_T > K) under lognormal GBM."""
    if t <= 0 or iv <= 0 or not (S > 0) or not (K > 0):
        return 1.0 if S > K else 0.0
    d2 = (math.log(S / K) + (r - (iv * iv) / 2.0) * t) / (iv * math.sqrt(t))
    return norm_cdf(d2)


# ── Implied volatility ───────────────────────────────────────────────────────

def implied_vol(
    opt: str, U: float, K: float, t: float, price: float, r: float = RISK_FREE_RATE, is_futures: bool = False,
) -> Optional[float]:
    """Invert the model for sigma by bisection. None when no solution exists (price at/below the no-arbitrage floor, or beyond 500% vol)."""
    opt = normalize_option_type(opt)
    if not (t > 0) or not (price > 0) or not (U > 0) or not (K > 0):
        return None
    df = math.exp(-r * t)
    if is_futures:
        floor = df * (max(U - K, 0.0) if opt == "CE" else max(K - U, 0.0))
    else:
        floor = max(U - K * df, 0.0) if opt == "CE" else max(K * df - U, 0.0)
    if price <= floor + 1e-8:
        return None
    lo, hi = 1e-4, 5.0
    if price_option(opt, U, K, t, hi, r, is_futures) < price:
        return None
    for _ in range(100):
        mid = (lo + hi) / 2.0
        if price_option(opt, U, K, t, mid, r, is_futures) < price:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-7:
            break
    return (lo + hi) / 2.0


# ── Per-leg recipe ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class LegGreeks:
    greeks: BsGreeks
    iv: float
    iv_source: str       # 'mark' | 'chain' | 'assumed'
    forward: float
    time_years: float

    @property
    def delta(self) -> float:
        return self.greeks.delta


def greeks_for_leg(
    opt: str, strike: float, expiry: str, spot: float,
    mark: Optional[float] = None, chain_iv: Optional[float] = None, fallback_iv: Optional[float] = None,
    future_price: Optional[float] = None, future_expiry: Optional[str] = None,
    r: float = RISK_FREE_RATE, now: Optional[Number] = None,
) -> Optional[LegGreeks]:
    """THE per-leg Greeks recipe (mirror of ``greeksForLeg`` in optionsPricing.ts): Black-76 against the forward for THIS leg's
    expiry (the monthly future rolled to it; spot*e^{rT} with no future), IV solved from the live mark (chain IV, then ``fallback_iv``,
    only when that fails). None when no forward or no IV can be found."""
    opt = normalize_option_type(opt)
    T = time_to_expiry_years(expiry, now)
    has_future = future_price is not None and future_price > 0 and bool(future_expiry)
    if has_future:
        forward = roll_forward(future_price, future_expiry, expiry, r, now)
    else:
        forward = spot * math.exp(r * T) if spot and spot > 0 else 0.0
    if not (forward > 0):
        return None
    solved = implied_vol(opt, forward, strike, T, mark, r, True) if mark and mark > 0 else None
    if solved:
        iv, src = solved, "mark"
    elif chain_iv and chain_iv > 0:
        iv, src = chain_iv, "chain"
    elif fallback_iv and fallback_iv > 0:
        iv, src = fallback_iv, "assumed"
    else:
        return None
    return LegGreeks(compute_bs_greeks_exact(opt, forward, strike, T, iv, r, True), iv, src, forward, T)


# ── Vectorised implied volatility (numpy) ────────────────────────────────────

def implied_vols(price, U, K, T, is_call, is_futures, r: float = RISK_FREE_RATE):
    """Implied vols (FRACTIONS) for many contracts at once; NaN where the premium sits outside the no-arbitrage bounds.

    The same model as ``implied_vol`` (Black-76 where ``is_futures`` is True, else Black-Scholes on spot) solved by a fixed 48-step
    bisection over numpy arrays, for scanners that invert thousands of contracts per minute. Black-76 on F equals Black-Scholes on
    S = F*e^{-rT} with the same strike and rate, which is how both branches share one expression here.
    tests/test_options_pricing_parity.py cross-checks it against the scalar solver."""
    import numpy as np

    def cdf(x):
        # Hart's algorithm (same as norm_cdf), vectorised.
        ax = np.abs(x)
        e = np.exp(-ax * ax / 2.0)
        b = 3.52624965998911e-02 * ax + 0.700383064443688
        for c in (6.37396220353165, 33.912866078383, 112.079291497871, 221.213596169931, 220.206867912376):
            b = b * ax + c
        num = e * b
        d = 8.83883476483184e-02 * ax + 1.75566716318264
        for c in (16.064177579207, 86.7807322029461, 296.564248779674, 637.333633378831, 793.826512519948, 440.413735824752):
            d = d * ax + c
        small = num / d
        t = ax + 0.65
        t = ax + 4.0 / t
        t = ax + 3.0 / t
        t = ax + 2.0 / t
        t = ax + 1.0 / t
        large = e / t / 2.506628274631
        cum = np.where(ax > 37.0, 0.0, np.where(ax < 7.07106781186547, small, large))
        return np.where(x > 0, 1.0 - cum, cum)

    def px(sigma):
        sq = sigma * np.sqrt(T)
        disc = np.exp(-r * T)
        with np.errstate(divide="ignore", invalid="ignore"):
            s_eff = np.where(is_futures, U * disc, U)
            d1 = (np.log(s_eff / K) + (r + 0.5 * sigma * sigma) * T) / sq
            d2 = d1 - sq
            call = s_eff * cdf(d1) - K * disc * cdf(d2)
            put = K * disc * cdf(-d2) - s_eff * cdf(-d1)
        return np.where(is_call, call, put)

    price = np.asarray(price, float)
    U = np.asarray(U, float)
    K = np.asarray(K, float)
    T = np.asarray(T, float)
    is_call = np.asarray(is_call, bool)
    is_futures = np.asarray(is_futures, bool)
    n = len(price)
    if n == 0:
        return np.array([])
    lo = np.full(n, 0.005)
    hi = np.full(n, 5.0)
    p_lo, p_hi = px(lo), px(hi)
    valid = (price > 0) & (U > 0) & (K > 0) & (T > 0) & (price > p_lo) & (price < p_hi)
    for _ in range(48):
        mid = 0.5 * (lo + hi)
        up = px(mid) < price
        lo = np.where(up, mid, lo)
        hi = np.where(up, hi, mid)
    return np.where(valid, 0.5 * (lo + hi), np.nan)


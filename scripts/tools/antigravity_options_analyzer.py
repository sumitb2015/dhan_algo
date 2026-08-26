"""
Antigravity Position & Risk Analyzer for Options
Evaluates open positions for NIFTY/BANKNIFTY/SENSEX/CRUDEOIL and returns
risk profiling and concrete adjustment recommendations.
Persists suggestions to debug/options_suggestions_<UNDERLYING>.json for rs_dashboard.

Usage:
    # Single on-demand run:
    python scripts/tools/antigravity_options_analyzer.py --underlying NIFTY --broker dhan
    python scripts/tools/antigravity_options_analyzer.py --snapshot-file debug/test_snapshot.json

    # Continuous background sentinel (daemon mode):
    python scripts/tools/antigravity_options_analyzer.py --underlying NIFTY --broker dhan --daemon --interval 180
"""
import os
import sys
import json
import time
import asyncio
import argparse
import subprocess
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List, Optional

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

DEBUG_DIR = os.path.join(ROOT, "debug")
STATUS_FILE = os.path.join(DEBUG_DIR, "options_analyzer_status.json")
STOP_TRIGGER = os.path.join(DEBUG_DIR, "options_analyzer_stop.trigger")
SUGGESTION_TTL_HOURS = 6

SYSTEM_INSTRUCTIONS = """You are an institutional risk manager and options desk analyst for open Indian derivative positions (NIFTY/BANKNIFTY/SENSEX/CRUDEOIL).
You receive a JSON snapshot of live option legs (strike, CE/PE, side, contracts/lots, entry price, LTP, unrealized P&L, greeks), net portfolio greeks, and payoff stats.

Your Task:
1. Identify the single biggest near-term risk in this specific book (e.g. gamma risk near expiry, directional delta skew, unhedged tail risk).
2. If warranted, propose 0-3 concrete adjustments.

Hard Rules & Greeks Mechanics:
- CRITICAL DELTA MECHANICS:
  * Short Put (SELL PE) contributes POSITIVE delta (+Delta, bullish). Excess short PE leaves the book exposed to severe downside crash risk.
  * Short Call (SELL CE) contributes NEGATIVE delta (-Delta, bearish). Excess short CE leaves the book exposed to upside rally risk.
  * To fix a POSITIVE net delta skew (e.g. +120), you MUST propose trimming the leg contributing positive delta (the Short PE or Long CE), NEVER the Short CE!
  * To fix a NEGATIVE net delta skew (e.g. -120), you MUST propose trimming the leg contributing negative delta (the Short CE or Long PE), NEVER the Short PE!
- You may ONLY propose closing or trimming legs already present in the "legs" array (exact strike, type, expiry).
- Never propose opening unlisted legs or speculative new positions.
- Action must be "CLOSE" (100%) or "TRIM" (25%, 50%, or 75%).
- Ground every rationale in given numbers (delta, distance from spot, P&L, DTE, lots).
- If the risk profile is balanced and within bounds, return empty suggestions.
- Provide a concise 2-4 sentence summary.

Output format MUST be valid JSON with keys:
{
  "summary": "2-4 sentence risk overview",
  "suggestions": [
    {
      "strike": 24500,
      "type": "CE",
      "expiry": "YYYY-MM-DD",
      "side": "SELL",
      "action": "TRIM",
      "pct": 50,
      "rationale": "Explanation with specific numbers"
    }
  ]
}
"""


def _calc_dte(expiry_str: str) -> float:
    """Calculate days to expiry from YYYY-MM-DD string."""
    try:
        exp_date = datetime.strptime(expiry_str.strip(), "%Y-%m-%d")
        now = datetime.now()
        diff = (exp_date - now).total_seconds() / 86400.0
        return max(0.0, diff)
    except Exception:
        return 7.0


def fetch_live_snapshot(underlying: str = "NIFTY", broker: str = "dhan") -> Dict[str, Any]:
    """Fetch position and Greeks snapshot via Node script."""
    script_path = os.path.join(ROOT, "rs_dashboard", "scripts", "analyze-positions.ts")
    if not os.path.exists(script_path):
        return {"underlying": underlying, "broker": broker, "spot": 0, "legs": [], "netGreeks": {}}
    
    cmd = ["node", script_path, "--underlying", underlying, "--broker", broker]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if res.returncode == 0 and res.stdout.strip():
            return json.loads(res.stdout)
    except Exception as e:
        sys.stderr.write(f"[Snapshot Fetch Note] {e}\n")
    return {"underlying": underlying, "broker": broker, "spot": 0, "legs": [], "netGreeks": {}}


def quantitative_risk_engine(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """
    Deterministic quantitative risk engine for options books.
    Provides mathematical analysis of Greeks, delta skew, gamma pin risk,
    and profit-taking thresholds.
    """
    underlying = snapshot.get("underlying", "NIFTY")
    spot = float(snapshot.get("spot") or 0.0)
    legs = snapshot.get("legs", [])
    net_greeks = snapshot.get("netGreeks", {}) or {}
    
    if not legs:
        return {
            "summary": f"No open {underlying} option positions on this broker — nothing to analyze.",
            "suggestions": []
        }

    net_delta = float(net_greeks.get("delta") or 0.0)
    net_theta = float(net_greeks.get("theta") or 0.0)
    net_gamma = float(net_greeks.get("gamma") or 0.0)
    net_vega = float(net_greeks.get("vega") or 0.0)

    suggestions: List[Dict[str, Any]] = []
    risks_found: List[str] = []

    # 1. Check each leg for urgent individual risk (Gamma pin risk, deep loss, profit lock)
    for leg in legs:
        strike = float(leg.get("strike") or 0.0)
        opt_type = str(leg.get("type") or "CE").upper()
        side = str(leg.get("side") or "BUY").upper()
        expiry = str(leg.get("expiry") or "")
        dte = _calc_dte(expiry)
        price = float(leg.get("price") or 0.0)
        ltp = float(leg.get("ltp") or (leg.get("display", {}).get("ltp") if isinstance(leg.get("display"), dict) else 0.0) or price)
        pnl = float(leg.get("unrealizedProfit") or (leg.get("display", {}).get("unrealizedProfit") if isinstance(leg.get("display"), dict) else 0.0) or 0.0)
        
        dist_pct = ((spot - strike) / spot * 100.0) if spot > 0 else 0.0
        is_itm = (opt_type == "CE" and spot > strike) or (opt_type == "PE" and spot < strike)
        
        # A. Short leg near-expiry Gamma squeeze / ITM pin risk
        if side == "SELL" and dte <= 2.5:
            if is_itm or abs(dist_pct) < 0.6:
                risks_found.append(f"Short {int(strike)} {opt_type} ({expiry}) has extreme gamma pin risk ({dte:.1f} DTE, {abs(dist_pct):.2f}% from spot)")
                suggestions.append({
                    "strike": strike,
                    "type": opt_type,
                    "expiry": expiry,
                    "side": side,
                    "action": "CLOSE" if is_itm else "TRIM",
                    "pct": 100 if is_itm else 50,
                    "rationale": f"Short {int(strike)} {opt_type} is facing severe near-expiry gamma risk with spot at {spot:.1f} ({abs(dist_pct):.2f}% away). {'Closing' if is_itm else 'Trimming 50%'} neutralizes assignment/pin risk."
                })
                continue

        # B. High profit capture on short leg (> 80% decay captured)
        if side == "SELL" and price > 0:
            profit_pct = (price - ltp) / price * 100.0
            if profit_pct >= 80.0 and ltp < 15.0:
                suggestions.append({
                    "strike": strike,
                    "type": opt_type,
                    "expiry": expiry,
                    "side": side,
                    "action": "CLOSE",
                    "pct": 100,
                    "rationale": f"Short {int(strike)} {opt_type} has captured {profit_pct:.1f}% of premium (LTP ₹{ltp:.1f} vs entry ₹{price:.1f}). Closing locks in profit and frees up margin."
                })
                continue

        # C. Deep runaway loss on naked short leg
        if side == "SELL" and price > 0 and ltp > (price * 2.5) and pnl < -2000:
            risks_found.append(f"Short {int(strike)} {opt_type} is in deep loss (LTP ₹{ltp:.1f} vs entry ₹{price:.1f})")
            suggestions.append({
                "strike": strike,
                "type": opt_type,
                "expiry": expiry,
                "side": side,
                "action": "TRIM",
                "pct": 50,
                "rationale": f"Short {int(strike)} {opt_type} is experiencing an adverse move with unrealized P&L of ₹{pnl:,.0f} (LTP ₹{ltp:.1f}). Trimming 50% de-risks the portfolio."
            })

    # 2. Portfolio-level Delta Imbalance Check
    # If no urgent pin-risk suggestions exist and net delta is strongly skewed:
    if not suggestions and abs(net_delta) > 50:
        is_bullish_skew = (net_delta > 0)
        skew_dir = "bullish (downside crash exposure)" if is_bullish_skew else "bearish (upside rally exposure)"
        risks_found.append(f"Portfolio has an aggressive {skew_dir} with Net Delta {net_delta:+.1f}")
        
        target_leg = None
        target_delta_contrib = 0.0
        
        for leg in legs:
            l_type = str(leg.get("type") or "CE").upper()
            l_side = str(leg.get("side") or "BUY").upper()
            qty = float(leg.get("qtyLots") or (leg.get("qtyContracts") or 1.0))
            
            # Extract or estimate unit delta
            raw_delta = leg.get("delta")
            if raw_delta is not None and raw_delta != 0.0:
                unit_delta = float(raw_delta)
            else:
                unit_delta = 0.45 if l_type == "CE" else -0.45
            
            # Position Delta contribution:
            # BUY CE: (+1) * (+) = +Delta
            # SELL CE: (-1) * (+) = -Delta
            # BUY PE: (+1) * (-) = -Delta
            # SELL PE: (-1) * (-) = +Delta
            pos_sign = 1.0 if l_side == "BUY" else -1.0
            pos_delta = pos_sign * qty * unit_delta

            if is_bullish_skew:
                # Need to reduce positive delta -> find the leg contributing the most POSITIVE delta
                if pos_delta > target_delta_contrib:
                    target_delta_contrib = pos_delta
                    target_leg = leg
            else:
                # Need to reduce negative delta -> find the leg contributing the most NEGATIVE delta
                if pos_delta < target_delta_contrib:
                    target_delta_contrib = pos_delta
                    target_leg = leg

        if target_leg:
            t_strike = float(target_leg.get("strike") or 0.0)
            t_type = str(target_leg.get("type") or "CE").upper()
            t_side = str(target_leg.get("side") or "SELL").upper()
            t_exp = str(target_leg.get("expiry") or "")
            t_qty = int(target_leg.get("qtyLots") or target_leg.get("qtyContracts") or 1)
            
            if is_bullish_skew:
                rationale = (
                    f"Net portfolio delta is skewed bullish at {net_delta:+.1f} (heavily exposed to downside drops) "
                    f"due to holding {t_qty} lot(s) of {int(t_strike)} {t_type}. Trimming 50% reduces positive delta "
                    f"and rebalances the book towards delta-neutral."
                )
            else:
                rationale = (
                    f"Net portfolio delta is skewed bearish at {net_delta:+.1f} (heavily exposed to upside spikes) "
                    f"due to holding {t_qty} lot(s) of {int(t_strike)} {t_type}. Trimming 50% reduces negative delta "
                    f"and rebalances the book towards delta-neutral."
                )

            suggestions.append({
                "strike": t_strike,
                "type": t_type,
                "expiry": t_exp,
                "side": t_side,
                "action": "TRIM",
                "pct": 50,
                "rationale": rationale
            })

    suggestions = suggestions[:3]

    if suggestions:
        risk_desc = "; ".join(risks_found) if risks_found else "Position skew detected"
        summary = (
            f"Book Analysis for {underlying} (Spot: {spot:.1f}, Net Delta: {net_delta:+.1f}, Net Theta: {net_theta:+.1f}): "
            f"{risk_desc}. Proposed {len(suggestions)} adjustment(s) to safeguard capital and optimize Greek exposure."
        )
    else:
        summary = (
            f"The {underlying} book is currently well-balanced (Spot: {spot:.1f}, Net Delta: {net_delta:+.1f}, Net Theta: {net_theta:+.1f}). "
            f"All legs are safely positioned with no immediate gamma or assignment threats. No adjustments required at this time."
        )

    return {
        "summary": summary,
        "suggestions": suggestions
    }


async def analyze_with_antigravity_agent(snapshot: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Attempt analysis via the google-antigravity Agent SDK if available."""
    try:
        from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig
        
        config = LocalAgentConfig(
            system_instructions=SYSTEM_INSTRUCTIONS,
            capabilities=CapabilitiesConfig(),
        )
        prompt = f"Analyze this options snapshot:\n\n{json.dumps(snapshot, indent=2)}"
        
        async with Agent(config) as agent:
            response = await agent.chat(prompt)
            raw_text = ""
            async for token in response:
                raw_text += token

        cleaned = raw_text.strip()
        if cleaned.startswith("```json"):
            cleaned = cleaned[7:]
        if cleaned.startswith("```"):
            cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()

        parsed = json.loads(cleaned)
        if isinstance(parsed, dict) and "summary" in parsed:
            return parsed
    except Exception as e:
        sys.stderr.write(f"[Antigravity SDK Note] Falling back to quantitative engine: {e}\n")
    return None


async def evaluate_and_persist(snapshot: Dict[str, Any], underlying: str) -> Dict[str, Any]:
    """Runs analysis, filters valid suggestions, and persists to debug JSON."""
    result = await analyze_with_antigravity_agent(snapshot)
    if not result:
        result = quantitative_risk_engine(snapshot)

    summary = result.get("summary", "Analysis completed.")
    raw_suggestions = result.get("suggestions", [])
    
    legs = snapshot.get("legs", [])
    valid_suggestions: List[Dict[str, Any]] = []
    now_ms = int(datetime.now().timestamp() * 1000)

    for i, s in enumerate(raw_suggestions):
        s_strike = float(s.get("strike") or 0.0)
        s_type = str(s.get("type") or "").upper()
        s_exp = str(s.get("expiry") or "").strip()
        
        match = any(
            float(l.get("strike") or 0.0) == s_strike and
            str(l.get("type") or "").upper() == s_type and
            (not s_exp or str(l.get("expiry") or "").strip() == s_exp)
            for l in legs
        )
        if match or not legs:
            valid_suggestions.append({
                "id": f"sugg_{now_ms}_{i}",
                "strike": int(s_strike) if s_strike.is_integer() else s_strike,
                "type": s_type,
                "expiry": s_exp,
                "side": str(s.get("side") or "SELL").upper(),
                "action": str(s.get("action") or "TRIM").upper(),
                "pct": int(s.get("pct") or 50),
                "rationale": str(s.get("rationale") or "")
            })

    os.makedirs(DEBUG_DIR, exist_ok=True)
    file_path = os.path.join(DEBUG_DIR, f"options_suggestions_{underlying}.json")
    now_dt = datetime.now(timezone.utc)
    payload = {
        "underlying": underlying,
        "generatedAt": now_dt.isoformat(),
        "expiresAt": (now_dt + timedelta(hours=SUGGESTION_TTL_HOURS)).isoformat(),
        "suggestions": valid_suggestions,
    }
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except Exception as e:
        sys.stderr.write(f"[Warning] Failed to write suggestions file: {e}\n")

    return {
        "success": True,
        "underlying": underlying,
        "summary": summary,
        "suggestions": valid_suggestions
    }


def write_status(pid: int, status: str, underlying: str, broker: str, interval: int,
                 last_summary: str = "", suggestions_count: int = 0):
    """Write daemon heartbeat and status to debug/options_analyzer_status.json."""
    os.makedirs(DEBUG_DIR, exist_ok=True)
    payload = {
        "pid": pid,
        "status": status,
        "underlying": underlying,
        "broker": broker,
        "interval": interval,
        "lastHeartbeat": datetime.now(timezone.utc).isoformat(),
        "lastSummary": last_summary,
        "activeSuggestionsCount": suggestions_count,
    }
    try:
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except Exception as e:
        sys.stderr.write(f"[Warning] Failed to write status file: {e}\n")


async def run_daemon(underlying: str, broker: str, interval: int):
    """Continuous background monitoring daemon."""
    pid = os.getpid()
    sys.stderr.write(f"[*] Starting Antigravity Options Sentinel daemon (PID: {pid}, underlying: {underlying}, interval: {interval}s)\n")
    
    # Remove stale stop trigger
    if os.path.exists(STOP_TRIGGER):
        try:
            os.unlink(STOP_TRIGGER)
        except Exception:
            pass

    write_status(pid, "RUNNING", underlying, broker, interval, "Sentinel initialized", 0)

    try:
        while True:
            # Check stop trigger
            if os.path.exists(STOP_TRIGGER):
                sys.stderr.write(f"[*] Stop trigger detected. Exiting daemon gracefully.\n")
                try:
                    os.unlink(STOP_TRIGGER)
                except Exception:
                    pass
                break

            # Fetch fresh snapshot in non-blocking thread
            snapshot = await asyncio.to_thread(fetch_live_snapshot, underlying, broker)
            result = await evaluate_and_persist(snapshot, underlying)
            
            summary = result.get("summary", "")
            sugg_count = len(result.get("suggestions", []))
            
            write_status(pid, "RUNNING", underlying, broker, interval, summary, sugg_count)
            sys.stderr.write(f"[{datetime.now().strftime('%H:%M:%S')}] Evaluated {underlying}: {sugg_count} suggestion(s). Next check in {interval}s.\n")

            # Sleep in 1-second chunks to be responsive to stop triggers
            for _ in range(interval):
                if os.path.exists(STOP_TRIGGER):
                    break
                await asyncio.sleep(1)

    finally:
        write_status(pid, "STOPPED", underlying, broker, interval, "Sentinel stopped", 0)
        sys.stderr.write("[*] Sentinel daemon stopped.\n")


async def main_async():
    parser = argparse.ArgumentParser(description="Antigravity Options Position Analyzer")
    parser.add_argument("--underlying", default="NIFTY")
    parser.add_argument("--broker", default="dhan")
    parser.add_argument("--snapshot-file", default=None, help="Path to snapshot JSON file")
    parser.add_argument("--snapshot-json", default=None, help="Raw snapshot JSON string")
    parser.add_argument("--daemon", action="store_true", help="Run continuously in background sentinel mode")
    parser.add_argument("--interval", type=int, default=180, help="Check interval in seconds for daemon mode")
    args = parser.parse_args()

    underlying = args.underlying.upper()
    broker = args.broker.lower()

    if args.daemon:
        await run_daemon(underlying, broker, args.interval)
        return

    snapshot: Dict[str, Any] = {}

    if args.snapshot_file and os.path.exists(args.snapshot_file):
        try:
            with open(args.snapshot_file, "r", encoding="utf-8") as f:
                snapshot = json.load(f)
        except Exception as e:
            sys.stderr.write(f"[Error] Failed to read snapshot file: {e}\n")

    if not snapshot and args.snapshot_json:
        try:
            snapshot = json.loads(args.snapshot_json)
        except Exception as e:
            sys.stderr.write(f"[Error] Failed to parse snapshot JSON: {e}\n")
    
    if not snapshot and not sys.stdin.isatty():
        try:
            stdin_data = sys.stdin.read().strip()
            if stdin_data:
                snapshot = json.loads(stdin_data)
        except Exception as e:
            sys.stderr.write(f"[Error] Failed to read stdin JSON: {e}\n")

    if not snapshot:
        snapshot = fetch_live_snapshot(underlying, broker)

    underlying = str(snapshot.get("underlying") or underlying).upper()

    output_payload = await evaluate_and_persist(snapshot, underlying)
    print(json.dumps(output_payload))


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    main()

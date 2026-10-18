#!/usr/bin/env python3
"""
ICICI Direct (Breeze API) Historical Options Downloader & Backup Store

Downloads 1-minute historical candles for NIFTY expired/active options contracts
from ICICI Direct's Breeze API and stores them into an SQLite database
(Options Data/breeze_nifty_options.db) matching the project's standard options schema.

Prerequisites:
  1. Active ICICI Direct trading account with Breeze API access enabled.
  2. BREEZE_API_KEY, BREEZE_SECRET_KEY, and BREEZE_SESSION_TOKEN set in .env or passed via CLI.
  3. breeze-connect package installed.

Usage:
  venv/bin/python scripts/downloader/download_breeze_options.py --help
  venv/bin/python scripts/downloader/download_breeze_options.py --weeks 4
  venv/bin/python scripts/downloader/download_breeze_options.py --from-date 2026-08-01 --to-date 2026-10-15 --strikes 5
"""

import os
import sys
import json
import time
import argparse
import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Project paths
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# Load environment variables from .env
try:
    from dotenv import load_dotenv
    load_dotenv(PROJECT_ROOT / ".env")
except ImportError:
    pass

DEBUG_DIR = PROJECT_ROOT / "debug"
STATUS_FILE = DEBUG_DIR / "breeze_download_status.json"
STOP_FILE = DEBUG_DIR / "breeze_download_stop.trigger"
DEFAULT_DB_PATH = PROJECT_ROOT / "Options Data" / "breeze_nifty_options.db"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("breeze_downloader")


def write_status(message: str, done: bool = False, error: str | None = None, progress: dict | None = None):
    try:
        DEBUG_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "done": done,
            "message": message,
            "error": error,
            "progress": progress or {},
            "pid": os.getpid(),
            "updated_at": datetime.now().isoformat(),
        }
        with open(STATUS_FILE, "w") as f:
            json.dump(payload, f, indent=2)
    except Exception as e:
        logger.debug(f"Failed to write status file: {e}")


def check_stop_trigger() -> bool:
    if STOP_FILE.exists():
        try:
            STOP_FILE.unlink()
        except Exception:
            pass
        return True
    return False


def init_db(db_path: Path):
    """Initializes the SQLite database schema with indexes matching nifty_options.db."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(db_path))
    cur = con.cursor()
    cur.execute("""
    CREATE TABLE IF NOT EXISTS option_prices (
        expiry TEXT,
        datetime TEXT,
        option_type TEXT,
        strike REAL,
        strike_relative TEXT,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        spot REAL,
        volume REAL,
        oi REAL,
        iv REAL,
        PRIMARY KEY (expiry, datetime, option_type, strike)
    )
    """)
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_lookup ON option_prices (expiry, datetime, option_type, strike)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_expiry_datetime ON option_prices (expiry, datetime)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_relative ON option_prices (expiry, strike_relative, option_type, datetime)")
    con.commit()
    con.close()


class BreezeDownloader:
    def __init__(self, api_key: str, secret_key: str, session_token: str, db_path: Path, max_daily_calls: int = 4500):
        self.api_key = api_key
        self.secret_key = secret_key
        self.session_token = session_token
        self.db_path = db_path
        self.max_daily_calls = max_daily_calls
        self.call_count = 0
        self.last_call_time = 0.0
        self.min_interval_sec = 0.65  # ~90 calls/min to stay safely below the 100/min cap
        self.client = None

    def connect(self) -> bool:
        try:
            from breeze_connect import BreezeConnect
        except ImportError:
            logger.error("breeze-connect package is not installed. Run: pip install breeze-connect")
            return False

        if not self.api_key or not self.secret_key or not self.session_token:
            logger.error("Missing Breeze credentials (BREEZE_API_KEY, BREEZE_SECRET_KEY, BREEZE_SESSION_TOKEN).")
            self._print_login_guidance()
            return False

        try:
            logger.info("Connecting to ICICI Direct Breeze API...")
            self.client = BreezeConnect(api_key=self.api_key)
            self.client.generate_session(api_secret=self.secret_key, session_token=self.session_token)
            logger.info("Successfully authenticated with Breeze API!")
            return True
        except Exception as e:
            logger.error(f"Failed to generate Breeze session: {e}")
            self._print_login_guidance()
            return False

    def _print_login_guidance(self):
        import urllib.parse
        encoded_key = urllib.parse.quote_plus(self.api_key) if self.api_key else '<YOUR_API_KEY>'
        login_url = f"https://api.icicidirect.com/apiuser/login?api_key={encoded_key}"
        logger.info("\n" + "=" * 70)
        logger.info("BREEZE API LOGIN INSTRUCTIONS:")
        logger.info("1. Open this login URL in your browser to generate your daily session token:")
        logger.info(f"   {login_url}")
        logger.info("2. Log in with your ICICI Direct User ID, Password, and TOTP.")
        logger.info("3. After login, your browser redirects to your redirect URL with ?apisession=...")
        logger.info("4. Copy the value of 'apisession' from the URL bar.")
        logger.info("5. Pass it to this script: --session-token <APISESSION>")
        logger.info("   or set BREEZE_SESSION_TOKEN in .env")
        logger.info("=" * 70 + "\n")

    def _rate_limit_throttle(self):
        """Enforces a strict rate limit of ~90 calls/minute to prevent HTTP 429 throttling."""
        elapsed = time.time() - self.last_call_time
        if elapsed < self.min_interval_sec:
            time.sleep(self.min_interval_sec - elapsed)
        self.last_call_time = time.time()
        self.call_count += 1

    def fetch_historical_candles(
        self,
        stock_code: str,
        exchange_code: str,
        product_type: str,
        from_date_iso: str,
        to_date_iso: str,
        interval: str = "1minute",
        expiry_date_iso: str | None = None,
        right: str | None = None,
        strike_price: str | int | float | None = None,
    ) -> list[dict]:
        if self.call_count >= self.max_daily_calls:
            logger.warning(f"Reached safety call cap ({self.call_count}/{self.max_daily_calls}). Halting.")
            return []

        self._rate_limit_throttle()

        kwargs = {
            "interval": interval,
            "from_date": from_date_iso,
            "to_date": to_date_iso,
            "stock_code": stock_code,
            "exchange_code": exchange_code,
            "product_type": product_type,
        }
        if expiry_date_iso:
            kwargs["expiry_date"] = expiry_date_iso
        if right:
            kwargs["right"] = right.lower()
        if strike_price is not None:
            kwargs["strike_price"] = str(strike_price)

        try:
            res = self.client.get_historical_data(**kwargs)
            if res and isinstance(res, dict) and "Success" in res:
                return res["Success"] or []
            if res and isinstance(res, dict) and "Error" in res:
                logger.debug(f"Breeze API Error: {res.get('Error')}")
            return []
        except Exception as e:
            logger.error(f"Exception during Breeze historical fetch: {e}")
            return []

    def fetch_nifty_spot_history(self, from_date: str, to_date: str) -> dict[str, float]:
        """Fetches NIFTY spot 1-minute close prices across the date range in 30-day chunks to map ATM strikes."""
        start = datetime.strptime(from_date, "%Y-%m-%d")
        end = datetime.strptime(to_date, "%Y-%m-%d")
        spot_map = {}
        curr = start
        while curr < end:
            chunk_end = min(curr + timedelta(days=30), end)
            f_iso = f"{curr.strftime('%Y-%m-%d')}T09:15:00.000Z"
            t_iso = f"{chunk_end.strftime('%Y-%m-%d')}T15:30:00.000Z"
            logger.info(f"Fetching NIFTY spot candles: {curr.strftime('%Y-%m-%d')} to {chunk_end.strftime('%Y-%m-%d')}...")
            data = self.fetch_historical_candles(
                stock_code="NIFTY",
                exchange_code="NSE",
                product_type="cash",
                from_date_iso=f_iso,
                to_date_iso=t_iso,
                interval="1minute",
            )
            for row in data:
                dt = row.get("datetime")
                close = row.get("close")
                if dt and close is not None:
                    spot_map[dt[:19]] = float(close)
            curr = chunk_end + timedelta(days=1)
        logger.info(f"Fetched {len(spot_map)} total NIFTY spot minute bars.")
        return spot_map

    def save_option_bars_to_db(self, rows: list[dict], expiry_str: str, option_type: str, strike: float, spot_map: dict[str, float]):
        """Inserts fetched option candle rows into SQLite option_prices table."""
        if not rows:
            return 0

        con = sqlite3.connect(str(self.db_path))
        cur = con.cursor()
        inserted = 0

        # Deduplicate rows by datetime (Breeze known bug sometimes returns duplicate timestamps)
        deduped = {}
        for r in rows:
            dt = r.get("datetime", "")[:19]
            if dt:
                deduped[dt] = r

        for dt_str, r in deduped.items():
            try:
                o = float(r.get("open", 0))
                h = float(r.get("high", 0))
                l = float(r.get("low", 0))
                c = float(r.get("close", 0))
                v = float(r.get("volume", 0))
                oi = float(r.get("open_interest", 0) or 0)
                spot = spot_map.get(dt_str)

                cur.execute("""
                INSERT OR REPLACE INTO option_prices
                (expiry, datetime, option_type, strike, strike_relative, open, high, low, close, spot, volume, oi, iv)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (expiry_str, dt_str, option_type, strike, None, o, h, l, c, spot, v, oi, None))
                inserted += 1
            except Exception as e:
                logger.debug(f"Error inserting row: {e}")

        con.commit()
        con.close()
        return inserted

    def get_existing_contracts_for_expiry(self, expiry_str: str) -> set[tuple[str, float]]:
        """Returns set of (option_type, strike) that already exist in DB for this expiry."""
        try:
            con = sqlite3.connect(str(self.db_path))
            cur = con.cursor()
            rows = cur.execute(
                "SELECT DISTINCT option_type, strike FROM option_prices WHERE expiry = ?",
                (expiry_str,)
            ).fetchall()
            con.close()
            return set((r[0], float(r[1])) for r in rows)
        except Exception:
            return set()


def get_tuesday_expiries(start_date: datetime, end_date: datetime) -> list[str]:
    """Generates Tuesday weekly expiries between start_date and end_date."""
    expiries = []
    curr = start_date
    while curr <= end_date:
        # Tuesday is weekday 1
        if curr.weekday() == 1:
            expiries.append(curr.strftime("%Y-%m-%d"))
        curr += timedelta(days=1)
    return expiries


def main():
    parser = argparse.ArgumentParser(description="Download historical options data from ICICI Direct Breeze API.")
    parser.add_argument("--api-key", default=os.getenv("BREEZE_API_KEY", ""), help="Breeze API Key / App Key")
    parser.add_argument("--secret-key", default=os.getenv("BREEZE_SECRET_KEY", ""), help="Breeze API Secret Key")
    parser.add_argument("--session-token", default=os.getenv("BREEZE_SESSION_TOKEN", ""), help="Breeze Session Token")
    parser.add_argument("--from-date", help="Start date (YYYY-MM-DD)")
    parser.add_argument("--to-date", help="End date (YYYY-MM-DD)")
    parser.add_argument("--weeks", type=int, default=4, help="Number of recent weeks to download if dates omitted (default 4)")
    parser.add_argument("--strike-step", type=int, default=50, help="NIFTY strike step (default 50)")
    parser.add_argument("--strikes-range", type=int, default=20, help="Number of strikes above and below ATM (default 20, ATM±20)")
    parser.add_argument("--db-path", default=str(DEFAULT_DB_PATH), help="Target SQLite DB path")
    parser.add_argument("--max-calls", type=int, default=4500, help="Daily API call ceiling safeguard (default 4500)")

    args = parser.parse_args()

    init_db(Path(args.db_path))

    downloader = BreezeDownloader(
        api_key=args.api_key,
        secret_key=args.secret_key,
        session_token=args.session_token,
        db_path=Path(args.db_path),
        max_daily_calls=args.max_calls,
    )

    if not downloader.connect():
        write_status("Authentication failed: Missing or invalid credentials", done=True, error="Auth failed")
        sys.exit(1)

    # Persist working session token to .env if passed via CLI
    if args.session_token:
        try:
            env_path = PROJECT_ROOT / ".env"
            content = env_path.read_text() if env_path.exists() else ""
            if "BREEZE_SESSION_TOKEN=" in content:
                import re
                new_content = re.sub(r'BREEZE_SESSION_TOKEN=.*', f'BREEZE_SESSION_TOKEN="{args.session_token}"', content)
            else:
                new_content = content.rstrip() + f'\nBREEZE_SESSION_TOKEN="{args.session_token}"\n'
            env_path.write_text(new_content)
            logger.info("Saved BREEZE_SESSION_TOKEN to .env")
        except Exception as e:
            logger.debug(f"Could not persist session token to .env: {e}")

    today = datetime.now()
    if args.to_date:
        end_dt = datetime.strptime(args.to_date, "%Y-%m-%d")
    else:
        end_dt = today

    if args.from_date:
        start_dt = datetime.strptime(args.from_date, "%Y-%m-%d")
    else:
        start_dt = end_dt - timedelta(weeks=args.weeks)

    from_str = start_dt.strftime("%Y-%m-%d")
    to_str = end_dt.strftime("%Y-%m-%d")
    expiries = get_tuesday_expiries(start_dt, end_dt)

    logger.info(f"Target date range: {from_str} to {to_str} ({len(expiries)} Tuesday expiries identified)")
    write_status(f"Starting download for {len(expiries)} expiries ({from_str} to {to_str})")

    # Fetch spot history to identify ATM strikes
    spot_map = downloader.fetch_nifty_spot_history(from_str, to_str)

    total_bars_saved = 0
    total_tasks = len(expiries) * ((args.strikes_range * 2) + 1) * 2
    task_idx = 0

    for expiry in expiries:
        if check_stop_trigger():
            logger.info("Stop trigger detected. Halting.")
            write_status("Stopped by user", done=True)
            break

        expiry_dt = datetime.strptime(expiry, "%Y-%m-%d")
        # Query contract starting 14 calendar days before expiry to capture full life and pre-Wednesday warmup
        contract_start_dt = expiry_dt - timedelta(days=14)
        c_from_iso = f"{contract_start_dt.strftime('%Y-%m-%d')}T09:15:00.000Z"
        c_to_iso = f"{expiry}T15:30:00.000Z"
        breeze_expiry_iso = f"{expiry}T07:00:00.000Z"

        # Determine reference spot on expiry morning or start date
        ref_spot = 24500  # fallback
        for dt_key, sp in spot_map.items():
            if dt_key.startswith(expiry):
                ref_spot = sp
                break

        atm_strike = int(round(ref_spot / args.strike_step) * args.strike_step)
        strikes = [atm_strike + (i * args.strike_step) for i in range(-args.strikes_range, args.strikes_range + 1)]

        existing_contracts = downloader.get_existing_contracts_for_expiry(expiry)
        if existing_contracts:
            logger.info(f"=== Expiry {expiry} (ATM ~{atm_strike}, Strikes: {strikes[0]}..{strikes[-1]}) [Found {len(existing_contracts)} existing contracts in DB] ===")
        else:
            logger.info(f"=== Expiry {expiry} (ATM ~{atm_strike}, Strikes: {strikes[0]}..{strikes[-1]}) ===")
        stopped = False

        for strike in strikes:
            if stopped:
                break
            for opt in ["CE", "PE"]:
                if (opt, float(strike)) in existing_contracts:
                    # Contract already present in DB: skip API call to save daily quota
                    continue

                task_idx += 1
                if check_stop_trigger():
                    logger.info("Stop trigger detected. Halting.")
                    write_status("Stopped by user", done=True)
                    stopped = True
                    break
                if downloader.call_count >= downloader.max_daily_calls:
                    logger.warning(f"Reached safety call cap ({downloader.call_count}/{downloader.max_daily_calls}). Halting.")
                    write_status("Safety call cap reached", done=True)
                    stopped = True
                    break

                breeze_right = "call" if opt == "CE" else "put"
                progress = {
                    "expiry": expiry,
                    "strike": strike,
                    "option": opt,
                    "completed_tasks": task_idx,
                    "total_tasks": total_tasks,
                    "api_calls_made": downloader.call_count,
                    "bars_saved": total_bars_saved,
                }
                write_status(f"Downloading {expiry} {strike} {opt} (Call {downloader.call_count}/{downloader.max_daily_calls})", progress=progress)

                rows = downloader.fetch_historical_candles(
                    stock_code="NIFTY",
                    exchange_code="NFO",
                    product_type="options",
                    from_date_iso=c_from_iso,
                    to_date_iso=c_to_iso,
                    interval="1minute",
                    expiry_date_iso=breeze_expiry_iso,
                    right=breeze_right,
                    strike_price=strike,
                )

                saved = downloader.save_option_bars_to_db(rows, expiry, opt, float(strike), spot_map)
                total_bars_saved += saved
                logger.info(f"  {expiry} {strike}{opt}: {len(rows)} bars fetched -> {saved} rows stored in DB (Calls: {downloader.call_count})")

        if stopped:
            break

    logger.info(f"Download session finished. Total API calls: {downloader.call_count}. Total bars stored: {total_bars_saved}.")
    write_status(f"Completed: {total_bars_saved} bars stored across {downloader.call_count} API calls.", done=True)


if __name__ == "__main__":
    main()

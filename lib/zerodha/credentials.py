"""Zerodha credentials, read from .env.zerodha at the project root (independent of CWD)."""
import os
from dotenv import dotenv_values

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_env = dotenv_values(os.path.join(PROJECT_ROOT, ".env.zerodha"))

USER_ID = _env.get("ZERODHA_USER_ID")
PASSWORD = _env.get("ZERODHA_PASSWORD")
TOTP = _env.get("ZERODHA_TOTP_KEY")
API_KEY = _env.get("ZERODHA_API_KEY")
API_SECRET = _env.get("ZERODHA_API_SECRET")


def require():
    """Raise a clear error if any credential is missing from .env.zerodha."""
    names = {"ZERODHA_USER_ID": USER_ID, "ZERODHA_PASSWORD": PASSWORD, "ZERODHA_TOTP_KEY": TOTP,
             "ZERODHA_API_KEY": API_KEY, "ZERODHA_API_SECRET": API_SECRET}
    missing = [k for k, v in names.items() if not v]
    if missing:
        raise RuntimeError(f"Missing in .env.zerodha: {', '.join(missing)}")

"""
Reports which Dhan / Zerodha / Kotak credentials are configured.

By default values are masked. `--reveal` includes the plaintext under a
"value" key — the /api/auth/config route only passes that flag for a request
carrying a valid dashboard session, because the route itself is exempt from the
auth middleware and the server listens on 0.0.0.0. Without that gate, one
unauthenticated request from anywhere on the LAN would hand over every broker
password, MPIN and TOTP seed.

Usage: python get_auth_config.py [--reveal]
Output: JSON on stdout — {"dhan": {...}, "zerodha": {...}, "kotak": {...}}
"""
import os
import json
from dotenv import dotenv_values

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Fields where partially revealing the value is safe/useful (identifiers).
IDENTIFIER_FIELDS = {
    "client_id", "api_key",
    "ZERODHA_USER_ID", "ZERODHA_API_KEY",
    # UCC and mobile number are identifiers, not secrets — masking them partially
    # is what makes the Settings sheet useful for spotting a wrong account.
    "KOTAK_UCC", "KOTAK_MOBILE_NUMBER",
}


def mask_identifier(value):
    if not value:
        return None
    if len(value) <= 4:
        return "●" * len(value)
    return f"{value[:2]}{'●' * (len(value) - 4)}{value[-2:]}"


def describe(values, keys, reveal=False):
    out = {}
    for key in keys:
        value = values.get(key)
        entry = {"set": bool(value)}
        if key in IDENTIFIER_FIELDS:
            entry["masked"] = mask_identifier(value)
        if reveal and value:
            entry["value"] = value
        out[key] = entry
    return out


def main():
    import sys
    reveal = "--reveal" in sys.argv

    dhan_env = dotenv_values(os.path.join(PROJECT_ROOT, ".env"))
    zerodha_env = dotenv_values(os.path.join(PROJECT_ROOT, ".env.zerodha"))
    kotak_env = dotenv_values(os.path.join(PROJECT_ROOT, ".env.kotak"))

    result = {
        "dhan": describe(dhan_env, ["client_id", "api_key", "api_secret", "dhan_pin", "totp_key"], reveal),
        "zerodha": describe(zerodha_env, [
            "ZERODHA_USER_ID", "ZERODHA_API_KEY", "ZERODHA_API_SECRET",
            "ZERODHA_PASSWORD", "ZERODHA_TOTP_KEY",
        ], reveal),
        "kotak": describe(kotak_env, [
            "KOTAK_UCC", "KOTAK_MOBILE_NUMBER", "KOTAK_CONSUMER_KEY",
            "KOTAK_MPIN", "KOTAK_TOTP_SECRET",
        ], reveal),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()

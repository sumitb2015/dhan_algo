"""
Reports which Dhan / Zerodha credentials are configured, without ever
printing real secret values. Called by the Next.js /api/auth/config route.

Usage: python get_auth_config.py
Output: JSON on stdout — {"dhan": {...}, "zerodha": {...}}
"""
import os
import json
from dotenv import dotenv_values

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Fields where partially revealing the value is safe/useful (identifiers).
IDENTIFIER_FIELDS = {"client_id", "api_key", "ZERODHA_USER_ID", "ZERODHA_API_KEY"}


def mask_identifier(value):
    if not value:
        return None
    if len(value) <= 4:
        return "●" * len(value)
    return f"{value[:2]}{'●' * (len(value) - 4)}{value[-2:]}"


def describe(values, keys):
    out = {}
    for key in keys:
        value = values.get(key)
        if key in IDENTIFIER_FIELDS:
            out[key] = {"set": bool(value), "masked": mask_identifier(value)}
        else:
            out[key] = {"set": bool(value)}
    return out


def main():
    dhan_env = dotenv_values(os.path.join(PROJECT_ROOT, ".env"))
    zerodha_env = dotenv_values(os.path.join(PROJECT_ROOT, ".env.zerodha"))

    result = {
        "dhan": describe(dhan_env, ["client_id", "api_key", "api_secret", "dhan_pin", "totp_key"]),
        "zerodha": describe(zerodha_env, [
            "ZERODHA_USER_ID", "ZERODHA_API_KEY", "ZERODHA_API_SECRET",
            "ZERODHA_PASSWORD", "ZERODHA_TOTP_KEY",
        ]),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()

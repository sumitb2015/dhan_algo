import os
import logging

import requests
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_BASE_DIR, ".env"))

_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")


def notify(message: str) -> bool:
    """
    Sends a message to the configured Telegram chat. No-ops (logs a debug line)
    if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID aren't set in .env. Never raises —
    a Telegram outage must not be able to block a strategy's trading loop.
    """
    if not _BOT_TOKEN or not _CHAT_ID:
        logger.debug("Telegram alert skipped (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set): %s", message)
        return False
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{_BOT_TOKEN}/sendMessage",
            json={"chat_id": _CHAT_ID, "text": message},
            timeout=5,
        )
        if not resp.ok:
            logger.warning("Telegram alert failed (%s): %s", resp.status_code, resp.text[:200])
            return False
        return True
    except Exception as e:
        logger.warning("Telegram alert failed: %s", e)
        return False

"""
Download and update master_list.csv from Dhan API.
Fetches all tradeable segments (NSE_EQ, NSE_FNO, BSE_EQ, BSE_FNO, MCX_COMM),
writes atomically to master_list.csv, and clears any stale master_list cache.
"""
import io
import json
import logging
import os
import shutil
import sys
import requests
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("update_master_list")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def update_master_list(segments=None):
    if segments is None:
        segments = ['NSE_EQ', 'NSE_FNO', 'BSE_EQ', 'BSE_FNO', 'MCX_COMM']

    dhan = get_dhan_client()
    if not dhan:
        logger.error("Failed to initialize Dhan client. Please run login.py first.")
        return False

    dhan_http = getattr(dhan, 'dhan_http', None)
    client_id = getattr(dhan_http, 'client_id', None) or os.getenv("client_id")
    access_token = getattr(dhan_http, 'access_token', None)

    if not access_token or not client_id:
        logger.error("Missing access token or client ID.")
        return False

    headers = {
        "access-token": access_token,
        "client-id": str(client_id),
        "Content-Type": "application/json"
    }

    dfs = []
    logger.info(f"Downloading master list segments: {segments}...")
    for seg in segments:
        url = f"https://api.dhan.co/v2/instrument/{seg}"
        logger.info(f"Downloading {seg} from {url}...")
        try:
            resp = requests.get(url, headers=headers, timeout=60)
            if resp.status_code == 200:
                df = pd.read_csv(io.StringIO(resp.text), low_memory=False)
                dfs.append(df)
                logger.info(f"Downloaded {seg}: {len(df)} records")
            else:
                logger.error(f"Failed to download {seg}: {resp.status_code} - {resp.text[:100]}")
                return False
        except Exception as e:
            logger.error(f"Exception downloading {seg}: {e}")
            return False

    if not dfs:
        logger.error("No dataframes downloaded.")
        return False

    full_df = pd.concat(dfs, ignore_index=True)
    master_path = os.path.join(ROOT, "master_list.csv")
    bak_path = os.path.join(ROOT, "master_list.csv.bak")
    tmp_path = os.path.join(ROOT, "master_list.csv.tmp")

    # Backup existing
    if os.path.exists(master_path):
        try:
            shutil.copy2(master_path, bak_path)
            logger.info(f"Backed up existing master list to {bak_path}")
        except Exception as e:
            logger.warning(f"Failed to backup master list: {e}")

    # Write atomically
    logger.info(f"Writing {len(full_df)} records to {tmp_path}...")
    full_df.to_csv(tmp_path, index=False)
    os.replace(tmp_path, master_path)
    logger.info(f"Successfully replaced {master_path} ({os.path.getsize(master_path):,} bytes)")

    # Clear master list caches if they exist
    cache_parquet = os.path.join(ROOT, "debug", "master_list_cache.parquet")
    cache_json = os.path.join(ROOT, "debug", "master_list_cache.json")
    for cp in (cache_parquet, cache_json):
        if os.path.exists(cp):
            try:
                os.remove(cp)
                logger.info(f"Removed stale cache: {cp}")
            except Exception as e:
                logger.warning(f"Could not remove {cp}: {e}")

    # Verify with DhanHelper
    logger.info("Verifying with DhanHelper...")
    helper = DhanHelper(dhan)
    helper._load_master_list(reload=True)

    # Check NIFTY 2026-11-03 options
    df_loaded = helper._load_master_list()
    mask = (
        (df_loaded['UNDERLYING_SYMBOL'] == 'NIFTY') &
        (df_loaded['SM_EXPIRY_DATE'].astype(str).str.startswith('2026-11-03'))
    )
    nifty_count = len(df_loaded[mask])
    logger.info(f"NIFTY 2026-11-03 options in updated master list: {nifty_count}")

    ce_match = df_loaded[mask & (df_loaded['STRIKE_PRICE'] == 22550) & (df_loaded['OPTION_TYPE'] == 'CE')]
    if not ce_match.empty:
        row = ce_match.iloc[0]
        logger.info(f"VERIFIED: Found NIFTY 2026-11-03 22550CE -> Security ID: {row['SECURITY_ID']}, Lot Size: {row['LOT_SIZE']}")
        return True
    else:
        logger.error("Could not find NIFTY 2026-11-03 22550CE in updated master list!")
        return False


if __name__ == "__main__":
    success = update_master_list()
    sys.exit(0 if success else 1)

"""
CLI store for saved positional NIFTY options strategies, backed by SQLite.

Usage:
    python strategy_store.py init
    python strategy_store.py save   --json '<StrategyPayload JSON>'
    python strategy_store.py list
    python strategy_store.py get    <id>
    python strategy_store.py update <id> --status open|closed
    python strategy_store.py delete <id>

Prints a single JSON line to stdout. Logs go to stderr.
"""
import sys
import os
import json
import sqlite3
import argparse
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.path.join(ROOT, 'debug', 'strategies.db')

SCHEMA = """
CREATE TABLE IF NOT EXISTS strategies (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_type     TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    underlying        TEXT NOT NULL,
    expiry            TEXT NOT NULL,
    mode              TEXT NOT NULL,
    lots              INTEGER NOT NULL,
    lot_size          INTEGER NOT NULL,
    params_json       TEXT NOT NULL,
    entry_spot        REAL NOT NULL,
    entry_net_premium REAL NOT NULL,
    legs_json         TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'open',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    notes             TEXT
);

CREATE TABLE IF NOT EXISTS strategy_legs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id   INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
    strike        REAL NOT NULL,
    option_type   TEXT NOT NULL,
    side          TEXT NOT NULL,
    qty_lots      INTEGER NOT NULL,
    entry_price   REAL NOT NULL,
    entry_delta   REAL,
    security_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_legs_strategy ON strategy_legs(strategy_id);
"""


def get_connection() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def cmd_init() -> dict:
    get_connection().close()
    return {"ok": True, "db_path": DB_PATH}


def cmd_save(payload: dict) -> dict:
    REQUIRED = ["strategy_type", "display_name", "underlying", "expiry", "mode",
                "lots", "lot_size", "entry_spot", "entry_net_premium", "legs"]
    missing = [f for f in REQUIRED if f not in payload or payload[f] is None]
    if missing:
        return {"error": f"Missing required fields: {', '.join(missing)}"}
    if not isinstance(payload["legs"], list) or len(payload["legs"]) == 0:
        return {"error": "legs must be a non-empty list"}
    if int(payload.get("lots", 0)) < 1:
        return {"error": "lots must be at least 1"}

    now = datetime.now(timezone.utc).isoformat()
    conn = get_connection()
    try:
        cur = conn.execute(
            """INSERT INTO strategies
               (strategy_type, display_name, underlying, expiry, mode, lots, lot_size,
                params_json, entry_spot, entry_net_premium, legs_json, status, created_at, updated_at, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)""",
            (
                payload['strategy_type'], payload['display_name'], payload['underlying'],
                payload['expiry'], payload['mode'], int(payload['lots']), int(payload['lot_size']),
                json.dumps(payload.get('params', {})), float(payload['entry_spot']),
                float(payload['entry_net_premium']), json.dumps(payload['legs']),
                now, now, payload.get('notes'),
            ),
        )
        strategy_id = cur.lastrowid
        for leg in payload['legs']:
            conn.execute(
                """INSERT INTO strategy_legs
                   (strategy_id, strike, option_type, side, qty_lots, entry_price, entry_delta, security_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    strategy_id, float(leg['strike']), leg['option_type'], leg['side'],
                    int(leg['qty_lots']), float(leg['entry_price']),
                    leg.get('entry_delta'), leg.get('security_id'),
                ),
            )
        conn.commit()
        return {"id": strategy_id}
    finally:
        conn.close()


def _row_to_dict(row: sqlite3.Row, parse_json: bool) -> dict:
    d = dict(row)
    if parse_json:
        d['params_json'] = json.loads(d['params_json'])
        d['legs_json'] = json.loads(d['legs_json'])
    return d


def cmd_list() -> dict:
    conn = get_connection()
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT * FROM strategies ORDER BY created_at DESC").fetchall()
        return {"strategies": [_row_to_dict(r, parse_json=False) for r in rows]}
    finally:
        conn.close()


def cmd_get(strategy_id: int) -> dict:
    conn = get_connection()
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM strategies WHERE id = ?", (strategy_id,)).fetchone()
        if row is None:
            return {"error": "not_found"}
        return _row_to_dict(row, parse_json=True)
    finally:
        conn.close()


def cmd_update(strategy_id: int, status: str) -> dict:
    conn = get_connection()
    try:
        now = datetime.now(timezone.utc).isoformat()
        cur = conn.execute(
            "UPDATE strategies SET status = ?, updated_at = ? WHERE id = ?",
            (status, now, strategy_id),
        )
        conn.commit()
        if cur.rowcount == 0:
            return {"error": "not_found"}
        return {"ok": True}
    finally:
        conn.close()


def cmd_delete(strategy_id: int) -> dict:
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM strategies WHERE id = ?", (strategy_id,))
        conn.commit()
        if cur.rowcount == 0:
            return {"error": "not_found"}
        return {"ok": True}
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd')

    sub.add_parser('init')

    p_save = sub.add_parser('save')
    p_save.add_argument('--json', required=True, dest='json_payload')

    sub.add_parser('list')

    p_get = sub.add_parser('get')
    p_get.add_argument('id', type=int)

    p_update = sub.add_parser('update')
    p_update.add_argument('id', type=int)
    p_update.add_argument('--status', required=True, choices=['open', 'closed'])

    p_delete = sub.add_parser('delete')
    p_delete.add_argument('id', type=int)

    args = parser.parse_args()

    if args.cmd == 'init':
        result = cmd_init()
    elif args.cmd == 'save':
        result = cmd_save(json.loads(args.json_payload))
    elif args.cmd == 'list':
        result = cmd_list()
    elif args.cmd == 'get':
        result = cmd_get(args.id)
    elif args.cmd == 'update':
        result = cmd_update(args.id, args.status)
    elif args.cmd == 'delete':
        result = cmd_delete(args.id)
    else:
        result = {"error": "unknown command"}

    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(0)

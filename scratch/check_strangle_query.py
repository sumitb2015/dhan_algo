import sqlite3
from pathlib import Path

db_path = Path("Options Data") / "nifty_options.db"
conn = sqlite3.connect(str(db_path))
cursor = conn.cursor()

query = """
EXPLAIN QUERY PLAN
SELECT expiry, datetime, option_type, strike_relative, open, high, low, close, spot
FROM option_prices
WHERE strike_relative IN ('ATM+1', 'ATM-1', 'ATM+2', 'ATM-2')
  AND datetime >= '2025-09-01'
ORDER BY expiry, datetime, option_type
"""

cursor.execute(query)
for row in cursor.fetchall():
    print(row)

conn.close()

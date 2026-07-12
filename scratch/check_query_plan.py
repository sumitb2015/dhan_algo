import sqlite3
from pathlib import Path

db_path = Path("Options Data") / "nifty_options.db"
conn = sqlite3.connect(str(db_path))
cursor = conn.cursor()

query = """
EXPLAIN QUERY PLAN
SELECT expiry, datetime, option_type, open, high, low, close, spot
FROM option_prices
WHERE strike_relative = 'ATM'
ORDER BY expiry, datetime, option_type
"""

cursor.execute(query)
for row in cursor.fetchall():
    print(row)

# Let's count how many ATM rows there are
print("\nCounting ATM rows...")
cursor.execute("SELECT COUNT(*) FROM option_prices WHERE strike_relative = 'ATM'")
print(f"ATM rows count: {cursor.fetchone()[0]}")

conn.close()

import sqlite3
import time
from pathlib import Path

db_path = Path("Options Data") / "nifty_options.db"
conn = sqlite3.connect(str(db_path))
cursor = conn.cursor()

print("Creating index idx_strike_relative...")
t0 = time.time()
cursor.execute("CREATE INDEX IF NOT EXISTS idx_strike_relative ON option_prices (strike_relative, expiry, datetime, option_type)")
conn.commit()
print(f"Index created in {time.time() - t0:.2f} seconds.")

# Let's explain query plan now
query = """
EXPLAIN QUERY PLAN
SELECT expiry, datetime, option_type, open, high, low, close, spot
FROM option_prices
WHERE strike_relative = 'ATM'
ORDER BY expiry, datetime, option_type
"""
cursor.execute(query)
print("\nNew Query Plan:")
for row in cursor.fetchall():
    print(row)

# Let's test the query performance
print("\nRunning the query and fetching first 10 rows...")
t0 = time.time()
cursor.execute("""
SELECT expiry, datetime, option_type, open, high, low, close, spot
FROM option_prices
WHERE strike_relative = 'ATM'
ORDER BY expiry, datetime, option_type
LIMIT 10
""")
print(cursor.fetchall())
print(f"Fetch first 10 rows took {time.time() - t0:.4f} seconds.")

# Let's test loading into pandas (just to see if it's super fast)
import pandas as pd
print("\nLoading all ATM rows into pandas...")
t0 = time.time()
df = pd.read_sql("""
SELECT expiry, datetime, option_type, open, high, low, close, spot
FROM option_prices
WHERE strike_relative = 'ATM'
ORDER BY expiry, datetime, option_type
""", conn)
print(f"Loaded {len(df):,} rows into pandas in {time.time() - t0:.2f} seconds.")

conn.close()

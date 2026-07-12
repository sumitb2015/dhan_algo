import sqlite3
from pathlib import Path

db_path = Path("Options Data") / "nifty_options.db"
print(f"Checking DB: {db_path.resolve()}")
print(f"Size: {db_path.stat().st_size / (1024 * 1024):.2f} MB")

conn = sqlite3.connect(str(db_path))
cursor = conn.cursor()

# Get list of tables
cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
tables = cursor.fetchall()
print(f"Tables: {tables}")

for table in tables:
    name = table[0]
    print(f"\n--- Table: {name} ---")
    cursor.execute(f"PRAGMA table_info({name});")
    for col in cursor.fetchall():
        print(col)
        
    print(f"\n--- Indexes on {name} ---")
    cursor.execute(f"PRAGMA index_list({name});")
    for idx in cursor.fetchall():
        print(idx)
        # Get SQL for index creation
        cursor.execute(f"SELECT sql FROM sqlite_master WHERE type='index' AND name='{idx[1]}';")
        print(cursor.fetchone()[0])

conn.close()

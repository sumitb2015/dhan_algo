import os
import sys
import time
import sqlite3
import pandas as pd

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_ROOT = os.path.join(PROJECT_ROOT, "Options Data", "NIFTY")
DB_PATH = os.path.join(PROJECT_ROOT, "Options Data", "nifty_options.db")

def create_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("PRAGMA journal_mode = OFF;")
    cursor.execute("PRAGMA synchronous = OFF;")
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS option_prices (
        expiry TEXT,
        datetime TEXT,
        option_type TEXT,
        strike REAL,
        strike_relative TEXT,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        spot REAL,
        volume REAL,
        oi REAL,
        iv REAL,
        PRIMARY KEY (expiry, datetime, option_type, strike)
    );
    """)
    conn.commit()
    conn.close()

def process_file(sf, fname):
    fpath = os.path.join(DATA_ROOT, sf, fname)
    expiry = fname[:-4]
    try:
        df = pd.read_csv(fpath)
        
        cols = df.columns
        for c in ["open", "high", "low", "close", "spot", "volume", "oi", "iv"]:
            if c not in cols:
                df[c] = 0.0
                
        records = []
        dts = df["datetime"].values
        opts = df["option_type"].values
        stks = df["strike"].values
        opens = df["open"].values
        highs = df["high"].values
        lows = df["low"].values
        closes = df["close"].values
        spots = df["spot"].values
        volumes = df["volume"].values
        ois = df["oi"].values
        ivs = df["iv"].values
        
        for dt, opt, stk, o, h, l, c, spot, vol, oi, iv in zip(dts, opts, stks, opens, highs, lows, closes, spots, volumes, ois, ivs):
            records.append((
                expiry,
                str(dt)[:19],  # Normalize to YYYY-MM-DD HH:MM:SS
                str(opt),
                float(stk),
                sf,           # strike_relative folder name
                float(o),
                float(h),
                float(l),
                float(c),
                float(spot),
                float(vol),
                float(oi),
                float(iv)
            ))
        return records
    except Exception as e:
        print(f"Error processing {sf}/{fname}: {e}")
        sys.stdout.flush()
        return []

def main():
    print(f"Project root: {PROJECT_ROOT}")
    print(f"Database path: {DB_PATH}")
    sys.stdout.flush()
    
    start_time = time.time()
    
    # 1. Create DB and Table
    create_db()
    
    # 2. Collect all CSV files
    all_offset_folders = sorted([
        d for d in os.listdir(DATA_ROOT)
        if os.path.isdir(os.path.join(DATA_ROOT, d)) and d.startswith("ATM")
    ])
    
    tasks = []
    for sf in all_offset_folders:
        folder_path = os.path.join(DATA_ROOT, sf)
        csv_files = [f for f in os.listdir(folder_path) if f.endswith(".csv") and len(f) == 14]
        for fname in csv_files:
            tasks.append((sf, fname))
    total_files = len(tasks)
    print(f"Found {total_files} CSV files to process across {len(all_offset_folders)} offset folders.")
    sys.stdout.flush()
    
    # Optimize: Skip files that are already loaded in SQLite
    if os.path.exists(DB_PATH):
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        try:
            cursor.execute("SELECT DISTINCT strike_relative, expiry FROM option_prices")
            existing = {(r[0], r[1]) for r in cursor.fetchall()}
            original_count = len(tasks)
            tasks = [(sf, fname) for sf, fname in tasks if (sf, fname[:-4]) not in existing]
            print(f"Skipping {original_count - len(tasks)} files already in database. Remaining to process: {len(tasks)}")
        except sqlite3.OperationalError:
            pass
        finally:
            conn.close()
    
    sys.stdout.flush()
    
    # 3. Read and parse files sequentially
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode = OFF;")
    conn.execute("PRAGMA synchronous = OFF;")
    cursor = conn.cursor()
    
    batch_records = []
    processed_count = 0
    total_rows = 0
    
    for sf, fname in tasks:
        records = process_file(sf, fname)
        if records:
            batch_records.extend(records)
            total_rows += len(records)
            
        processed_count += 1
        if processed_count % 100 == 0 or processed_count == total_files:
            if batch_records:
                cursor.executemany("""
                INSERT OR IGNORE INTO option_prices 
                (expiry, datetime, option_type, strike, strike_relative, open, high, low, close, spot, volume, oi, iv)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, batch_records)
                conn.commit()
                batch_records.clear()
            print(f"Processed {processed_count}/{total_files} files... Loaded {total_rows} rows.")
            sys.stdout.flush()
            
    # 4. Build Index
    print("Building index for optimal lookup query speeds...")
    sys.stdout.flush()
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_lookup ON option_prices (expiry, datetime, option_type, strike);")
    conn.commit()
    
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_expiry_datetime ON option_prices (expiry, datetime);")
    conn.commit()
    
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_relative ON option_prices (expiry, strike_relative, option_type, datetime);")
    conn.commit()
    
    conn.close()
    
    end_time = time.time()
    print(f"Finished database compilation in {end_time - start_time:.2f} seconds.")
    print(f"Total Rows Imported: {total_rows}")
    print(f"Database size: {os.path.getsize(DB_PATH) / (1024 * 1024):.2f} MB")
    sys.stdout.flush()

if __name__ == "__main__":
    main()

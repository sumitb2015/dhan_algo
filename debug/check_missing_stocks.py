import pandas as pd
import os
import glob

def check_missing_stocks():
    # 1. Load Master List
    master_csv = "MW-NIFTY-500-25-Jan-2026.csv"
    if not os.path.exists(master_csv):
        print(f"Error: Master file {master_csv} not found.")
        return

    try:
        # NSE CSVs usually have 'SYMBOL' column
        # Try utf-8 first, then common windows encodings
        try:
            df_master = pd.read_csv(master_csv, encoding='utf-8')
        except UnicodeDecodeError:
             df_master = pd.read_csv(master_csv, encoding='cp1252')
             
        # Check columns (handle non-ascii for print)
        # print("Master CSV Columns:", df_master.columns.tolist()) 
        cols = [c.encode('ascii', 'ignore').decode('utf-8') for c in df_master.columns]
        print("Master CSV Columns:", cols)
        
        # Adjust column name if needed. Usually 'SYMBOL' or 'Symbol'
        symbol_col = None
        for col in df_master.columns:
            if 'SYMBOL' in col.upper():
                symbol_col = col
                break
        
        if not symbol_col:
            print("Error: Could not find SYMBOL column in master CSV")
            return
            
        master_symbols = set(df_master[symbol_col].apply(lambda x: str(x).strip().upper()))
        print(f"Total Stocks in Master List: {len(master_symbols)}")
        
    except Exception as e:
        print(f"Error reading master CSV: {e}")
        return

    # 2. List Downloaded Files
    data_dir = "Stocks Historical Data Parquet"
    search_pattern = os.path.join(data_dir, "*_1Min_*.parquet")
    
    if not os.path.exists(data_dir):
        # Try finding it relative to script if run elsewhere, but assuming we run from root c:\dhan_algo
        print(f"Error: Data directory {data_dir} not found.")
        return
        
    files = glob.glob(search_pattern)
    print(f"Total Downloaded Files: {len(files)}")
    
    # Extract symbols from filenames: "SYMBOL_1Min_..."
    downloaded_symbols = set()
    for f in files:
        basename = os.path.basename(f)
        symbol = basename.split('_')[0].upper()
        downloaded_symbols.add(symbol)
        
    # 3. specific fixes for naming mismatches (e.g. & vs _ or -)
    # NSE might have 'M&M', filename might be 'M&M' or 'M_M'
    # Let's simple check difference first
    
    missing = master_symbols - downloaded_symbols
    
    # fuzzy check for M&M vs M_M
    # If missing has M&M and downloaded has M&M, fine. 
    # If missing M&M, check if M_M exists in downloaded? No, simpler to just list them.
    
    print("\n" + "="*40)
    print(f"Missing Stocks: {len(missing)}")
    print("="*40)
    
    sorted_missing = sorted(list(missing))
    for s in sorted_missing:
        print(s)
        
    # Extra check: Are there files not in master list?
    extra = downloaded_symbols - master_symbols
    if extra:
        print("\n" + "="*40)
        print(f"Extra/Unknown Files: {len(extra)}")
        print("="*40)
        for s in sorted(list(extra)):
            print(s)

if __name__ == "__main__":
    check_missing_stocks()

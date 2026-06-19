import urllib.request
import csv
import io
import os
import sys

def main():
    url = "https://archives.nseindia.com/content/indices/ind_nifty500list.csv"
    output_path = "MW-NIFTY-500-25-Jan-2026.csv"
    
    print("="*60)
    print("NIFTY 500 SYMBOLS CONSTITUENTS DOWNLOADER")
    print("="*60)
    print(f"Downloading Nifty 500 from: {url}")
    
    req = urllib.request.Request(
        url, 
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    )
    
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            content = response.read().decode('utf-8')
            
        # Parse the NSE CSV format
        reader = csv.DictReader(io.StringIO(content))
        symbols = []
        for row in reader:
            # The column name is "Symbol"
            if 'Symbol' in row:
                symbols.append(row['Symbol'].strip())
                
        if not symbols:
            print("[FAIL] No symbols found in downloaded CSV.")
            return
            
        print(f"[SUCCESS] Downloaded {len(symbols)} symbols.")
        
        # Save to the expected location as a clean CSV
        with open(output_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(["SYMBOL", "COMPANY_NAME"])
            for sym in symbols:
                writer.writerow([sym, ""])
                
        print(f"[SUCCESS] Saved to local CSV: {os.path.abspath(output_path)}")
        print("="*60)
        
    except Exception as e:
        print(f"[CRITICAL] Error downloading or parsing: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()

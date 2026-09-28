import urllib.request
import csv
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib.market_data_hygiene import NIFTY500_LIST  # noqa: E402

# A truncated or error-page download must never replace a good list.
MIN_SYMBOLS = 400

def main():
    url = "https://archives.nseindia.com/content/indices/ind_nifty500list.csv"
    output_path = NIFTY500_LIST
    
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
                
        if len(symbols) < MIN_SYMBOLS:
            print(f"[FAIL] Only {len(symbols)} symbols in the download (expected ~500) - keeping the existing list.")
            sys.exit(1)
            
        print(f"[SUCCESS] Downloaded {len(symbols)} symbols.")
        
        # Save NSE's file verbatim: lib/momentum.py reads its Industry column
        # for the sector cap. Write to a temp file first so a crash mid-write
        # can't leave a half-written list.
        tmp_path = output_path + ".tmp"
        with open(tmp_path, 'w', newline='', encoding='utf-8') as f:
            f.write(content)
        os.replace(tmp_path, output_path)

        print(f"[SUCCESS] Saved to local CSV: {os.path.abspath(output_path)}")
        print("="*60)
        
    except Exception as e:
        print(f"[CRITICAL] Error downloading or parsing: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()

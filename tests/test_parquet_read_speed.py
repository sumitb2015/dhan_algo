import os
import pandas as pd
import time
import logging

# Configure Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')
logger = logging.getLogger(__name__)

def verify_performance(csv_file, parquet_file):
    if not os.path.exists(csv_file) or not os.path.exists(parquet_file):
        logger.error(f"Files not found: {csv_file} or {parquet_file}")
        return

    logger.info(f"Comparing performance for: {os.path.basename(csv_file)}")

    # 1. Measure CSV Load (with Date Parsing for fair comparison)
    start_time = time.time()
    # We parse 'Datetime' to compare apples-to-apples, as Parquet already has datetimes
    df_csv = pd.read_csv(csv_file, low_memory=False, parse_dates=["Datetime"])
    csv_time = time.time() - start_time
    logger.info(f"  CSV Load Time (w/ parsing): {csv_time:.4f}s")
    
    # 2. Measure Parquet Load
    start_time = time.time()
    df_pq = pd.read_parquet(parquet_file)
    pq_time = time.time() - start_time
    logger.info(f"  Parquet Load Time: {pq_time:.4f}s")
    
    # 3. Calculate Speedup
    speedup = csv_time / pq_time if pq_time > 0 else 0
    logger.info(f"  Speedup Factor: {speedup:.2f}x faster")
    
    # 4. Data Integrity Check
    if len(df_csv) == len(df_pq):
        logger.info(f"  [PASS] Row count matches: {len(df_csv)}")
    else:
        logger.error(f"  [FAIL] Row count mismatch! CSV: {len(df_csv)}, Parquet: {len(df_pq)}")

    # Optional: Compare columns
    # We skip exact column type match as Parquet is typed and CSV is inferred
    # But names should match if we handled them correctly
    
    if list(df_csv.columns) == list(df_pq.columns):
         logger.info("  [PASS] Column names match.")
    else:
         logger.warning(f"  [WARN] Column names differ (Datetime check might be needed). {list(df_csv.columns)} vs {list(df_pq.columns)}")

if __name__ == "__main__":
    import sys
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    
    # Default values
    target_file = "AARTIIND_1Min_5Y.csv"
    src_dir = os.path.join(base_dir, "Stocks Historical Data")
    pq_dir = os.path.join(base_dir, "Stocks Historical Data Parquet")

    # Override if arguments provided
    if len(sys.argv) > 1:
        target_file = sys.argv[1]
    
    # If not in Stocks, try General
    if not os.path.exists(os.path.join(src_dir, target_file)):
        src_dir = os.path.join(base_dir, "Historical Data")
        pq_dir = os.path.join(base_dir, "Historical Data Parquet")
    
    csv_path = os.path.join(src_dir, target_file)
    pq_path = os.path.join(pq_dir, target_file.replace(".csv", ".parquet"))
    
    verify_performance(csv_path, pq_path)

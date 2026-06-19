import os
import pandas as pd
import time
import logging

# Configure Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')
logger = logging.getLogger(__name__)

def convert_csv_to_parquet(source_dir, target_dir):
    if not os.path.exists(source_dir):
        logger.error(f"Source directory not found: {source_dir}")
        return

    os.makedirs(target_dir, exist_ok=True)
    
    files = [f for f in os.listdir(source_dir) if f.endswith(".csv")]
    if not files:
        logger.warning(f"No CSV files found in {source_dir}")
        return
        
    logger.info(f"Found {len(files)} CSV files to convert.")
    
    for file in files:
        csv_path = os.path.join(source_dir, file)
        parquet_filename = file.replace(".csv", ".parquet")
        parquet_path = os.path.join(target_dir, parquet_filename)
        
        try:
            logger.info(f"Converting {file}...")
            start_time = time.time()
            
            # Read CSV
            # Low memory mode off to ensure accurate type inference or chunking could be used for huge files
            # But for 30MB files, standard read is fine.
            df = pd.read_csv(csv_path, low_memory=False)
            
            # Type Optimization
            if "Datetime" in df.columns:
                df["Datetime"] = pd.to_datetime(df["Datetime"])
                
            # If timestamps exist in other columns, let's leave them as inferred or convert if standard names
            
            # Save as Parquet
            df.to_parquet(parquet_path, engine='pyarrow', compression='snappy')
            
            duration = time.time() - start_time
            
            # Stats
            csv_size = os.path.getsize(csv_path) / (1024 * 1024) # MB
            parquet_size = os.path.getsize(parquet_path) / (1024 * 1024) # MB
            ratio = (1 - (parquet_size / csv_size)) * 100
            
            logger.info(f"  [DONE] Time: {duration:.2f}s | Size: {csv_size:.2f}MB -> {parquet_size:.2f}MB (Reduced by {ratio:.1f}%)")
            
        except Exception as e:
            logger.error(f"  [FAILED] Could not convert {file}: {e}")

if __name__ == "__main__":
    # Absolute paths relative to script location
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    # Convert General Historical Data
    src = os.path.join(base_dir, "Historical Data")
    dst = os.path.join(base_dir, "Historical Data Parquet")
    convert_csv_to_parquet(src, dst)
    
    # Convert Stocks Historical Data
    src_stocks = os.path.join(base_dir, "Stocks Historical Data")
    dst_stocks = os.path.join(base_dir, "Stocks Historical Data Parquet")
    convert_csv_to_parquet(src_stocks, dst_stocks)

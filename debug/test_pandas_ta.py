
try:
    import pandas_ta as ta
    import pandas as pd
    import numpy as np
    print(f"Pandas-TA successfully imported. Version: {ta.version}")
    
    # Simple calculation test
    df = pd.DataFrame({'Close': np.random.random(100)})
    output = df.ta.sma(length=10)
    print(f"SMA calculation test: Success (Calculated {len(output.dropna())} valid values)")
    
except ImportError:
    print("Pandas-TA is NOT installed in this environment.")
except Exception as e:
    print(f"Pandas-TA is installed but failed with error: {e}")


try:
    import talib
    import numpy as np
    print(f"TA-Lib successfully imported. Version: {talib.__version__}")
    
    # Simple calculation test
    data = np.random.random(100)
    output = talib.SMA(data, timeperiod=10)
    print(f"SMA calculation test: Success (Calculated {len(output)} values)")
    
except ImportError:
    print("TA-Lib is NOT installed in this environment.")
except Exception as e:
    print(f"TA-Lib is installed but failed with error: {e}")

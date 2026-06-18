import pandas as pd
import numpy as np
import pandas_ta as ta

# Create dummy data
df = pd.DataFrame({
    'Open': np.random.random(100),
    'High': np.random.random(100),
    'Low': np.random.random(100),
    'Close': np.random.random(100),
    'Volume': np.random.random(100)
})

st_df = df.ta.supertrend(length=10, multiplier=2)
print("Columns returned by df.ta.supertrend():")
print(st_df.columns.tolist())

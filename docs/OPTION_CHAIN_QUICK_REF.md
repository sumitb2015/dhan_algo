# Option Chain Analysis - Quick Reference

## Updated Helper Function

The `get_expiry_list()` function has been updated to correctly handle the nested data structure from the Dhan API.

---

## ✅ Correct Usage

### Method 1: Using DhanHelper (Recommended)

```python
from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)

# Get expiries (automatically handles nested data)
expiries = helper.get_expiry_list(under_security_id=13, under_exchange_segment="IDX_I")

# Use the expiries
if expiries:
    print(f"Found {len(expiries)} expiries")
    print(f"Nearest expiry: {expiries[0]}")
    
    # Get option chain for nearest expiry
    chain = helper.get_option_chain(13, expiries[0], "IDX_I")
    print(f"Option chain: {len(chain)} strikes")
```

### Method 2: Direct SDK Call

```python
from login import get_dhan_client

dhan = get_dhan_client()

# Direct call (manual data extraction)
expiry_data = dhan.expiry_list(under_security_id=13, under_exchange_segment="IDX_I")

# Extract nested data
if expiry_data.get('status') == 'success':
    expiries_list = expiry_data['data']['data']
    print(expiries_list)
```

---

## 📊 Common Security IDs

| Index | Security ID | Code |
|-------|-------------|------|
| Nifty 50 | 13 | `helper.get_expiry_list(13, "IDX_I")` |
| Bank Nifty | 25 | `helper.get_expiry_list(25, "IDX_I")` |
| Fin Nifty | 27 | `helper.get_expiry_list(27, "IDX_I")` |
| Nifty Midcap Select | 35 | `helper.get_expiry_list(35, "IDX_I")` |
| Sensex | 51 | `helper.get_expiry_list(51, "IDX_I")` |

---

## 🎯 Complete Workflow Example

```python
from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)

# Step 1: Get expiries
expiries = helper.get_expiry_list(13, "IDX_I")

if expiries:
    # Step 2: Get option chain for nearest expiry
    nearest_expiry = expiries[0]
    chain = helper.get_option_chain(13, nearest_expiry, "IDX_I")
    
    # Step 3: Analyze the chain
    if not chain.empty:
        print(f"Total strikes: {len(chain)}")
        print(chain.head())
        
        # Get specific columns if available
        if 'strike_price' in chain.columns:
            strikes = chain['strike_price'].tolist()
            print(f"Available strikes: {strikes}")
```

---

## 🔧 What Changed

### Before (Incorrect):
```python
def get_expiry_list(self, under_security_id: int, under_exchange_segment: str = "IDX_I") -> List[str]:
    res = self.dhan.expiry_list(under_security_id=under_security_id, under_exchange_segment=under_exchange_segment)
    if res.get('status') == 'success':
        return res.get('data', [])  # ❌ Wrong - doesn't handle nested structure
    return []
```

### After (Correct):
```python
def get_expiry_list(self, under_security_id: int, under_exchange_segment: str = "IDX_I") -> List[str]:
    res = self.dhan.expiry_list(under_security_id=under_security_id, under_exchange_segment=under_exchange_segment)
    if res.get('status') == 'success':
        data = res.get('data', {})
        if isinstance(data, dict):
            return data.get('data', [])  # ✅ Correct - handles nested data['data']
        return data if isinstance(data, list) else []
    return []
```

---

## 📝 API Response Structure

The Dhan API returns expiries in this nested structure:

```json
{
  "status": "success",
  "remarks": "",
  "data": {
    "data": [
      "2025-01-30",
      "2025-02-06",
      "2025-02-13",
      ...
    ]
  }
}
```

The helper function now correctly extracts `data['data']` to give you the list of expiry dates directly.

---

## ✅ Testing

Run the test files to verify:

```bash
# Test the updated helper function
python test_updated_expiry.py

# See complete workflow example
python example_option_chain_workflow.py
```

---

## 🎉 Summary

- ✅ Helper function updated to handle nested data structure
- ✅ Works seamlessly with `get_option_chain()`
- ✅ Backward compatible with different response formats
- ✅ Ready to use in your Jupyter notebook and strategies

Use `helper.get_expiry_list()` for clean, simple code that handles all the complexity for you!

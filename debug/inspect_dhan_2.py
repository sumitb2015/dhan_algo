import dhanhq.marketfeed
if hasattr(dhanhq.marketfeed, 'marketfeed'):
    print(f"Items in dhanhq.marketfeed.marketfeed: {dir(dhanhq.marketfeed.marketfeed)}")
else:
    print("dhanhq.marketfeed has no attribute 'marketfeed'")

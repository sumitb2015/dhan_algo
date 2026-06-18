from dhanhq.marketfeed import MarketFeed
print(f"MarketFeed methods: {[m for m in dir(MarketFeed) if not m.startswith('_')]}")

# Strategies

This folder contains all live trading strategies. Each sub-folder has a `strategy.md` with full CLI reference, parameter explanations, and execution examples.

```
strategies/
├── value_imbalance/          # Short straddle / strangle strategies
│   ├── strategy.md           # Covers all four strategies below
│   ├── nifty_advanced_imbalance.py        # 4-mode advanced strategy (winner roll, ratio roll, hedged, legacy)
│   ├── nifty_value_imbalance_straddle.py  # Legacy ATM straddle with lot additions
│   ├── nifty_value_imbalance_strangle.py  # Legacy OTM strangle with strike adjustments
│   └── nifty_vwap_straddle.py             # VWAP mean-reversion short straddle
│
├── expiry/                   # 0DTE expiry-day strategies
│   ├── strategy.md           # Full guide to the expiry strategy
│   └── nifty_expiry.py
│
├── spread_trend/             # Trend-following vertical spread strategy
│   ├── strategy.md           # Full guide to the spread trend strategy
│   └── nifty_spread_trend.py
│
└── Archives/
    └── nifty_short_straddle.py   # Archived basic straddle
```

## Global Rules (all strategies)

- **Intraday auto-exit**: hardcoded between **15:15–15:17 IST** depending on strategy.
- **Dry run by default**: no real orders unless `--live` is passed.
- **Global P&L guards**: `--target-profit` and `--stop-loss` halt the strategy for the day.
- **WebSocket priority**: live prices come from the WebSocket feed; REST is a fallback.
- All commands run from the project root with `venv\Scripts\python.exe`.

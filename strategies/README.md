# Strategies

This folder contains all live trading strategies. Each sub-folder has a `strategy.md` with full CLI reference, parameter explanations, and execution examples.

```
strategies/
├── value_imbalance/          # Short straddle / strangle strategies
│   ├── strategy.md           # Covers all five strategies below
│   ├── nifty_advanced_imbalance.py        # 4-mode advanced strategy (winner roll, ratio roll, hedged, legacy)
│   ├── nifty_value_imbalance_straddle.py  # Legacy ATM straddle with lot additions
│   ├── nifty_value_imbalance_strangle.py  # Legacy OTM strangle with strike adjustments
│   ├── nifty_vwap_1min_straddle.py        # 1-min VWAP mean-reversion short straddle (candle-based)
│   └── nifty_tick_mean_straddle.py        # Tick running-mean mean-reversion short straddle (TWAP-by-tick)
│
├── expiry/                   # 0DTE expiry-day strategies
│   ├── strategy.md           # Full guide to the expiry strategy
│   └── nifty_expiry.py
│
├── spread_trend/             # Trend-following vertical spread strategy
│   ├── strategy.md           # Full guide to the spread trend strategy
│   └── nifty_spread_trend.py
│
├── oi_directional/           # OI imbalance + PCR-driven naked option sell strategy
│   ├── strategy.md           # Full guide to the OI directional strategy
│   └── nifty_oi_directional.py
│
├── crudeoil/                 # MCX CrudeOil Mini futures trend strategy
│   ├── strategy.md           # Full guide to the CrudeOil Supertrend strategy
│   └── crudeoilm_supertrend.py
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

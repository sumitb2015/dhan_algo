# Strategies

This folder contains all live trading strategies. Each sub-folder has a `strategy.md` with full CLI reference, parameter explanations, and execution examples.

```
strategies/
├── value_imbalance/          # Short straddle / strangle strategies
│   ├── strategy.md           # Covers all four strategies below
│   ├── nifty_advanced_imbalance.py        # 4-mode advanced strategy (winner roll, ratio roll, hedged, legacy)
│   ├── nifty_value_imbalance_straddle.py  # Legacy ATM straddle with lot additions
│   ├── nifty_value_imbalance_strangle.py  # Legacy OTM strangle with strike adjustments
│   └── nifty_vwap_1min_straddle.py        # 1-min VWAP mean-reversion short straddle (candle-based)
│
├── spread_trend/             # Trend-following vertical spread strategy
│   ├── strategy.md           # Full guide to the spread trend strategy
│   └── nifty_spread_trend.py
│
├── oi_directional/           # OI imbalance + PCR-driven naked option sell strategy
│   ├── strategy.md           # Full guide to the OI directional strategy
│   └── nifty_oi_directional.py
│
├── crudeoil/                 # MCX CrudeOil Mini futures trend strategies
│   ├── strategy.md           # Full guide to all three CrudeOil strategies
│   ├── crudeoilm_supertrend.py       # Supertrend entries, flat between trades
│   ├── crudeoilm_renko_sar.py        # Renko stop-and-reverse, no daily caps
│   └── crudeoilm_vwap_supertrend.py  # Always-on: long above both ST+VWAP, short below both
│
└── Archives/                 # Retired — not runnable from the dashboard
    ├── nifty_short_straddle.py       # Archived basic straddle
    ├── nifty_expiry.py              # Retired 0DTE expiry-day straddle/strangle
    └── nifty_expiry_strategy.md     # Its full strategy guide
```

## Global Rules (all strategies)

- **Intraday auto-exit**: hardcoded between **15:15–15:17 IST** depending on strategy.
- **Dry run by default**: no real orders unless `--live` is passed.
- **Global P&L guards**: `--target-profit` and `--stop-loss` halt the strategy for the day.
- **WebSocket priority**: live prices come from the WebSocket feed; REST is a fallback.
- All commands run from the project root with `venv\Scripts\python.exe`.

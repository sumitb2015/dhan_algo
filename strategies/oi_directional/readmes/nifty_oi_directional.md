## Summary

Directional Nifty naked-options seller driven by **open-interest imbalance** across the 11
strikes nearest ATM (ATM ±5 × 50 pts). Sells a naked PE when put-writer OI dominance is
expanding (bullish) or a naked CE when call-writer OI dominance is expanding (bearish), holding
only one leg at a time.

## Entry

- Every `--poll-interval` seconds (default **60**), computes `diff = Σ CE_OI − Σ PE_OI` across the 11 monitored strikes.
- **Bullish → sell PE**: when `diff < 0` and shrinking further negative, scans the 11 strikes for PE options with `PCR > --pcr-threshold` (default **1.5**) and sells the strike whose PCR is closest to the threshold from above.
- **Bearish → sell CE**: when `diff > 0` and growing further positive, scans for CE options with `PCR < 1/pcr_threshold` (≈**0.67**) and sells the strike closest to that threshold from below.
- Requires `--expansion-window` (default **3**) OI snapshots before a direction is trusted — first possible entry after `expansion_window × poll_interval` seconds (~9 min by default).
- Only one leg held at a time; no new entry while a position is open. `--lots`, default **1**.
- Session start `--start-time`, default **09:30 IST**.

## Exit

- PCR unwind: exits once the held strike's PCR moves `--exit-pcr-change` (default **30%**) against the entry level — e.g. a PE sold at PCR 1.50 exits once PCR drops to 1.05; a CE sold at PCR 0.67 exits once PCR rises to 0.87.
- Hard intraday square-off at **15:17 IST**.
- Dashboard shutdown trigger honored every loop.

## Target

- Global daily profit target `--target-profit`, default **₹5,000**.

## Stop Loss

- Global daily stop loss `--stop-loss`, default **₹5,000**.

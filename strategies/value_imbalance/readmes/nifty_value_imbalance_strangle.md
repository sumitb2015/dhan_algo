## Summary

Intraday Nifty short OTM strangle. Sells an OTM CE and an OTM PE once their premiums balance,
averages down the winning leg as the market trends, and resets the cycle if spot breaches
either strike's boundary. The strangle counterpart of `nifty_value_imbalance_straddle.py`.

## Entry

- Strike selection is configurable: fixed distance (`--distance`, default; `--ce-offset`/`--pe-offset`, default **200** pts each above/below spot), delta (`--delta`, `--target-delta` default **0.20**), or premium (`--premium`, `--target-premium` default **50.0**).
- Waits for CE/PE premiums to balance within the entry threshold (default **25.0%**) before entering.
- Sells `--lots` (default **1**) of each leg.
- Monitoring starts at `--start-time` (default **09:20** IST).

## Exit

- Value balancing: once imbalance exceeds `--threshold-lot` (default **25.0%**) plus entry offset, sells 1 additional lot on the winning leg (up to `--max-lots`, default **4**).
- Strike adjustment: once max lots is reached and imbalance exceeds `--threshold-strike` (default **40.0%**), shifts the losing leg to a value-matched further-OTM strike.
- Cycle reset: if spot breaches either outer strike boundary, exits all positions, pauses 5 minutes, and restarts a fresh strangle.
- Inversion guard: `CE strike > PE strike` enforced at entry and after every roll; a violation triggers an emergency exit + 5-minute pause + fresh cycle.
- Hard intraday square-off at **15:17 IST**.

## Target

- Global daily profit target `--target-profit`, default **₹4,000**.

## Stop Loss

- Global daily stop loss `--stop-loss`, default **₹4,000**.

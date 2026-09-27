## Summary

Intraday Nifty short ATM straddle. Sells CE and PE at the ATM strike once their premiums
balance, then averages down the winning leg as the market trends and imbalance grows,
resetting the whole cycle if the ATM strike shifts far enough. The simpler, non-mode-selectable
sibling of `nifty_advanced_imbalance.py`'s `winner_roll_atm` mode.

## Entry

- Fetches spot, selects the ATM strike, and waits for CE/PE premiums to balance within `--entry-balance-threshold` (default **15.0%**) before entering.
- Sells `--lots` (default **1**) of ATM CE and ATM PE.
- Monitoring starts at `--start-time` (default **09:20** IST).

## Exit

- Value balancing: once imbalance exceeds `--threshold-lot` (default **25.0%**) plus the entry offset, sells 1 additional lot on the winning leg (up to `--max-lots`, default **4**).
- Strike adjustment: once max lots is reached and imbalance exceeds `--threshold-strike` (default **40.0%**) plus offset, shifts the losing leg to a value-matched further-OTM strike.
- Straddle shift / cycle reset: if the ATM strike shifts ≥100 points from the entry strike, squares off everything, pauses 5 minutes, and restarts.
- Inversion guard: `CE strike > PE strike` enforced at entry and after every roll; a violation triggers an emergency exit + 5-minute pause + fresh cycle.
- Hard intraday square-off at **15:17 IST**.

## Target

- Global daily profit target `--target-profit`, default **₹4,000**.

## Stop Loss

- Global daily stop loss `--stop-loss`, default **₹4,000**.
- Trailing SL: arms once profit reaches `--trail-start-pct` (**5.0%**) of entry combined premium, then exits if the combined premium rises `--trail-gap-pts` (**15.0** pts) above its best level since arming.

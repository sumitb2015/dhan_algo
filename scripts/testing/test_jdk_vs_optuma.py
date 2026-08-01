import pandas as pd
import numpy as np

nifty50 = pd.read_csv('Historical Data/NIFTY_50_Daily_5Y.csv')
bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

nifty50['date'] = nifty50['Datetime'].str.slice(0, 10)
bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

m_n50 = pd.merge(nifty50[['date', 'Close']], nifty500[['date', 'Close']], on='date', suffixes=('_stock', '_bench'))
m_bank = pd.merge(bank[['date', 'Close']], nifty500[['date', 'Close']], on='date', suffixes=('_stock', '_bench'))

results = []

for window in [10, 14, 20, 26, 30, 40, 50, 60, 100, 125]:
    for period in [1, 2, 3, 5, 10, 14]:
        # N50
        rs_n50 = (m_n50['Close_stock'] / m_n50['Close_bench']) * 100.0
        mean_rs = rs_n50.rolling(window).mean()
        std_rs = rs_n50.rolling(window).std(ddof=1)
        ratio_n50 = 100.0 + (rs_n50 - mean_rs) / std_rs

        roc_n50 = 100.0 * ((ratio_n50 / ratio_n50.shift(period)) - 1.0)
        mean_roc = roc_n50.rolling(window).mean()
        std_roc = roc_n50.rolling(window).std(ddof=1)
        mom_n50 = 100.0 + (roc_n50 - mean_roc) / std_roc

        # Bank
        rs_bank = (m_bank['Close_stock'] / m_bank['Close_bench']) * 100.0
        mean_rs_b = rs_bank.rolling(window).mean()
        std_rs_b = rs_bank.rolling(window).std(ddof=1)
        ratio_bank = 100.0 + (rs_bank - mean_rs_b) / std_rs_b

        roc_bank = 100.0 * ((ratio_bank / ratio_bank.shift(period)) - 1.0)
        mean_roc_b = roc_bank.rolling(window).mean()
        std_roc_b = roc_bank.rolling(window).std(ddof=1)
        mom_bank = 100.0 + (roc_bank - mean_roc_b) / std_roc_b

        i_n50_30 = m_n50.index[m_n50['date'] == '2026-07-30'][0]
        i_n50_31 = m_n50.index[m_n50['date'] == '2026-07-31'][0]
        i_bank_28 = m_bank.index[m_bank['date'] == '2026-07-28'][0]
        i_bank_30 = m_bank.index[m_bank['date'] == '2026-07-30'][0]
        i_bank_31 = m_bank.index[m_bank['date'] == '2026-07-31'][0]

        n50_t30, n50_m30 = ratio_n50.iloc[i_n50_30], mom_n50.iloc[i_n50_30]
        n50_t31, n50_m31 = ratio_n50.iloc[i_n50_31], mom_n50.iloc[i_n50_31]

        b_t28, b_m28 = ratio_bank.iloc[i_bank_28], mom_bank.iloc[i_bank_28]
        b_t30, b_m30 = ratio_bank.iloc[i_bank_30], mom_bank.iloc[i_bank_30]
        b_t31, b_m31 = ratio_bank.iloc[i_bank_31], mom_bank.iloc[i_bank_31]

        err = (abs(n50_t30 - 100.41) + abs(n50_m30 - 101.15) +
               abs(n50_t31 - 100.77) + abs(n50_m31 - 101.47) +
               abs(b_t28 - 99.33) + abs(b_m28 - 100.67) +
               abs(b_t30 - 99.60) + abs(b_m30 - 100.80) +
               abs(b_t31 - 99.73) + abs(b_m31 - 100.74))

        results.append((err, f"window={window} period={period}", n50_t30, n50_m30, n50_t31, n50_m31, b_t28, b_m28, b_t30, b_m30, b_t31, b_m31))

results.sort(key=lambda x: x[0])

print("TOP 10 JdK STANDARD MATCHES ACROSS ALL 5 DHAN SCREENSHOT POINTS:")
for err, desc, n50_t30, n50_m30, n50_t31, n50_m31, b_t28, b_m28, b_t30, b_m30, b_t31, b_m31 in results[:10]:
    print(f"\nErr: {err:.4f} | {desc}")
    print(f"   Nifty 50 Jul 30: Trend={n50_t30:.2f}, Mom={n50_m30:.2f} (Dhan: 100.41, 101.15)")
    print(f"   Nifty 50 Jul 31: Trend={n50_t31:.2f}, Mom={n50_m31:.2f} (Dhan: 100.77, 101.47)")
    print(f"   Bank Nifty Jul 28: Trend={b_t28:.2f}, Mom={b_m28:.2f} (Dhan: 99.33, 100.67)")
    print(f"   Bank Nifty Jul 30: Trend={b_t30:.2f}, Mom={b_m30:.2f} (Dhan: 99.60, 100.80)")
    print(f"   Bank Nifty Jul 31: Trend={b_t31:.2f}, Mom={b_m31:.2f} (Dhan: 99.73, 100.74)")

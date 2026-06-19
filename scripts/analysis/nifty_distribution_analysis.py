"""
Script to analyze 5-year daily Nifty data, calculate daily percentage changes,
and generate a professional normal distribution report and chart.
"""
import os
import sys
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import scipy.stats as stats
from datetime import datetime

# Setup paths relative to the script location
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
CSV_PATH = os.path.join(PROJECT_ROOT, "Historical Data", "NIFTY_50_Daily_5Y.csv")
SAVE_DIR = os.path.join(PROJECT_ROOT, "reports")
CHART_PATH = os.path.join(SAVE_DIR, "nifty_normal_distribution.png")
REPORT_PATH = os.path.join(SAVE_DIR, "nifty_distribution_report.md")

def main():
    print(f"\n" + "="*60)
    print("NIFTY 50 DAILY DISTRIBUTION ANALYSIS")
    print("="*60)
    
    # Ensure save directory exists
    os.makedirs(SAVE_DIR, exist_ok=True)
    
    # 1. Load Data
    if not os.path.exists(CSV_PATH):
        print(f"[FAIL] Data file not found: {CSV_PATH}")
        return
        
    print(f">>> Loading historical data from: {CSV_PATH}")
    df = pd.read_csv(CSV_PATH, index_col=0)
    df.index = pd.to_datetime(df.index)
    df = df.sort_index()
    
    total_records = len(df)
    start_date = df.index[0].strftime("%d %b %Y")
    end_date = df.index[-1].strftime("%d %b %Y")
    print(f">>> Loaded {total_records} daily candles from {start_date} to {end_date}.")
    
    # 2. Calculate Daily Change and Percentage Change (Close-to-Close)
    df['Daily_Change_Pts'] = df['Close'] - df['Close'].shift(1)
    df['Daily_Change_Pct'] = df['Close'].pct_change() * 100
    
    # Drop first row containing NaN from shift
    df_clean = df.dropna(subset=['Daily_Change_Pct']).copy()
    
    # 3. Calculate Descriptive Statistics
    returns = df_clean['Daily_Change_Pct'].values
    mean_val = np.mean(returns)
    std_val = np.std(returns)
    min_val = np.min(returns)
    max_val = np.max(returns)
    skewness = stats.skew(returns)
    kurtosis = stats.kurtosis(returns) # Excess Kurtosis (normal = 0)
    
    # Standard Deviation Thresholds
    sd1_low, sd1_high = mean_val - std_val, mean_val + std_val
    sd2_low, sd2_high = mean_val - 2*std_val, mean_val + 2*std_val
    sd3_low, sd3_high = mean_val - 3*std_val, mean_val + 3*std_val
    
    # Count occurrences in standard deviation bands
    within_1sd = np.sum((returns >= sd1_low) & (returns <= sd1_high))
    within_2sd = np.sum((returns >= sd2_low) & (returns <= sd2_high))
    within_3sd = np.sum((returns >= sd3_low) & (returns <= sd3_high))
    
    pct_1sd = (within_1sd / len(returns)) * 100
    pct_2sd = (within_2sd / len(returns)) * 100
    pct_3sd = (within_3sd / len(returns)) * 100
    
    print("\n" + "-"*40)
    print(f"DESCRIPTIVE STATISTICS (Daily % Returns)")
    print("-"*40)
    print(f"Mean (Daily Return)       : {mean_val:+.4f}%")
    print(f"Standard Deviation (1 SD) : {std_val:.4f}%")
    print(f"2 Standard Deviations (2SD): {2*std_val:.4f}%")
    print(f"Skewness                  : {skewness:.4f}")
    print(f"Excess Kurtosis           : {kurtosis:.4f} (Fatter tails than normal distribution)")
    print(f"Minimum Daily Return      : {min_val:+.2f}% on {df_clean['Daily_Change_Pct'].idxmin().strftime('%Y-%m-%d')}")
    print(f"Maximum Daily Return      : {max_val:+.2f}% on {df_clean['Daily_Change_Pct'].idxmax().strftime('%Y-%m-%d')}")
    print("-"*40)
    print(f"Empirical vs. Theoretical (Normal) Distribution:")
    print(f"Within 1 SD ({sd1_low:.2f}% to {sd1_high:.2f}%): {pct_1sd:.2f}% (Theoretical: 68.27%)")
    print(f"Within 2 SD ({sd2_low:.2f}% to {sd2_high:.2f}%): {pct_2sd:.2f}% (Theoretical: 95.45%)")
    print(f"Within 3 SD ({sd3_low:.2f}% to {sd3_high:.2f}%): {pct_3sd:.2f}% (Theoretical: 99.73%)")
    
    # Top 5 Outliers (Gains and Losses)
    top_gains = df_clean.sort_values(by='Daily_Change_Pct', ascending=False).head(5)
    top_losses = df_clean.sort_values(by='Daily_Change_Pct', ascending=True).head(5)
    
    # 4. Create Normal Distribution Chart
    print("\n>>> Generating Normal Distribution Chart...")
    plt.style.use('seaborn-v0_8-whitegrid' if 'seaborn-v0_8-whitegrid' in plt.style.available else 'default')
    
    fig, ax = plt.subplots(figsize=(12, 7), dpi=300)
    
    # Plot histogram of actual daily returns
    count, bins, ignored = ax.hist(returns, bins=80, density=True, alpha=0.45, color='#2b5c8f', edgecolor='#1d3f66', label='Actual Daily Returns Histogram')
    
    # Plot fitted normal distribution curve
    x_range = np.linspace(min_val - 0.5, max_val + 0.5, 1000)
    y_normal = stats.norm.pdf(x_range, mean_val, std_val)
    ax.plot(x_range, y_normal, color='#d32f2f', linewidth=2.5, label=fr'Fitted Normal Curve ($\mu$={mean_val:.3f}%, $\sigma$={std_val:.3f}%)')
    
    # Highlight Standard Deviation Regions
    # 1 SD region shading
    x_1sd = np.linspace(sd1_low, sd1_high, 500)
    ax.fill_between(x_1sd, stats.norm.pdf(x_1sd, mean_val, std_val), color='#4caf50', alpha=0.25, label=f'1 SD Band ({pct_1sd:.1f}% of days)')
    
    # 2 SD region shading
    x_2sd_left = np.linspace(sd2_low, sd1_low, 300)
    x_2sd_right = np.linspace(sd1_high, sd2_high, 300)
    ax.fill_between(x_2sd_left, stats.norm.pdf(x_2sd_left, mean_val, std_val), color='#ff9800', alpha=0.18, label=f'2 SD Band ({pct_2sd - pct_1sd:.1f}% of days)')
    ax.fill_between(x_2sd_right, stats.norm.pdf(x_2sd_right, mean_val, std_val), color='#ff9800', alpha=0.18)
    
    # Draw vertical lines for Mean and SDs
    ax.axvline(mean_val, color='#1d3f66', linestyle='--', linewidth=1.5, label=fr'Mean ($\mu$): {mean_val:+.3f}%')
    
    ax.axvline(sd1_low, color='#388e3c', linestyle=':', linewidth=1.5, label=fr'$\pm$1 SD: {sd1_low:+.2f}% / {sd1_high:+.2f}%')
    ax.axvline(sd1_high, color='#388e3c', linestyle=':', linewidth=1.5)
    
    ax.axvline(sd2_low, color='#f57c00', linestyle=':', linewidth=1.5, label=fr'$\pm$2 SD: {sd2_low:+.2f}% / {sd2_high:+.2f}%')
    ax.axvline(sd2_high, color='#f57c00', linestyle=':', linewidth=1.5)
    
    # Add title and labels
    ax.set_title("NIFTY 50 Daily Percentage Returns Distribution vs. Normal Curve\n(5 Years Historical Analysis)", fontsize=14, fontweight='bold', pad=15)
    ax.set_xlabel("Daily Percentage Change (%)", fontsize=11, labelpad=10)
    ax.set_ylabel("Probability Density", fontsize=11, labelpad=10)
    
    # Add Statistics Annotation box
    std_pct_str = f'{std_val:.3f}%'
    stats_box = (
        f"**Historical Stats**\n"
        f"Days Analyzed: {len(returns)}\n"
        f"Daily Mean: {mean_val:+.3f}%\n"
        f"Daily 1 SD: {std_pct_str}\n"
        f"Skewness: {skewness:.2f}\n"
        f"Excess Kurtosis: {kurtosis:.2f}"
    )
    # Replace markdown bold syntax with plain text for matplotlib
    plain_stats_box = stats_box.replace("**", "")
    ax.text(0.02, 0.95, plain_stats_box, transform=ax.transAxes, verticalalignment='top',
            bbox=dict(boxstyle='round,pad=0.6', facecolor='#f5f5f5', edgecolor='#cfd8dc', alpha=0.9), fontsize=10)
    
    # Formatting axes and layout
    ax.set_xlim(-4.5, 4.5)  # Limit X-axis to keep visualization readable
    ax.legend(loc='upper right', frameon=True, facecolor='white', framealpha=0.9, edgecolor='#cfd8dc', fontsize=9.5)
    
    plt.tight_layout()
    plt.savefig(CHART_PATH, dpi=300)
    plt.close()
    print(f"[SUCCESS] Normal distribution chart saved to: {CHART_PATH}")
    
    # 5. Generate Markdown Report
    print("\n>>> Generating Markdown Report...")
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write(f"# NIFTY 50 Return Distribution & Volatility Analysis\n\n")
        f.write(f"This report presents a statistical analysis of the daily percentage returns of the **NIFTY 50 Index** over a 5-year period from **{start_date}** to **{end_date}**. The analysis evaluates volatility and compares actual returns with a theoretical Normal (Gaussian) distribution.\n\n")
        
        f.write(f"## Key Parameters Summary\n")
        f.write(f"| Metric | Value | Description |\n")
        f.write(f"| :--- | :--- | :--- |\n")
        f.write(f"| **Total Trading Days** | {len(returns)} | Number of days analyzed |\n")
        f.write(f"| **Mean Daily Return** | {mean_val:+.4f}% | Daily mathematical average (center of distribution) |\n")
        f.write(f"| **1 Standard Deviation (1 SD)** | {std_val:.4f}% | Standard measure of daily volatility |\n")
        f.write(f"| **2 Standard Deviations (2 SD)** | {2*std_val:.4f}% | Volatility boundary representing 2 sigma |\n")
        f.write(f"| **Skewness** | {skewness:.4f} | Measure of return asymmetry (near 0 is symmetric) |\n")
        f.write(f"| **Excess Kurtosis** | {kurtosis:.4f} | Tail thickness relative to normal distribution (excess > 0 indicates fat tails) |\n\n")
        
        f.write(f"## Volatility and Standard Deviation Bands\n")
        f.write(f"Standard deviation defines the expected price movement boundaries for the Nifty index. The empirical (actual) distribution of daily returns is compared against the theoretical normal distribution below:\n\n")
        
        f.write(f"| Standard Deviation Band | Percentage Range | Actual Count of Days | Actual Percentage | Theoretical Percentage (Normal Dist) |\n")
        f.write(f"| :--- | :--- | :--- | :--- | :--- |\n")
        f.write(f"| **Within 1 SD** | {sd1_low:+.2f}% to {sd1_high:+.2f}% | {within_1sd} / {len(returns)} | **{pct_1sd:.2f}%** | 68.27% |\n")
        f.write(f"| **Within 2 SD** | {sd2_low:+.2f}% to {sd2_high:+.2f}% | {within_2sd} / {len(returns)} | **{pct_2sd:.2f}%** | 95.45% |\n")
        f.write(f"| **Within 3 SD** | {sd3_low:+.2f}% to {sd3_high:+.2f}% | {within_3sd} / {len(returns)} | **{pct_3sd:.2f}%** | 99.73% |\n\n")
        
        f.write(f"### Key Observations on Distribution Shape\n")
        if kurtosis > 0:
            f.write(f"- **Fat-Tailed Distribution (Leptokurtic)**: The Excess Kurtosis of `{kurtosis:.2f}` is positive, meaning that daily returns exhibit significantly fatter tails than a theoretical Normal distribution. This implies that extreme tail risk events (huge single-day moves) occur much more frequently in reality than standard normal statistics would predict.\n")
        if abs(skewness) > 0.1:
            skew_desc = "left-skewed (negative skew)" if skewness < 0 else "right-skewed (positive skew)"
            f.write(f"- **Asymmetry (Skewness)**: The distribution is `{skew_desc}` with a skew of `{skewness:.2f}`. This indicates a minor imbalance in tail moves (e.g., negative skew indicates a tendency toward sudden large selloffs compared to upside moves).\n")
        f.write(f"- **Option Writer Risk implications**: Since actual returns outside the 2 SD boundary occur in `{100 - pct_2sd:.2f}%` of cases (compared to a theoretical `{100 - 95.45:.2f}%` for normal distribution), options trading strategies relying strictly on normal distribution probability understate tail risk.\n\n")
        
        f.write(f"## Distribution Chart\n")
        f.write(f"The visualization below illustrates the distribution histogram of daily returns against the fitted normal curve. Standard deviation bands (1 SD and 2 SD) are shaded for clarity.\n\n")
        
        # Relative link for standard markdown display, and absolute path for reference
        f.write(f"![Nifty Return Distribution Plot](nifty_normal_distribution.png)\n")
        f.write(f"*(Absolute Path: [nifty_normal_distribution.png](file:///{CHART_PATH.replace(os.sep, '/')}))*\n\n")
        
        f.write(f"## Outlier Days Analysis\n")
        f.write(f"Here are the top 5 largest single-day gains and losses recorded over the past 5 years.\n\n")
        
        f.write(f"### Top 5 Biggest Single-Day Gains\n")
        f.write(f"| Rank | Date | Nifty Close | Daily Change (Pts) | Daily Change (%) |\n")
        f.write(f"| :--- | :--- | :--- | :--- | :--- |\n")
        for i, (idx, row) in enumerate(top_gains.iterrows()):
            f.write(f"| {i+1} | {idx.strftime('%Y-%m-%d')} | {row['Close']:.2f} | {row['Daily_Change_Pts']:+.2f} | **{row['Daily_Change_Pct']:+.2f}%** |\n")
        f.write("\n")
        
        f.write(f"### Top 5 Biggest Single-Day Losses\n")
        f.write(f"| Rank | Date | Nifty Close | Daily Change (Pts) | Daily Change (%) |\n")
        f.write(f"| :--- | :--- | :--- | :--- | :--- |\n")
        for i, (idx, row) in enumerate(top_losses.iterrows()):
            f.write(f"| {i+1} | {idx.strftime('%Y-%m-%d')} | {row['Close']:.2f} | {row['Daily_Change_Pts']:+.2f} | **{row['Daily_Change_Pct']:+.2f}%** |\n")
            
    print(f"[SUCCESS] Markdown report generated at: {REPORT_PATH}")
    print("="*60 + "\n")

if __name__ == "__main__":
    main()

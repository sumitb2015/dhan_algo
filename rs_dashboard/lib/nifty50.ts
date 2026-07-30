// Nifty 50 constituent symbols (NSE symbols matching Daily_Historical_Data_Fresh filenames)
// As of 2025 — update as index reconstitutions happen
export const NIFTY50_SYMBOLS: string[] = [
  'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK',
  'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV', 'BHARTIARTL', 'BPCL',
  'BRITANNIA', 'CIPLA', 'COALINDIA', 'DIVISLAB', 'DRREDDY',
  'EICHERMOT', 'ETERNAL', 'GRASIM', 'HCLTECH', 'HDFCBANK',
  'HDFCLIFE', 'HEROMOTOCO', 'HINDALCO', 'HINDUNILVR', 'ICICIBANK',
  'INDUSINDBK', 'INFY', 'ITC', 'JIOFIN', 'KOTAKBANK',
  'LT', 'M&M', 'MARUTI', 'NESTLEIND', 'NTPC',
  'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SBIN',
  'SHRIRAMFIN', 'SUNPHARMA', 'TATACONSUM', 'TATASTEEL',
  'TCS', 'TECHM', 'TITAN', 'TMPV', 'ULTRACEMCO', 'WIPRO',
];

export const NIFTY50_SET = new Set(NIFTY50_SYMBOLS);

export interface NiftyWeight {
  /** NSE trading symbol — must exist in NIFTY50_SYMBOLS above, and in the
   *  matching list in scripts/tools/live_equity_ws.py, or the row will never
   *  receive a quote. */
  symbol: string;
  /** Short display name — the full company name is too wide for a compact table. */
  name: string;
  /** Index weight, percent. */
  weight: number;
}

// Top 10 NIFTY 50 constituents by index weightage — together ~53% of the index,
// so these names drive most of the index's intraday direction.
//
// Weightage is used rather than raw market cap because the index is
// free-float weighted: weight is what actually determines a stock's pull on
// NIFTY, which is the question a scalper is asking.
//
// Hand-maintained, same convention as NIFTY50_SYMBOLS above — refresh when NSE
// republishes weights or the index is reconstituted.
export const NIFTY_TOP10_BY_WEIGHT: NiftyWeight[] = [
  { symbol: 'HDFCBANK',   name: 'HDFC Bank',     weight: 11.18 },
  { symbol: 'ICICIBANK',  name: 'ICICI Bank',    weight:  9.01 },
  { symbol: 'RELIANCE',   name: 'Reliance',      weight:  8.00 },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel', weight:  5.15 },
  { symbol: 'LT',         name: 'L&T',           weight:  4.44 },
  { symbol: 'SBIN',       name: 'SBI',           weight:  3.88 },
  { symbol: 'AXISBANK',   name: 'Axis Bank',     weight:  3.54 },
  { symbol: 'INFY',       name: 'Infosys',       weight:  3.21 },
  { symbol: 'KOTAKBANK',  name: 'Kotak Bank',    weight:  2.64 },
  { symbol: 'ITC',        name: 'ITC',           weight:  2.53 },
];

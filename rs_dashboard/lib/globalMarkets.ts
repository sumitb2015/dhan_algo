// Non-Indian markets on /markets, sourced from Yahoo Finance (not Dhan).
// `unit` is appended to displayed levels — yields are quoted in percent.
export interface GlobalMarket { key: string; label: string; csv: string; unit: string }

export const GLOBAL_MARKETS: GlobalMarket[] = [
  { key: 'DXY',   label: 'US Dollar Index (DXY)',  csv: 'US_DOLLAR_INDEX_Daily.csv', unit: '' },
  { key: 'US10Y', label: 'US 10Y Treasury Yield',  csv: 'US_10Y_YIELD_Daily.csv',    unit: '%' },
  { key: 'US30Y', label: 'US 30Y Treasury Yield',  csv: 'US_30Y_YIELD_Daily.csv',    unit: '%' },
];

export const GLOBAL_BY_KEY: Record<string, GlobalMarket> =
  Object.fromEntries(GLOBAL_MARKETS.map(m => [m.key, m]));

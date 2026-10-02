// Non-Indian markets on /markets, sourced from Yahoo Finance (not Dhan).
// `unit` is appended to displayed levels — yields are quoted in percent.
export interface GlobalMarket { key: string; label: string; csv: string; unit: string; group: 'Currency' | 'Bond yield' | 'US equity' | 'Asia' | 'Europe' }

export const GLOBAL_MARKETS: GlobalMarket[] = [
  { key: 'DXY',   label: 'US Dollar Index (DXY)',  csv: 'US_DOLLAR_INDEX_Daily.csv', unit: '', group: 'Currency' },
  { key: 'US10Y', label: 'US 10Y Yield',  csv: 'US_10Y_YIELD_Daily.csv',    unit: '%', group: 'Bond yield' },
  { key: 'US30Y', label: 'US 30Y Yield',  csv: 'US_30Y_YIELD_Daily.csv',    unit: '%', group: 'Bond yield' },
  { key: 'DJI',    label: 'Dow Jones',              csv: 'US_DOW_JONES_Daily.csv',    unit: '', group: 'US equity' },
  { key: 'NASDAQ', label: 'Nasdaq Composite',       csv: 'US_NASDAQ_Daily.csv',       unit: '', group: 'US equity' },
  { key: 'SPX',    label: 'S&P 500',                csv: 'US_SP500_Daily.csv',        unit: '', group: 'US equity' },
  { key: 'N225',     label: 'Nikkei 225',         csv: 'JP_NIKKEI_225_Daily.csv',    unit: '', group: 'Asia' },
  { key: 'HSI',      label: 'Hang Seng',          csv: 'HK_HANG_SENG_Daily.csv',     unit: '', group: 'Asia' },
  { key: 'SSEC',     label: 'Shanghai Composite', csv: 'CN_SHANGHAI_Daily.csv',      unit: '', group: 'Asia' },
  { key: 'KS11',     label: 'KOSPI',              csv: 'KR_KOSPI_Daily.csv',         unit: '', group: 'Asia' },
  { key: 'AXJO',     label: 'ASX 200',            csv: 'AU_ASX_200_Daily.csv',       unit: '', group: 'Asia' },
  { key: 'FTSE',     label: 'FTSE 100',           csv: 'UK_FTSE_100_Daily.csv',      unit: '', group: 'Europe' },
  { key: 'GDAXI',    label: 'DAX',                csv: 'DE_DAX_Daily.csv',           unit: '', group: 'Europe' },
  { key: 'FCHI',     label: 'CAC 40',             csv: 'FR_CAC_40_Daily.csv',        unit: '', group: 'Europe' },
  { key: 'STOXX50E', label: 'Euro Stoxx 50',      csv: 'EU_EURO_STOXX_50_Daily.csv', unit: '', group: 'Europe' },
];

export const GLOBAL_BY_KEY: Record<string, GlobalMarket> =
  Object.fromEntries(GLOBAL_MARKETS.map(m => [m.key, m]));

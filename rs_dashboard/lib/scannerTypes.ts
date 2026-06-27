// Shared scanner types — no server-only imports here so client components can use them.

export interface ScannerParams {
  rsiPeriod: number;
  emaPeriod1: number;
  emaPeriod2: number;
  emaPeriod3: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  stPeriod: number;
  stMultiplier: number;
  bbPeriod: number;
  adxPeriod: number;
  atrPeriod: number;
  volMaPeriod: number;
}

export const DEFAULT_SCANNER_PARAMS: ScannerParams = {
  rsiPeriod: 14,
  emaPeriod1: 20,
  emaPeriod2: 50,
  emaPeriod3: 200,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  stPeriod: 7,
  stMultiplier: 3,
  bbPeriod: 20,
  adxPeriod: 14,
  atrPeriod: 14,
  volMaPeriod: 20,
};

export interface ScannerResult {
  symbol: string;
  sector: string;
  latestClose: number;
  latestDate: string;

  // EMA (periods from params.emaPeriod1/2/3)
  ema20: number;
  ema50: number;
  ema200: number;
  aboveEma20: boolean;
  aboveEma50: boolean;
  aboveEma200: boolean;
  ema20AboveEma50: boolean;
  ema50AboveEma200: boolean;

  // RSI
  rsi14: number;

  // MACD
  macdLine: number;
  macdSignal: number;
  macdHistogram: number;
  macdBullish: boolean;
  macdCrossover: boolean;

  // ADX
  adx14: number;
  plusDI: number;
  minusDI: number;

  // Supertrend
  supertrendBullish: boolean;

  // Bollinger Bands
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  bbExpanding: boolean;

  // ATR
  atr14: number;
  atrExpanding: boolean;

  // Volume
  latestVolume: number;
  avgVolume20D: number;
  volumeRatio: number;

  // NR patterns
  isNR4: boolean;
  isNR7: boolean;

  // RS vs benchmark
  rsRatio: number;
  rsRising20: boolean;
  rsAboveMA: boolean;
  rsScore: number;

  // Price changes
  priceChange1D: number;
  priceChange1W: number;
  priceChange1M: number;
  priceChange3M: number;

  // Composite score
  score: number;
  scorePercent: number;
}

export interface ScannerResponse {
  results: ScannerResult[];
  dataDate: string;
  universe: string;
  totalScanned: number;
  params: ScannerParams;
}

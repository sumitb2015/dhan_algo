export type StrategyType =
  | 'bull_put_spread'
  | 'bear_call_spread'
  | 'iron_condor'
  | 'iron_butterfly'
  | 'short_strangle'
  | 'short_straddle'
  | 'jade_lizard'
  | 'reverse_jade_lizard'
  | 'naked_put'
  | 'naked_call';

export type RiskProfile = 'conservative' | 'moderate' | 'aggressive' | 'all';
export type UnderlyingType = 'NIFTY' | 'SENSEX' | 'BANKNIFTY';

export interface ScannedLeg {
  strike: number;
  option: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  ltp: number;
  lots: number;
  lotSize: number;
  delta?: number;
  iv?: number;
  oi?: number;
  oiChange?: number;
  securityId?: string;
}

export interface ScannedStrategy {
  id: string;
  name: string;
  type: StrategyType;
  underlying: UnderlyingType;
  expiry: string;
  dte: number;
  spot: number;
  legs: ScannedLeg[];
  netPremium: number;         // Total net credit in ₹ (for 1 lot default or selected lots)
  netPremiumPoints: number;   // Net premium in index points
  estMargin: number;          // Margin requirement in ₹ — a flat per-strategy estimate
                               // unless marginSource is 'live'
  marginSource?: 'live' | 'estimate'; // 'live' = priced via Dhan's multi-leg margin
                               // calculator for this exact combo; absent/'estimate' =
                               // flat formula, not the real netted SPAN+exposure figure
  romPct: number;             // Return on Margin % per expiry cycle
  romAnnualizedPct: number;   // Annualized RoM %
  distancePct: number;        // Short strike distance from spot (% OTM)
  distancePoints: number;     // Short strike distance from spot (points)
  popPct: number;             // Probability of Profit % (0-100)
  maxProfit: number;          // Maximum potential profit in ₹
  maxLoss: number;            // Maximum potential loss in ₹ (negative or 0 if unlimited)
  maxLossUnlimited: boolean;  // True if naked / undefined risk
  riskRewardRatio: number;    // Risk to reward ratio (Max Loss / Max Profit)
  breakevens: number[];       // [Lower Breakeven, Upper Breakeven]
  deltaNet: number;           // Net position delta
  sentiment: 'Bullish' | 'Bearish' | 'Neutral' | 'Range-Bound';
  riskTier: 'Conservative' | 'Moderate' | 'Aggressive';
  score: number;              // Composite ranking score (0-100)
  createdAt: string;
}

export interface WatchlistItem extends ScannedStrategy {
  targetProfitPct: number;     // e.g. 50% of max profit
  stopLossPct: number;         // e.g. 100% of credit received
  trailingSl: boolean;
  trailingSlOffsetPct?: number;// e.g. 20%
  expiryAutoExitTime: string;  // e.g. "15:15"
  orderType: 'MARKET' | 'LIMIT';
  status: 'WATCHING' | 'ARMED' | 'ENTERED' | 'EXITED' | 'ARCHIVED';
  currentNetPremium?: number;  // Live calculated net premium
  currentPnl?: number;         // Live P&L in ₹ since watchlist add
  currentPnlPct?: number;      // Live P&L % of max profit
  notes?: string;
  addedAt: string;
  lastUpdated: string;
}

export interface ScanFilters {
  underlying: UnderlyingType;
  expiry?: string;
  minRom: number;              // Minimum RoM % (e.g. 1.5%)
  minDistancePct: number;      // Minimum distance from spot % (e.g. 1.0%)
  maxDistancePct: number;      // Maximum distance from spot % (e.g. 6.0%)
  riskProfile: RiskProfile;
  strategyTypes: StrategyType[];
  maxResults: number;
  sortBy: 'rom' | 'pop' | 'score' | 'premium' | 'distance';
}

export interface ScanResponse {
  success: boolean;
  error?: string;
  spotPrices: Record<string, number>;
  vix: {
    vix: number;
    prevClose: number;
    change: number;
    changePct: number;
    regime: string;
    advice: string;
  };
  scannedCount: number;
  combosEvaluated: number;
  shortlistedCount: number;
  candidates: ScannedStrategy[];
  dataDate?: string;
}

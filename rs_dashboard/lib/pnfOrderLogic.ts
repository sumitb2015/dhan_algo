// Pure validation, sizing, and simulation logic for Point & Figure trade orders.
// Tested in lib/pnfOrderLogic.test.ts without Next.js runtime dependencies.

export const MAX_PNF_LOTS = 20;

export interface PnfLegInput {
  securityId: string;
  segment: string;
  instrument?: string;
  lot?: number;
  displayName?: string;
  tradingSymbol?: string;
  expiry?: string;
  strike?: number;
  optionType?: 'CE' | 'PE';
  underlying?: string;
}

export interface PnfOrderBody {
  broker: 'dhan' | 'kotak' | 'zerodha';
  mode: 'PAPER' | 'REAL';
  action: 'BUY' | 'SELL';
  productType: 'INTRADAY' | 'MARGIN' | 'CNC';
  lots: number;
  legs: PnfLegInput[];
  idempotencyKey?: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  lotsNum: number;
}

export function validatePnfOrder(body: Partial<PnfOrderBody>): ValidationResult {
  const { action, lots, legs } = body;
  if (action !== 'BUY' && action !== 'SELL') {
    return { valid: false, error: 'Action must be BUY or SELL', lotsNum: 0 };
  }
  if (!Array.isArray(legs) || legs.length === 0 || legs.length > 2) {
    return { valid: false, error: 'Orders must have 1 or 2 legs', lotsNum: 0 };
  }
  for (const leg of legs) {
    if (!leg || !leg.securityId || !leg.segment) {
      return { valid: false, error: 'Each leg must specify a securityId and segment', lotsNum: 0 };
    }
  }

  const lotsNum = parseInt(String(lots), 10);
  if (!Number.isInteger(lotsNum) || lotsNum < 1) {
    return { valid: false, error: 'Lots/quantity must be a positive integer', lotsNum: 0 };
  }
  if (lotsNum > MAX_PNF_LOTS) {
    return {
      valid: false,
      error: `Order exceeds max allowed size of ${MAX_PNF_LOTS} lots`,
      lotsNum,
    };
  }

  return { valid: true, lotsNum };
}

/** Computes whole-order quantity based on broker, segment, and lot size. */
export function calculateLegQty(leg: PnfLegInput, lots: number, broker: 'dhan' | 'kotak' | 'zerodha'): number {
  const isMcx = leg.segment === 'MCX_COMM';
  const isEq = leg.segment === 'NSE_EQ';
  if (isEq) return lots;
  if (isMcx && (broker === 'dhan' || broker === 'zerodha')) {
    // Dhan & Zerodha order MCX in lots
    return lots;
  }
  const unitLot = leg.lot && leg.lot > 0 ? leg.lot : 1;
  return lots * unitLot;
}

export interface SimulatedFill {
  leg: string;
  securityId: string;
  side: 'BUY' | 'SELL';
  lots: number;
  quantity: number;
  orderId: string;
  status: 'FILLED';
}

export function buildPaperFills(legs: PnfLegInput[], action: 'BUY' | 'SELL', lots: number, broker: 'dhan' | 'kotak' | 'zerodha'): SimulatedFill[] {
  const now = Date.now();
  return legs.map((leg, i) => ({
    leg: leg.displayName ?? leg.tradingSymbol ?? leg.securityId,
    securityId: leg.securityId,
    side: action,
    lots,
    quantity: calculateLegQty(leg, lots, broker),
    orderId: `sim-pnf-${now}-${i + 1}`,
    status: 'FILLED',
  }));
}

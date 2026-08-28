// Shared types for the MCX Crude Oil options terminal.
// The container (components/CrudeOilOptions.tsx) owns all state and fetching;
// everything under components/crudeoil/ is presentational and takes these shapes.

import type React from 'react';

export interface OptionSide {
  last_price?: number;
  oi?: number;
  previous_oi?: number;
  implied_volatility?: number;
  greeks?: { iv?: number };
  volume?: number;
  security_id?: string | number;
}

export interface RawChainEntry { ce?: OptionSide; pe?: OptionSide }

export interface ProcessedRow {
  strike: number;
  ce: OptionSide | null;
  pe: OptionSide | null;
  ceOIPct: number;
  peOIPct: number;
  pcr: number | null;
  straddle: number;        // CE LTP + PE LTP
  isATM: boolean;
  isMaxCEOI: boolean;
  isMaxPEOI: boolean;
  isMinStraddle: boolean;
}

export interface CrudePosition {
  symbol: string;
  securityId?: string;
  /** Kotak's order join key — Dhan is the only broker that routes by securityId. */
  tradingSymbol?: string;
  exchangeSegment?: string;
  positionType: string;
  /** Broker's raw product code — Dhan: INTRADAY/MARGIN; Kotak: MIS/NRML. */
  productType?: string;
  /**
   * Dhan reports this in LOTS (its MCX lot size is 1); Kotak reports ABSOLUTE
   * quantity (100 per CRUDEOIL lot, 10 per CRUDEOILM). Always exit with this
   * number verbatim — converting it is how you send 100x the intended size.
   */
  netQty: number;
  /** Units per lot on the reporting broker: 1 on Dhan, 100/10 on Kotak. */
  lotSize?: number;
  buyAvg: number;
  sellAvg: number;
  lastPrice: number;
  realizedProfit: number;
  unrealizedProfit: number;
}

export interface CrudeOrder {
  orderId: string;
  symbol: string;
  exchange: string;
  orderType: string;
  transactionType: string;
  productType: string;
  quantity: number;
  filledQty: number;
  price: number;
  triggerPrice: number;
  tradedPrice: number;
  status: string;
  validity: string;
  createTime: string;
  updateTime: string;
}

export interface CrudeTrade {
  orderId: string;
  symbol: string;
  exchange: string;
  transactionType: string;
  productType: string;
  tradedQuantity: number;
  tradedPrice: number;
  tradeId: string;
  createTime: string;
  exchangeTime: string;
}

/** Aggregate chain statistics recomputed on every poll. */
export interface ChainStats {
  atm: number;
  pcr: number | null;
  maxPain: number | null;
  totalCEOI: number;
  totalPEOI: number;
  totalCEVol: number;
  totalPEVol: number;
  atmStraddle: number | null;
  atmCeIV: number | null;
  atmPeIV: number | null;
  /** Highest call-OI strike across the *whole* chain — the resistance wall. */
  resistanceStrike: number | null;
  resistanceOI: number;
  /** Highest put-OI strike across the *whole* chain — the support wall. */
  supportStrike: number | null;
  supportOI: number;
}

export const EMPTY_CHAIN_STATS: ChainStats = {
  atm: 0,
  pcr: null,
  maxPain: null,
  totalCEOI: 0,
  totalPEOI: 0,
  totalCEVol: 0,
  totalPEVol: 0,
  atmStraddle: null,
  atmCeIV: null,
  atmPeIV: null,
  resistanceStrike: null,
  resistanceOI: 0,
  supportStrike: null,
  supportOI: 0,
};

export const WING_OPTIONS = [5, 10, 15, 20] as const;
export type Wings = typeof WING_OPTIONS[number];

/** Underlyings this terminal can trade — each has its own genuine option chain. */
export const CRUDE_UNDERLYINGS = ['CRUDEOIL', 'CRUDEOILM'] as const;
export type CrudeUnderlying = typeof CRUDE_UNDERLYINGS[number];

export const CRUDE_UNDERLYING_LABELS: Record<CrudeUnderlying, string> = {
  CRUDEOIL: 'Crude Oil',
  CRUDEOILM: 'Crude Oil Mini',
};

/** Strike ladder spacing differs per contract — CRUDEOILM lists every 50, not 100. */
export const STRIKE_STEP_BY_UNDERLYING: Record<CrudeUnderlying, number> = {
  CRUDEOIL: 100,
  CRUDEOILM: 50,
};

/** Brokers that can trade MCX crude from this page. */
export const CRUDE_BROKERS = ['dhan', 'kotak'] as const;
export type CrudeBroker = typeof CRUDE_BROKERS[number];

export const CRUDE_BROKER_LABELS: Record<CrudeBroker, string> = {
  dhan: 'Dhan',
  kotak: 'Kotak Neo',
};

/** strike -> Kotak trading symbols for the selected expiry. */
export interface KotakSymbolMap {
  lotSize: number;
  strikes: Record<string, { ceSymbol?: string; peSymbol?: string }>;
}

/** Payload for the shared confirmation modal. Both real-money paths use it. */
export interface ConfirmPayload {
  title: string;
  subtitle?: string;
  reason: string;
  detail: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}

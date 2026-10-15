/**
 * Hedge structures for the Synthetic Futures scalper — the single source of
 * truth for which extra option wings go with a synthetic entry. Imported by
 * both the order route (which legs to place) and the component (preview,
 * net carry, the position ledger), so the two can never disagree about a
 * strike, a side or a quantity. Pure, no I/O.
 *
 *   Mode        LONG (BUY CE + SELL PE @ ATM)    SHORT (SELL CE + BUY PE @ ATM)
 *   PROTECTIVE  BUY  PE @ ATM - buyOffset        BUY  CE @ ATM + buyOffset
 *   COVERED     SELL CE @ ATM + sellOffset       SELL PE @ ATM - sellOffset
 *   COLLAR      both of the above                both of the above
 *
 * A sold wing caps the upside and collects premium; it gives NO downside
 * protection and no margin relief — only the bought wing does that.
 */

export type HedgeMode = 'PROTECTIVE' | 'COVERED' | 'COLLAR';
export type HedgeDirection = 'LONG' | 'SHORT';
export type HedgeRole = 'HEDGE' | 'HEDGE_SELL';

export interface HedgeConfig {
  enabled: boolean;
  mode: HedgeMode;
  /** OTM distance of the bought (protective) wing, in index points. */
  buyOffset: number;
  /** OTM distance of the sold (covered) wing, in index points. */
  sellOffset: number;
  /** Bought-wing lots per synthetic lot. */
  buyRatio: number;
  /** Sold-wing lots per synthetic lot. */
  sellRatio: number;
}

export interface HedgeWing {
  role: HedgeRole;
  optionType: 'CE' | 'PE';
  strike: number;
  side: 'BUY' | 'SELL';
  lots: number;
}

export const HEDGE_MODES: readonly HedgeMode[] = ['PROTECTIVE', 'COVERED', 'COLLAR'];
export const RATIO_CHOICES: readonly number[] = [0.5, 1, 1.5, 2, 3];

export const DEFAULT_HEDGE: HedgeConfig = {
  enabled: true,
  mode: 'PROTECTIVE',
  buyOffset: 200,
  sellOffset: 200,
  buyRatio: 1,
  sellRatio: 1,
};

/** Wing distances offered per underlying — every one sits on the liquid strike ladder. */
export function wingOffsetsFor(underlying: string): number[] {
  return underlying === 'NIFTY' ? [100, 150, 200, 250, 300, 400] : [100, 200, 300, 400, 500, 600];
}

export function hasBuyWing(mode: HedgeMode): boolean {
  return mode === 'PROTECTIVE' || mode === 'COLLAR';
}

export function hasSellWing(mode: HedgeMode): boolean {
  return mode === 'COVERED' || mode === 'COLLAR';
}

/** Whole lots for a wing: floor(lots x ratio), never below one lot. */
export function wingLots(lots: number, ratio: number): number {
  return Math.max(1, Math.floor(lots * ratio + 1e-9));
}

export function buildHedgeWings(
  direction: HedgeDirection,
  atmStrike: number,
  lots: number,
  cfg: HedgeConfig,
): HedgeWing[] {
  if (!cfg.enabled || lots <= 0 || atmStrike <= 0) return [];
  const wings: HedgeWing[] = [];
  if (hasBuyWing(cfg.mode) && cfg.buyOffset > 0) {
    wings.push({
      role: 'HEDGE',
      optionType: direction === 'LONG' ? 'PE' : 'CE',
      strike: direction === 'LONG' ? atmStrike - cfg.buyOffset : atmStrike + cfg.buyOffset,
      side: 'BUY',
      lots: wingLots(lots, cfg.buyRatio),
    });
  }
  if (hasSellWing(cfg.mode) && cfg.sellOffset > 0) {
    wings.push({
      role: 'HEDGE_SELL',
      optionType: direction === 'LONG' ? 'CE' : 'PE',
      strike: direction === 'LONG' ? atmStrike + cfg.sellOffset : atmStrike - cfg.sellOffset,
      side: 'SELL',
      lots: wingLots(lots, cfg.sellRatio),
    });
  }
  return wings;
}

/**
 * Sold-wing lots NOT covered by the synthetic's own long ATM option of the
 * same type (the long CE of a LONG, the long PE of a SHORT). Anything above
 * zero is a naked short option with unlimited (CE) / deep (PE) risk.
 */
// Same for both directions: the sold wing is always written against the
// synthetic's own long ATM option, which is `lots` lots.
export function uncoveredShortLots(_direction: HedgeDirection, lots: number, cfg: HedgeConfig): number {
  if (!cfg.enabled || !hasSellWing(cfg.mode) || cfg.sellOffset <= 0 || lots <= 0) return 0;
  return Math.max(0, wingLots(lots, cfg.sellRatio) - lots);
}

/**
 * Lots of the synthetic's short ATM option (the sold PE of a LONG, the sold
 * CE of a SHORT) that the bought wing does NOT protect — non-zero when
 * buyRatio < 1. Such a position must not be labelled or margined as hedged.
 */
export function unprotectedShortLots(lots: number, cfg: HedgeConfig): number {
  if (lots <= 0) return 0;
  if (!cfg.enabled || !hasBuyWing(cfg.mode) || cfg.buyOffset <= 0) return lots;
  return Math.max(0, lots - wingLots(lots, cfg.buyRatio));
}

/** Hedged = every short ATM lot has a bought wing behind it. */
export function isFullyProtected(lots: number, cfg: HedgeConfig): boolean {
  return lots > 0 && unprotectedShortLots(lots, cfg) === 0;
}

/**
 * How much of a sold wing must be closed so it is never larger than the long
 * option it is written against, given the qty of that long that will remain.
 */
export function soldWingExitQty(soldQty: number, proRataQty: number, remainingCoverQty: number): number {
  const minToStayCovered = Math.max(0, soldQty - Math.max(0, remainingCoverQty));
  return Math.min(soldQty, Math.max(proRataQty, minToStayCovered));
}

/** Server-side ceiling on synthetic lots per entry (wings may be up to 3x this). */
export const MAX_SYNTHETIC_LOTS = 25;

/** Validates a stored or posted config; anything malformed falls back to the default for that field. */
export function sanitizeHedgeConfig(raw: unknown, validOffsets: number[]): HedgeConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const offset = (v: unknown, fallback: number) =>
    typeof v === 'number' && validOffsets.includes(v) ? v : validOffsets.includes(fallback) ? fallback : validOffsets[0];
  const ratio = (v: unknown) => (typeof v === 'number' && RATIO_CHOICES.includes(v) ? v : 1);
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_HEDGE.enabled,
    mode: HEDGE_MODES.includes(r.mode as HedgeMode) ? (r.mode as HedgeMode) : DEFAULT_HEDGE.mode,
    buyOffset: offset(r.buyOffset, DEFAULT_HEDGE.buyOffset),
    sellOffset: offset(r.sellOffset, DEFAULT_HEDGE.sellOffset),
    buyRatio: ratio(r.buyRatio),
    sellRatio: ratio(r.sellRatio),
  };
}

export function sameHedgeConfig(a: HedgeConfig | undefined, b: HedgeConfig): boolean {
  if (!a) return false;
  if (!a.enabled && !b.enabled) return true;
  return (
    a.enabled === b.enabled &&
    a.mode === b.mode &&
    (!hasBuyWing(a.mode) || (a.buyOffset === b.buyOffset && a.buyRatio === b.buyRatio)) &&
    (!hasSellWing(a.mode) || (a.sellOffset === b.sellOffset && a.sellRatio === b.sellRatio))
  );
}

export function describeHedge(cfg: HedgeConfig): string {
  if (!cfg.enabled) return 'NAKED';
  const parts: string[] = [];
  if (hasBuyWing(cfg.mode)) parts.push(`buy ${cfg.buyOffset}pt x${cfg.buyRatio}`);
  if (hasSellWing(cfg.mode)) parts.push(`sell ${cfg.sellOffset}pt x${cfg.sellRatio}`);
  return `${cfg.mode} (${parts.join(', ')})`;
}

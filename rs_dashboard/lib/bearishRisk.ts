/**
 * Stop-loss / target / trailing-stop rules for the short positions on /bearish-strikes. Pure.
 * SL and Target are a percentage of the position's average SELL premium; Trail is in premium POINTS (0 = off):
 *   SL     fires when premium rises to avg × (1 + sl%)
 *   Target fires when premium falls to avg × (1 − tgt%)
 *   Trail  follows the lowest premium seen since entry at a fixed distance: fires when premium rebounds to low + trail
 *          points (1 point of further decay moves the stop 1 point).
 *          It is armed only once the premium has traded below the entry (low < avg), so it never acts as a second SL.
 */
export interface RiskCfg { sl: number; tgt: number; trail: number }
export type RiskHit = 'SL' | 'TARGET' | 'TRAIL';

export const NO_RISK: RiskCfg = { sl: 0, tgt: 0, trail: 0 };

export function riskLevels(avg: number, low: number | null | undefined, cfg: RiskCfg): { sl: number | null; target: number | null; trail: number | null } {
  if (!(avg > 0)) return { sl: null, target: null, trail: null };
  const armed = cfg.trail > 0 && low != null && low > 0 && low < avg;
  return {
    sl: cfg.sl > 0 ? avg * (1 + cfg.sl / 100) : null,
    target: cfg.tgt > 0 ? avg * (1 - cfg.tgt / 100) : null,
    trail: armed ? low + cfg.trail : null,
  };
}

/** Which rule (if any) the live premium has hit. SL wins over TRAIL wins over TARGET when several are met. */
export function riskHit(avg: number, low: number | null | undefined, ltp: number | null, cfg: RiskCfg): RiskHit | null {
  if (ltp == null || !(ltp > 0)) return null;           // no live price = no decision, never a guess
  const l = riskLevels(avg, low, cfg);
  if (l.sl != null && ltp >= l.sl) return 'SL';
  if (l.trail != null && ltp >= l.trail) return 'TRAIL';
  if (l.target != null && ltp <= l.target) return 'TARGET';
  return null;
}

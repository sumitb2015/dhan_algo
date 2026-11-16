/**
 * Stop-loss / target / trailing-stop rules for the short positions on /bearish-strikes. Pure.
 * SL and Target are a percentage of the position's average SELL premium; Trail is in premium POINTS (0 = off):
 *   SL     fires when premium rises to avg × (1 + sl%)
 *   Target fires when premium falls to avg × (1 − tgt%)
 *   Trail  follows the lowest premium seen since entry at a fixed distance: fires when premium rebounds to low + trail
 *          points (1 point of further decay moves the stop 1 point).
 *          It is armed only once the premium has traded below the entry (low < avg), so it never acts as a second SL.
 */
export interface RiskCfg {
  sl: number; tgt: number; trail: number;
  /** Page max loss in rupees (positive number, 0 = off): total P&L of the armed mode's rows at or below −maxLoss exits everything. */
  maxLoss?: number;
}
export type RiskHit = 'SL' | 'TARGET' | 'TRAIL';

export const NO_RISK: RiskCfg = { sl: 0, tgt: 0, trail: 0, maxLoss: 0 };

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

export type PageLossState = 'off' | 'ok' | 'hit' | 'unknown';

/**
 * Page max-loss kill switch. `rows` are the armed mode's positions that count today: open rows (P&L = open + realized,
 * null when the row has no live price) and rows closed today (realized only, never null).
 * Never fires on a partial total: one unpriced open row makes the state 'unknown', because that row could be the loser.
 */
export function pageLossState(rows: { open: boolean; pnl: number | null }[], maxLoss: number | null | undefined): {
  state: PageLossState; total: number; unpriced: number;
} {
  let total = 0;
  let unpriced = 0;
  for (const r of rows) {
    if (r.pnl == null || !Number.isFinite(r.pnl)) { if (r.open) unpriced++; continue; }
    total += r.pnl;
  }
  if (!(maxLoss != null && maxLoss > 0)) return { state: 'off', total, unpriced };
  if (unpriced > 0) return { state: 'unknown', total, unpriced };
  return { state: total <= -maxLoss ? 'hit' : 'ok', total, unpriced };
}

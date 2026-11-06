// Where AUTO picks up a SAVED arming (lib/pnfAutoLedger.ts AutoArmRecord) when the dashboard server's engine (lib/pnfAutoEngine.ts) starts
// on it: after a restart, a rebuild or Update App. Pure (tested in lib/pnfAutoArm.test.ts).
import type { AutoArmRecord, AutoRow } from './pnfAutoLedger.ts';

/**
 * Signals at or before this bar are never entered: the newest of the arming's watermark and the bar of the chart's last AUTO entry since
 * the arming. The engine keeps the watermark in memory as it trades; a restart rebuilds it from here, so a signal already traded (and
 * stopped out) on a still-current bar is never entered a second time.
 */
export function armWatermark(rec: Pick<AutoArmRecord, 't' | 'watermarkT'>, rows: AutoRow[], chart: 1 | 2): number {
  const lastEntry = Math.max(0, ...rows.filter(r => r.chart === chart && r.entryT >= rec.t).map(r => r.entryBarT));
  return Math.max(rec.watermarkT, lastEntry);
}

// When a chart's SAVED AUTO switch (lib/pnfAutoLedger.ts AutoArmRecord) may be switched back on by a page that did not arm it: after a
// reload or a dashboard rebuild, or in another tab of the same page. Pure (tested in lib/pnfAutoArm.test.ts).
//
// Why it exists: arming used to live only in the tab's React state, while the open position lives in the ledger and exits by its rule
// whether AUTO is on or not. Every reload (13 rebuilds on 2026-11-04) left AUTO silently off: the position exited on the flip and nothing
// re-entered. The page still always LOADS in PAPER, so a REAL arm only resumes once the user has switched the page to REAL themselves.
import type { AutoArmRecord, AutoMode, AutoRow } from './pnfAutoLedger.ts';

export type ResumeVerdict =
  /** `watermarkT`: signals at or before it are never entered (the newest of the arming's watermark and the chart's last AUTO entry). */
  | { ok: true; watermarkT: number }
  /** `wait`: the arm stays saved and may resume later (the page is in the other mode, still loading); otherwise it is spent. */
  | { ok: false; why: string; wait: boolean };

export function resumeArm(rec: AutoArmRecord, ctx: {
  chart: 1 | 2; today: string; broker: string; targetKey: string; mode: AutoMode; rows: AutoRow[];
}): ResumeVerdict {
  if (rec.day !== ctx.today) return { ok: false, why: `it was armed on ${rec.day}`, wait: false };
  // A server-guard exit after the arming switched AUTO off (a trend rule would re-enter on the next brick): it does not come back.
  const guarded = ctx.rows.some(r => r.chart === ctx.chart && (r.exitT ?? r.pendingSince ?? 0) > rec.t
    && ((r.state === 'closed' && (r.reason ?? '').startsWith('server guard')) || (r.state === 'unknownExit' && (r.note ?? '').startsWith('server guard'))));
  if (guarded) return { ok: false, why: 'the server guard exited its position after it was armed', wait: false };
  if (rec.targetKey !== ctx.targetKey) return { ok: false, why: 'the chart shows another contract now', wait: true };
  if (rec.broker !== ctx.broker) return { ok: false, why: `it was armed on ${rec.broker}: switch the page broker back to resume`, wait: true };
  if (rec.mode !== ctx.mode) return { ok: false, why: `it was armed in ${rec.mode}: switch the page to ${rec.mode} to resume`, wait: true };
  const lastEntry = Math.max(0, ...ctx.rows.filter(r => r.chart === ctx.chart && r.entryT >= rec.t).map(r => r.entryBarT));
  return { ok: true, watermarkT: Math.max(rec.watermarkT, lastEntry) };
}

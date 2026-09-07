import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';

const STATE_FILE = path.join(PROJECT_ROOT, 'debug', 'pnl_alert_state.json');

export interface PnlAlertState {
  date: string;      // IST calendar date "YYYY-MM-DD" this baseline belongs to
  baseline: number;  // totals.totalPnl the next alert is measured from
  updatedAt: string;
}

export function readPnlAlertState(): PnlAlertState | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (typeof data?.date === 'string' && typeof data?.baseline === 'number') return data;
    return null;
  } catch {
    return null;
  }
}

export function writePnlAlertState(state: PnlAlertState): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, STATE_FILE);
}

// Same "en-CA" IST-date idiom already used in app/api/scalper/top-indices/route.ts —
// NOT lib/session.ts's getSessionStartIst(), which answers a different question
// (the 06:00 IST auth cutoff as a Date) and isn't exported anyway.
export function istToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

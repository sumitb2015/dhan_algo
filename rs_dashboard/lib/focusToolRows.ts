import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';

const ROWS_FILE = path.join(PROJECT_ROOT, 'debug', 'focus_tool_rows.json');

// ── Types ─────────────────────────────────────────────────────────────────────

export type FocusUnderlying = 'NIFTY' | 'BANKNIFTY' | 'SENSEX';
export type FocusDte = 'Any' | '0' | '1' | '0+1';
export type FocusRowStatus = 'draft' | 'armed' | 'entered' | 'exited';
export type FocusSide = 'CE' | 'PE' | 'BOTH';

export interface FocusIndexGroup {
  underlying: FocusUnderlying;
  enabled: boolean;
  atmBy: 'Spot' | 'Fut';
  product: 'INTRADAY' | 'MARGIN';
  strikesOffset: number;     // ± whole-strike offset (0 = ATM, 1 = 1 step OTM, etc.)
  bookExit: boolean;
  spotHigh: string;          // level-exit: exit when spot breaks above
  spotLow: string;           // level-exit: exit when spot breaks below
}

export type FocusStrikeMode = 'ATM' | 'PREMIUM';

export interface FocusRow {
  id: string;
  underlying: FocusUnderlying;
  entryTime: string;         // 'HH:MM'
  exitTime: string;          // 'HH:MM'
  dte: FocusDte;
  expiry: string;            // resolved expiry date string YYYY-MM-DD
  // Strike resolution: ATM mode picks a strike a signed number of steps away
  // from ATM per leg; PREMIUM mode picks whichever listed strike's LTP sits
  // closest to the given rupee target. `linked` mirrors CE's setting onto PE
  // (and vice versa) when the two are edited together; unlinked, each leg is
  // independent and an inverted strangle is a valid, user-chosen shape.
  strikeMode: FocusStrikeMode;
  linked: boolean;
  ceOffset: number;
  peOffset: number;
  cePremium: string;
  pePremium: string;
  lots: number;
  side: FocusSide;
  status: FocusRowStatus;
  // Level exits
  levelHigh: string;
  levelLow: string;
  levelVw: boolean;
  slRupees: string;
  slMultiplier: string;
  // Leg-wise stop, independent of the pair-level slMultiplier above: exits
  // JUST that leg when its own premium expands to this multiple of its own
  // entry price, regardless of what the other leg (or the combined pair) is
  // doing. The row stays open on whichever leg didn't breach. '1' or blank
  // means off, same convention as slMultiplier.
  ceSlMultiplier: string;
  peSlMultiplier: string;
  // Audit
  createdAt: string;
  updatedAt: string;
}

export interface FocusToolConfig {
  groups: FocusIndexGroup[];
  rows: FocusRow[];
  riskEnabled: boolean;
  targetRupees: string;
  stopRupees: string;
  trailEnabled: boolean;
  triggerRupees: string;
  lockRupees: string;
  liveRealMoney: boolean;
  updatedAt: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_GROUP = (u: FocusUnderlying): FocusIndexGroup => ({
  underlying: u,
  enabled: false,
  atmBy: 'Spot',
  product: 'INTRADAY',
  strikesOffset: 0,
  bookExit: false,
  spotHigh: '',
  spotLow: '',
});

export const DEFAULT_CONFIG: FocusToolConfig = {
  groups: [DEFAULT_GROUP('NIFTY'), DEFAULT_GROUP('BANKNIFTY'), DEFAULT_GROUP('SENSEX')],
  rows: [],
  riskEnabled: false,
  targetRupees: '',
  stopRupees: '',
  trailEnabled: false,
  triggerRupees: '',
  lockRupees: '',
  liveRealMoney: false,
  updatedAt: new Date().toISOString(),
};

// ── I/O ───────────────────────────────────────────────────────────────────────

function writeJsonAtomic(file: string, data: unknown) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export function readFocusConfig(): FocusToolConfig {
  try {
    if (!fs.existsSync(ROWS_FILE)) return DEFAULT_CONFIG;
    const raw = JSON.parse(fs.readFileSync(ROWS_FILE, 'utf-8'));
    // Merge with defaults so new keys added to DEFAULT_CONFIG are always present
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      groups: (raw.groups ?? DEFAULT_CONFIG.groups).map((g: Partial<FocusIndexGroup>, i: number) => ({
        ...DEFAULT_CONFIG.groups[i] ?? DEFAULT_GROUP(g.underlying ?? 'NIFTY'),
        ...g,
      })),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeFocusConfig(config: FocusToolConfig): void {
  writeJsonAtomic(ROWS_FILE, { ...config, updatedAt: new Date().toISOString() });
}

// ── ID helper ─────────────────────────────────────────────────────────────────

let _seq = 0;
export function newFocusRowId(): string {
  _seq += 1;
  return `ft_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

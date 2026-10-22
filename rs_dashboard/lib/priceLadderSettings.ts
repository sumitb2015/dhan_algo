import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const SETTINGS_FILE = path.join(DEBUG_DIR, 'price_ladder_settings.json');

export interface PriceLadderSettings {
  /**
   * MCX / CRUDEOILM trading cutoff & MIS square-off time in HH:MM IST (e.g. '23:15').
   * Default: '23:15' (11:15 PM).
   * After this time, new orders/arms are blocked and MIS positions are auto squared off.
   */
  mcxAutoExitTime: string;
}

export const DEFAULT_PRICE_LADDER_SETTINGS: PriceLadderSettings = {
  mcxAutoExitTime: '23:15',
};

let cachedSettings: PriceLadderSettings | null = null;
let cachedMtime = 0;

/** Convert 'HH:MM' string to numeric hhmm (e.g. '23:15' -> 2315). Returns null on invalid. */
export function timeStringToHhmm(str: string): number | null {
  if (!/^\d{1,2}:\d{2}$/.test(str)) return null;
  const [h, m] = str.split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 100 + m;
}

/** Convert numeric hhmm to 'HH:MM' format. */
export function hhmmToTimeString(hhmm: number): string {
  const h = Math.floor(hhmm / 100);
  const m = hhmm % 100;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Read price ladder settings from debug/price_ladder_settings.json with fallback to defaults. */
export function readLadderSettings(): PriceLadderSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const stat = fs.statSync(SETTINGS_FILE);
      if (cachedSettings && cachedMtime === stat.mtimeMs) {
        return cachedSettings;
      }
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<PriceLadderSettings>;
      const mcxTime = typeof raw.mcxAutoExitTime === 'string' && timeStringToHhmm(raw.mcxAutoExitTime) != null
        ? raw.mcxAutoExitTime
        : DEFAULT_PRICE_LADDER_SETTINGS.mcxAutoExitTime;
      cachedSettings = { mcxAutoExitTime: mcxTime };
      cachedMtime = stat.mtimeMs;
      return cachedSettings;
    }
  } catch {
    // Fall back to defaults
  }
  return { ...DEFAULT_PRICE_LADDER_SETTINGS };
}

/** Write updated price ladder settings atomically to debug/price_ladder_settings.json. */
export function writeLadderSettings(patch: Partial<PriceLadderSettings>): PriceLadderSettings {
  const current = readLadderSettings();
  const next: PriceLadderSettings = { ...current };

  if (patch.mcxAutoExitTime !== undefined) {
    const hhmm = timeStringToHhmm(patch.mcxAutoExitTime);
    if (hhmm != null) {
      next.mcxAutoExitTime = patch.mcxAutoExitTime;
    }
  }

  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const tmp = `${SETTINGS_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, SETTINGS_FILE);
    cachedSettings = next;
    cachedMtime = fs.statSync(SETTINGS_FILE).mtimeMs;
  } catch (err) {
    console.error('[price-ladder-settings] failed to save settings:', err);
  }

  return next;
}

/** Get the configured MCX auto exit time as numeric hhmm (e.g. 2315). */
export function getMcxAutoExitHhmm(): number {
  const s = readLadderSettings();
  const n = timeStringToHhmm(s.mcxAutoExitTime);
  return n ?? 2315;
}

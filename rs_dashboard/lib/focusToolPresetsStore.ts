import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { writeJsonAtomic } from '@/lib/focusToolRows';
import { sanitizePreset, type FocusPreset } from '@/lib/focusToolPresets';

/** Saved Focus Tool presets — server-side so every browser sees the same list. */
const PRESETS_FILE = path.join(PROJECT_ROOT, 'debug', 'focus_tool_presets.json');

export function readPresets(): FocusPreset[] {
  if (!fs.existsSync(PRESETS_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf-8')) as { presets?: unknown[] };
    return (raw.presets ?? []).map(sanitizePreset).filter((p): p is FocusPreset => !!p);
  } catch {
    // The next save replaces an unreadable file, so keep a copy of THIS version first. Keyed by its mtime: a later,
    // different corruption gets its own copy instead of being lost behind the first one.
    try {
      const bak = `${PRESETS_FILE}.corrupt-${Math.trunc(fs.statSync(PRESETS_FILE).mtimeMs)}`;
      if (!fs.existsSync(bak)) fs.copyFileSync(PRESETS_FILE, bak);
    } catch { /* best effort */ }
    return [];
  }
}

export function writePresets(presets: FocusPreset[]): void {
  writeJsonAtomic(PRESETS_FILE, { presets, updatedAt: new Date().toISOString() });
}

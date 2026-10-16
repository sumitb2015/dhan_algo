import { NextRequest, NextResponse } from 'next/server';
import { readPresets, writePresets } from '@/lib/focusToolPresetsStore';
import { sanitizePreset, upsertPreset, removePreset, normalizePresetName, MAX_PRESETS, type FocusPreset } from '@/lib/focusToolPresets';
import type { FocusUnderlying } from '@/lib/focusToolUnderlyings';

/**
 * Focus Tool presets (named rule sets per index). Configuration only — nothing here places or sizes an order.
 * Each POST is one synchronous read-modify-write, so two saves cannot interleave inside this process.
 *
 * POST { action: 'save', preset }               add or replace (same name + index)
 * POST { action: 'delete', name, underlying }   remove one
 * POST { action: 'import', presets }            upsert many (from an export file); returns imported / refused counts
 * A new name past MAX_PRESETS is refused rather than evicting an older preset.
 */
export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ success: true, data: readPresets() });
  } catch (err) {
    console.error('[/api/focus-tool/presets GET]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as { action?: string; preset?: unknown; presets?: unknown[]; name?: unknown; underlying?: unknown };
    let list = readPresets();
    let imported = 0;
    let refused = 0;
    if (body.action === 'save') {
      const p = sanitizePreset({ ...(body.preset as object), savedAt: new Date().toISOString() });
      if (!p) return NextResponse.json({ success: false, error: 'Preset needs a name, an index and rules' }, { status: 400 });
      const next = upsertPreset(list, p);
      if (!next) {
        return NextResponse.json({ success: false, error: `${MAX_PRESETS} presets saved already — delete one first` }, { status: 409 });
      }
      list = next;
    } else if (body.action === 'delete') {
      const name = normalizePresetName(body.name);
      if (!name) return NextResponse.json({ success: false, error: 'name required' }, { status: 400 });
      list = removePreset(list, { name, underlying: body.underlying as FocusUnderlying });
    } else if (body.action === 'import') {
      const incoming = (Array.isArray(body.presets) ? body.presets : []).map(sanitizePreset).filter((p): p is FocusPreset => !!p);
      // Oldest first so the newest of any duplicates ends up on top. Never evicts an existing preset: a new name
      // past the cap is refused and counted.
      for (const p of [...incoming].reverse()) {
        const next = upsertPreset(list, p);
        if (next) { list = next; imported += 1; } else refused += 1;
      }
    } else {
      return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
    }
    writePresets(list);
    return NextResponse.json({ success: true, data: list, imported, refused });
  } catch (err) {
    console.error('[/api/focus-tool/presets POST]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

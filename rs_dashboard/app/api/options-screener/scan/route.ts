import { NextRequest, NextResponse } from 'next/server';
import { readScreenerSnapshot } from '@/lib/optionsScreenerStore';
import {
  PRESETS,
  WINDOWS,
  applyFilters,
  evaluatePresets,
  isPresetId,
  matchesConditions,
  metricValue,
  sanitizeConditions,
  sanitizeFilters,
  toResultRow,
  type PresetId,
  type ResultRow,
  type ScanResponse,
  type Segment,
} from '@/lib/optionsScreener';

const CUSTOM_LIMIT = 200;
const PRESET_LIMIT = 300;

function emptyCounts(): Record<PresetId, number> {
  return Object.fromEntries(PRESETS.map((p) => [p.id, 0])) as Record<PresetId, number>;
}

/** POST — evaluate the custom scan and preset scans over the latest collector snapshot. */
export async function POST(req: NextRequest): Promise<NextResponse<ScanResponse>> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const wRaw = Number(body?.window ?? 5);
  const w = (WINDOWS as readonly number[]).includes(wRaw) ? wRaw : 5;

  const base: ScanResponse = {
    success: true,
    hasData: false,
    dataDate: null,
    generatedAt: null,
    snapshotAgeSec: null,
    exchanges: null,
    window: w,
    totalContracts: 0,
    filteredContracts: 0,
    symbols: [],
    expiries: [],
    custom: [],
    customTotal: 0,
    presetCounts: emptyCounts(),
    presetHits: [],
  };

  const loaded = readScreenerSnapshot();
  if (!loaded) return NextResponse.json(base);
  const { snap, byId, mtimeMs } = loaded;

  const filters = sanitizeFilters((body?.filters as Record<string, unknown>) ?? null);
  const conditions = sanitizeConditions(body?.conditions);
  const presets = Array.isArray(body?.presets)
    ? (body!.presets as unknown[]).map(String).filter(isPresetId)
    : [];
  const match = body?.match === 'all' ? 'all' : 'any';
  const sticky = Array.isArray(body?.sticky)
    ? (body!.sticky as unknown[]).map(String).filter((s) => /^[A-Z_]+:\d+$/.test(s)).slice(0, 400)
    : [];

  const rows = applyFilters(snap.rows, filters);
  const und = snap.underlyings;

  // Custom scan — all conditions must hold; ranked by the first condition's magnitude.
  let custom: ResultRow[] = [];
  let customTotal = 0;
  if (conditions.length) {
    const first = conditions[0];
    const matched = rows.filter((r) => matchesConditions(r, conditions, und));
    customTotal = matched.length;
    custom = matched
      .map((r) => toResultRow(r, w, und, [], true, Math.abs(metricValue(r, first.metric, first.window, und) ?? 0)))
      .sort((a, b) => b.score - a.score)
      .slice(0, CUSTOM_LIMIT);
  }

  // Presets — counts cover every preset (the chips show them even unticked).
  const { hits, counts } = evaluatePresets(rows, snap.groups, und, w, snap.date);
  const presetHits: ResultRow[] = [];
  if (presets.length) {
    const wanted = new Set<PresetId>(presets);
    const seen = new Set<string>();
    for (const [id, list] of hits) {
      const mine = list.filter((p) => wanted.has(p));
      const ok = match === 'all' ? presets.every((p) => list.includes(p)) : mine.length > 0;
      if (!ok) continue;
      const row = byId.get(id);
      if (!row) continue;
      const score = Math.abs(row.d?.[String(w)]?.[0] ?? 0);
      presetHits.push(toResultRow(row, w, und, mine, true, score));
      seen.add(id);
    }
    presetHits.sort((a, b) => b.score - a.score);
    presetHits.splice(PRESET_LIMIT);
    // Sticky rows that stopped matching: current values, no tags from this scan.
    const filteredIds = new Set(rows.map((r) => r.id));
    for (const id of sticky) {
      if (seen.has(id) || !filteredIds.has(id)) continue;
      const row = byId.get(id);
      if (row) presetHits.push(toResultRow(row, w, und, [], false, 0));
    }
  }

  const symbolKinds = new Map<string, Segment>();
  const expiries = new Set<string>();
  for (const r of snap.rows) {
    symbolKinds.set(r.u, r.k);
    expiries.add(r.e);
  }

  return NextResponse.json({
    ...base,
    hasData: true,
    dataDate: snap.date,
    generatedAt: snap.generated_at,
    snapshotAgeSec: Math.round((Date.now() - mtimeMs) / 1000),
    exchanges: snap.exchanges,
    totalContracts: snap.rows.length,
    filteredContracts: rows.length,
    symbols: [...symbolKinds].map(([u, k]) => ({ u, k })).sort((a, b) => a.u.localeCompare(b.u)),
    expiries: [...expiries].sort(),
    custom,
    customTotal,
    presetCounts: counts,
    presetHits,
  });
}

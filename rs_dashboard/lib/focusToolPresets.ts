/**
 * Focus Tool row presets, row duplication and config export / import — pure, no I/O.
 *
 * A row is its RULES (timing, strikes, lots, stops, targets, re-entry, trail, lazy legs …) plus RUNTIME state (id,
 * status, the fill ledger, REAL/SIM, re-entry counters, resting ladder orders). Everything here copies rules only:
 * a copied fill ledger would make the new row claim a position it never opened (and size exits off it), and a
 * copied REAL mode would let a duplicate trade real money without the user ever flipping it. Rules are "every key
 * that is not runtime", so a rule field added to FocusRow later is carried without touching this file.
 */
import type { FocusRow } from './focusToolRows.ts';
import { FOCUS_UNDERLYINGS, type FocusUnderlying } from './focusToolUnderlyings.ts';

/** Per-row state that belongs to one row's life, never to its configuration. */
export const ROW_RUNTIME_KEYS = [
  'id', 'underlying', 'expiry', 'status', 'mode', 'fill', 'createdAt', 'updatedAt', 'rev',
  'overallReSlCount', 'overallReTgtCount', 'overallReMode', 'entryMomState', 'ladder',
] as const satisfies readonly (keyof FocusRow)[];

/** Spot exit levels are prices for one day — a preset applied next week must not carry them. */
export const PRESET_SKIP_KEYS = ['levelHigh', 'levelLow'] as const satisfies readonly (keyof FocusRow)[];

export type FocusRowRules = Partial<Omit<FocusRow, typeof ROW_RUNTIME_KEYS[number]>>;

export interface FocusPreset {
  name: string;
  /** Presets are per index: times, strike steps, premiums and lots do not carry across underlyings. */
  underlying: FocusUnderlying;
  rules: FocusRowRules;
  savedAt: string;
}

export const PRESET_NAME_MAX = 40;
export const MAX_PRESETS = 100;

const RUNTIME = new Set<string>(ROW_RUNTIME_KEYS);
const SKIP = new Set<string>(PRESET_SKIP_KEYS);

function isObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/** A deep copy of the row's rules (no runtime keys, no undefined values). */
export function rowRules(row: Partial<FocusRow>): FocusRowRules {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!RUNTIME.has(k) && v !== undefined) out[k] = v;
  }
  return JSON.parse(JSON.stringify(out)) as FocusRowRules;
}

/** What a preset saves from a row: its rules minus the day's spot levels. */
export function presetRules(row: Partial<FocusRow>): FocusRowRules {
  const r = rowRules(row) as Record<string, unknown>;
  for (const k of SKIP) delete r[k];
  return r as FocusRowRules;
}

/** Untrusted rules (a stored preset, an imported file) → rules only, or null when not an object. */
export function sanitizeRules(x: unknown): FocusRowRules | null {
  if (!isObject(x)) return null;
  return presetRules(x as Partial<FocusRow>);
}

/**
 * A new row with `src`'s rules: always a flat SIM draft with its own id, on the same index and expiry. The spot
 * levels come along — it is a copy for today, not a template — so the caller re-checks them against spot.
 */
export function duplicateRow(src: FocusRow, id: string, nowIso: string): FocusRow {
  return {
    ...(rowRules(src) as FocusRow),
    id,
    underlying: src.underlying,
    expiry: src.expiry,
    status: 'draft',
    mode: 'sim',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * The patch that replaces a row's rules with a preset's. Every rule key the row (or the defaults) has is reset first,
 * then the defaults, then the preset — so a rule the preset leaves unset falls back to a new row's default instead of
 * keeping whatever this row had. Runtime state and the row's own spot levels are left alone.
 *
 * `base` is a fresh default row for the same underlying (FocusTool's makeRow).
 */
export function applyPresetPatch(row: FocusRow, base: FocusRow, rules: FocusRowRules): Partial<FocusRow> {
  const patch: Record<string, unknown> = {};
  const clean = typedRules(sanitizeRules(rules) ?? {}, base);
  for (const k of new Set([...Object.keys(row), ...Object.keys(base), ...Object.keys(clean)])) {
    if (!RUNTIME.has(k) && !SKIP.has(k)) patch[k] = undefined;
  }
  Object.assign(patch, presetRules(base), clean);
  return patch as Partial<FocusRow>;
}

/**
 * Why a preset cannot be applied to this row right now, or null. Only a row that holds nothing, is not mid-cycle and
 * is not ARMED: swapping stops, targets or re-entry under an open position changes how a live trade exits, and on an
 * armed row a preset without its entry gates (momentum, range breakout) would sell on the very next tick.
 */
export function presetBlockedReason(row: FocusRow): string | null {
  const f = row.fill;
  if ((Number(f?.ceQty) || 0) > 0 || (Number(f?.peQty) || 0) > 0) return 'Row holds a position — exit it first';
  if (row.status === 'entered') return 'Row is in a trade cycle — wait for it to exit';
  if (row.status === 'armed') return 'Row is armed — disarm it first';
  if (f?.cePending || f?.pePending) return 'A re-entry is waiting on this row — cancel it first';
  return null;
}

/** Largest lot count a preset or import may carry (per row / per leg); the Qty × menu offers 1–10. */
export const MAX_RULE_LOTS = 100;
export const MAX_QTY_MULTIPLIER = 10;

const LOT_KEYS = new Set(['lots', 'ceLots', 'peLots']);

/**
 * Untrusted rules made safe to merge onto `base` (a default row): a value whose type differs from the default's is
 * dropped (so `lots: "abc"` or `entryTime: 5` falls back to the default), and lot counts / the quantity multiplier
 * must be whole numbers in range. Keys the default row does not set (optional rules) are kept as they are.
 */
export function typedRules(rules: FocusRowRules, base: FocusRow): FocusRowRules {
  const out: Record<string, unknown> = {};
  const b = base as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(rules)) {
    const want = b[k];
    if (want !== undefined && want !== null && v !== null && typeof v !== typeof want) continue;
    if (want !== undefined && want !== null && Array.isArray(want) !== Array.isArray(v)) continue;
    if (LOT_KEYS.has(k) && !(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_RULE_LOTS)) continue;
    if (k === 'qtyMultiplier' && !(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_QTY_MULTIPLIER)) continue;
    out[k] = v;
  }
  return out as FocusRowRules;
}

export function normalizePresetName(name: unknown): string {
  return typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0, PRESET_NAME_MAX) : '';
}

const sameKey = (a: Pick<FocusPreset, 'name' | 'underlying'>, b: Pick<FocusPreset, 'name' | 'underlying'>) =>
  a.underlying === b.underlying && a.name.toLowerCase() === b.name.toLowerCase();

/** Validated preset, or null. */
export function sanitizePreset(x: unknown): FocusPreset | null {
  if (!isObject(x)) return null;
  const name = normalizePresetName(x.name);
  const underlying = x.underlying as FocusUnderlying;
  const rules = sanitizeRules(x.rules);
  if (!name || !(FOCUS_UNDERLYINGS as readonly string[]).includes(underlying) || !rules) return null;
  const savedAt = typeof x.savedAt === 'string' && x.savedAt ? x.savedAt : new Date(0).toISOString();
  return { name, underlying, rules, savedAt };
}

/**
 * Add or replace (same name, case-insensitive, same index), newest first. Never drops another preset to make room:
 * past MAX_PRESETS a NEW name is refused (null) and the caller says so; replacing an existing one always works.
 */
export function upsertPreset(list: FocusPreset[], p: FocusPreset): FocusPreset[] | null {
  const rest = list.filter(x => !sameKey(x, p));
  if (rest.length === list.length && list.length >= MAX_PRESETS) return null;
  return [p, ...rest];
}

export function removePreset(list: FocusPreset[], key: Pick<FocusPreset, 'name' | 'underlying'>): FocusPreset[] {
  return list.filter(x => !sameKey(x, key));
}

// ── Export / import ──────────────────────────────────────────────────────────

export const EXPORT_KIND = 'focus-tool-export';
export const EXPORT_VERSION = 1;

/** `expiry` is the row's own pick when exported — restored only if that expiry is still listed. */
export interface FocusExportRow { underlying: FocusUnderlying; expiry?: string; rules: FocusRowRules }
export interface FocusExport {
  kind: typeof EXPORT_KIND;
  version: number;
  exportedAt: string;
  rows: FocusExportRow[];
  presets: FocusPreset[];
}

/**
 * A backup of every row's rules and every preset. No fills, ids, REAL/SIM or account settings (the risk bar and the
 * LIVE · REAL MONEY arm are deliberately not restorable from a file).
 */
export function buildExport(rows: FocusRow[], presets: FocusPreset[], nowIso: string): FocusExport {
  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: nowIso,
    rows: rows.map(r => ({ underlying: r.underlying, ...(r.expiry ? { expiry: r.expiry } : {}), rules: rowRules(r) })),
    presets: presets.map(p => ({ ...p, rules: sanitizeRules(p.rules) ?? {} })),
  };
}

/**
 * Parse an export file. Rows come back as rules to ADD as new SIM drafts (never replacing or touching existing rows);
 * presets to upsert. Unknown underlyings and malformed entries are skipped and counted. A row's spot levels are NOT
 * restored: they are prices from the day it was exported, and a stale L↓ above today's spot exits the moment the row
 * enters.
 */
export function parseImport(text: string):
  { ok: true; rows: FocusExportRow[]; presets: FocusPreset[]; skipped: number } | { ok: false; error: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: 'Not a JSON file' }; }
  if (!isObject(raw) || raw.kind !== EXPORT_KIND) return { ok: false, error: 'Not a Focus Tool export file' };
  if (Number(raw.version) > EXPORT_VERSION) return { ok: false, error: `Made by a newer version (v${raw.version})` };
  let skipped = 0;
  const rows: FocusExportRow[] = [];
  for (const r of Array.isArray(raw.rows) ? raw.rows : []) {
    const u = isObject(r) ? r.underlying as FocusUnderlying : undefined;
    const rules = isObject(r) ? sanitizeRules(r.rules) : null;
    if (u && (FOCUS_UNDERLYINGS as readonly string[]).includes(u) && rules) {
      const expiry = isObject(r) && typeof r.expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.expiry) ? r.expiry : undefined;
      rows.push({ underlying: u, ...(expiry ? { expiry } : {}), rules });
    } else skipped += 1;
  }
  const presets: FocusPreset[] = [];
  for (const p of Array.isArray(raw.presets) ? raw.presets : []) {
    const ok = sanitizePreset(p);
    if (ok) presets.push(ok); else skipped += 1;
  }
  return { ok: true, rows, presets, skipped };
}

/** An imported row: the defaults for its index, then the file's (type-checked) rules, as a fresh SIM draft. */
export function rowFromImport(base: FocusRow, rules: FocusRowRules): FocusRow {
  const clean = typedRules(sanitizeRules(rules) ?? {}, base);
  return { ...base, ...(JSON.parse(JSON.stringify(clean)) as FocusRowRules), status: 'draft', mode: 'sim' };
}

/** The expiry an imported row trades: its exported one while still listed, else the nearest (`kept` false then). */
export function importExpiry(exported: string | undefined, listed: readonly string[]): { expiry: string; kept: boolean } {
  if (exported && listed.includes(exported)) return { expiry: exported, kept: true };
  return { expiry: listed[0] ?? '', kept: !exported };
}

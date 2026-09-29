/**
 * Options Screener — shared types, metrics and scan engine.
 *
 * The data comes from scripts/tools/options_screener_collector.py, which writes
 * debug/options_screener_snapshot.json once a minute: every tracked contract (ATM±10,
 * nearest two expiries, index + stock + MCX options) with its current LTP/OI/volume/IV
 * and, per look-back window, the change against its own snapshot that many minutes ago.
 *
 * This file only reads that snapshot. It is pure (no fs, no fetch) so the API route and
 * the unit tests share exactly one implementation of every preset and custom condition.
 *
 * Units: `oi`, `v` (day volume) and window volume are in LOTS. `lot` is the order quantity
 * per lot Dhan expects (LOT_SIZE for NSE/BSE, 1 for MCX); `mult` is units per lot, used
 * only for premium turnover.
 */

export const WINDOWS = [1, 3, 5, 10, 15, 30] as const;
export type WindowMin = (typeof WINDOWS)[number];

export type Segment = 'index' | 'stock' | 'mcx';
export type OptType = 'CE' | 'PE';

/** Per-window diff tuple, index-addressed to keep the minute-by-minute file small. */
export const D_PRICE_PCT = 0;
export const D_OI_PCT = 1;
export const D_WIN_VOL = 2;
export const D_RVOL = 3;
export const D_IV_CHG = 4;
export const D_OI_CHG = 5;
export const D_PRICE_CHG = 6;
export type WindowDiff = (number | null)[];

export interface SnapshotRow {
  id: string;        // "<segment>:<securityId>"
  sid: string;
  xs: string;        // order/quote exchange segment (NSE_FNO / BSE_FNO / MCX_COMM)
  x: 'NSE' | 'BSE' | 'MCX';
  u: string;         // underlying
  k: Segment;
  e: string;         // expiry YYYY-MM-DD
  s: number;         // strike
  t: OptType;
  off: number;       // strike steps from ATM (negative = below ATM)
  lot: number;
  mult: number;
  tick: number;
  ltp: number;
  oi: number;
  v: number;
  iv: number | null;
  ts: number;
  d: Record<string, WindowDiff | null>;
}

export interface GroupWindow {
  pcr: number | null;
  ceWallFrom: number | null;
  peWallFrom: number | null;
  str: number | null;
  tilt: number | null;
}

export interface SnapshotGroup {
  u: string;
  e: string;
  x: 'NSE' | 'BSE' | 'MCX';
  atm: number | null;
  pcr: number | null;
  ceWall: number | null;
  peWall: number | null;
  straddle: number | null;
  d: Record<string, GroupWindow | null>;
}

export interface SnapshotUnderlying {
  kind: Segment;
  exch: 'NSE' | 'BSE' | 'MCX';
  spot: number | null;
  chg: Record<string, number | null>;
}

export interface ExchangeScan {
  last_scan: number | null;
  live: boolean;
  contracts: number;
}

export interface Snapshot {
  v: number;
  generated_at: string;
  date: string;
  windows: number[];
  strikes: number;
  exchanges: Record<'NSE' | 'BSE' | 'MCX', ExchangeScan>;
  underlyings: Record<string, SnapshotUnderlying>;
  groups: SnapshotGroup[];
  rows: SnapshotRow[];
}

// ---------------------------------------------------------------------------
// moneyness
// ---------------------------------------------------------------------------

/** ATM / ITMn / OTMn. A CE below ATM is ITM; a PE below ATM is OTM. */
export function moneyness(t: OptType, off: number): string {
  if (off === 0) return 'ATM';
  const itm = t === 'CE' ? off < 0 : off > 0;
  return `${itm ? 'ITM' : 'OTM'}${Math.abs(off)}`;
}

/** Signed OTM distance: >0 OTM, <0 ITM, 0 ATM. */
export function otmSteps(t: OptType, off: number): number {
  return t === 'CE' ? off : -off;
}

// ---------------------------------------------------------------------------
// metrics (custom scan)
// ---------------------------------------------------------------------------

export type MetricId =
  | 'premium_pct'
  | 'premium_chg'
  | 'oi_pct'
  | 'oi_chg'
  | 'volume'
  | 'rvol'
  | 'iv_chg'
  | 'turnover'
  | 'underlying_pct'
  | 'ltp'
  | 'oi'
  | 'day_volume'
  | 'iv'
  | 'atm_distance';

export interface MetricDef {
  id: MetricId;
  label: string;
  unit: string;
  windowed: boolean;
}

export const METRICS: MetricDef[] = [
  { id: 'premium_pct', label: 'Premium change', unit: '%', windowed: true },
  { id: 'premium_chg', label: 'Premium change (pts)', unit: 'pts', windowed: true },
  { id: 'oi_pct', label: 'OI change %', unit: '%', windowed: true },
  { id: 'oi_chg', label: 'OI change (lots)', unit: 'lots', windowed: true },
  { id: 'volume', label: 'Volume (lots)', unit: 'lots', windowed: true },
  { id: 'rvol', label: 'Relative volume', unit: '×', windowed: true },
  { id: 'iv_chg', label: 'IV change', unit: 'pts', windowed: true },
  { id: 'turnover', label: 'Premium turnover', unit: '₹L', windowed: true },
  { id: 'underlying_pct', label: 'Underlying change', unit: '%', windowed: true },
  { id: 'ltp', label: 'Premium (LTP)', unit: '₹', windowed: false },
  { id: 'oi', label: 'Open interest (lots)', unit: 'lots', windowed: false },
  { id: 'day_volume', label: 'Day volume (lots)', unit: 'lots', windowed: false },
  { id: 'iv', label: 'IV', unit: '%', windowed: false },
  { id: 'atm_distance', label: 'Strikes from ATM', unit: 'steps', windowed: false },
];

const METRIC_IDS = new Set<string>(METRICS.map((m) => m.id));

export function diffAt(row: SnapshotRow, w: number, idx: number): number | null {
  const d = row.d?.[String(w)];
  if (!d) return null;
  const v = d[idx];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Premium turnover in the window, in ₹ lakh (window lots × units per lot × LTP). */
export function windowTurnoverLakh(row: SnapshotRow, w: number): number | null {
  const vol = diffAt(row, w, D_WIN_VOL);
  if (vol == null) return null;
  return (vol * row.mult * row.ltp) / 1e5;
}

export function metricValue(
  row: SnapshotRow,
  metric: MetricId,
  w: number,
  underlyings: Record<string, SnapshotUnderlying>,
): number | null {
  switch (metric) {
    case 'premium_pct': return diffAt(row, w, D_PRICE_PCT);
    case 'premium_chg': return diffAt(row, w, D_PRICE_CHG);
    case 'oi_pct': return diffAt(row, w, D_OI_PCT);
    case 'oi_chg': return diffAt(row, w, D_OI_CHG);
    case 'volume': return diffAt(row, w, D_WIN_VOL);
    case 'rvol': return diffAt(row, w, D_RVOL);
    case 'iv_chg': return diffAt(row, w, D_IV_CHG);
    case 'turnover': return windowTurnoverLakh(row, w);
    case 'underlying_pct': {
      const v = underlyings[row.u]?.chg?.[String(w)];
      return typeof v === 'number' ? v : null;
    }
    case 'ltp': return row.ltp;
    case 'oi': return row.oi;
    case 'day_volume': return row.v;
    case 'iv': return row.iv;
    case 'atm_distance': return Math.abs(row.off);
  }
}

export interface ScanCondition {
  metric: MetricId;
  window: WindowMin;
  op: 'gte' | 'lte';
  value: number;
}

/** Drop anything malformed — conditions arrive from the client and from localStorage. */
export function sanitizeConditions(raw: unknown): ScanCondition[] {
  if (!Array.isArray(raw)) return [];
  const out: ScanCondition[] = [];
  for (const c of raw.slice(0, 8)) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    const metric = String(r.metric ?? '');
    const window = Number(r.window);
    const op = r.op === 'lte' ? 'lte' : r.op === 'gte' ? 'gte' : null;
    const value = Number(r.value);
    if (!METRIC_IDS.has(metric) || !op || !Number.isFinite(value)) continue;
    if (!(WINDOWS as readonly number[]).includes(window)) continue;
    out.push({ metric: metric as MetricId, window: window as WindowMin, op, value });
  }
  return out;
}

export function matchesConditions(
  row: SnapshotRow,
  conds: ScanCondition[],
  underlyings: Record<string, SnapshotUnderlying>,
): boolean {
  if (conds.length === 0) return false;
  for (const c of conds) {
    const v = metricValue(row, c.metric, c.window, underlyings);
    // No baseline yet (collector just started, contract just entered the band) → no match,
    // never a silent pass.
    if (v == null) return false;
    if (c.op === 'gte' ? v < c.value : v > c.value) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------

export type PresetGroupId = 'buildup' | 'activity' | 'volatility' | 'underlying';

export type PresetId =
  | 'fresh_long_buildup'
  | 'call_writing'
  | 'put_writing'
  | 'short_covering'
  | 'long_unwinding'
  | 'unusual_volume'
  | 'strike_active'
  | 'breakout_activity'
  | 'atm_otm_momentum'
  | 'gamma_burst'
  | 'big_ticket'
  | 'iv_spike_crush'
  | 'pcr_shift'
  | 'atm_tilt'
  | 'oi_wall_shift'
  | 'straddle_move';

export interface PresetDef {
  id: PresetId;
  group: PresetGroupId;
  label: string;
  tag: string;
  desc: string;
}

export const PRESET_GROUPS: { id: PresetGroupId; label: string }[] = [
  { id: 'buildup', label: 'Buildup & writing' },
  { id: 'activity', label: 'Activity' },
  { id: 'volatility', label: 'Volatility' },
  { id: 'underlying', label: 'Underlying' },
];

/** Thresholds, in one place so the glossary and the engine can't drift. */
export const T = {
  minWinVol: 5,          // lots traded in the window before any price/OI read counts
  buildPricePct: 5,
  buildOiPct: 5,
  uvRvol: 5,
  uvMinVol: 25,
  activeShare: 0.5,      // window volume ≥ 50% of the whole day's volume
  activeMinVol: 50,
  breakoutUnderlyingPct: 0.4,
  breakoutRvol: 3,
  momentumPct: 15,
  gammaPct: 30,
  bigTicketLakh: 50,
  ivPts: 3,
  pcrShift: 0.1,
  tiltPct: 10,
  straddlePct: 5,
} as const;

export const PRESETS: PresetDef[] = [
  { id: 'fresh_long_buildup', group: 'buildup', label: 'Fresh long buildup', tag: 'LB',
    desc: `Premium ≥ +${T.buildPricePct}% and OI ≥ +${T.buildOiPct}% with ≥ ${T.minWinVol} lots traded — new longs.` },
  { id: 'call_writing', group: 'buildup', label: 'Call writing', tag: 'CW',
    desc: `CE premium ≤ −${T.buildPricePct}% while OI ≥ +${T.buildOiPct}% — fresh call shorts (bearish/cap).` },
  { id: 'put_writing', group: 'buildup', label: 'Put writing', tag: 'PW',
    desc: `PE premium ≤ −${T.buildPricePct}% while OI ≥ +${T.buildOiPct}% — fresh put shorts (bullish/floor).` },
  { id: 'short_covering', group: 'buildup', label: 'Short covering', tag: 'SC',
    desc: `Premium ≥ +${T.buildPricePct}% while OI ≤ −${T.buildOiPct}% — writers buying back.` },
  { id: 'long_unwinding', group: 'buildup', label: 'Long unwinding', tag: 'LU',
    desc: `Premium ≤ −${T.buildPricePct}% and OI ≤ −${T.buildOiPct}% — longs exiting.` },
  { id: 'unusual_volume', group: 'activity', label: 'Unusual volume', tag: 'UV',
    desc: `Window volume ≥ ${T.uvRvol}× the contract's own session-average pace, and ≥ ${T.uvMinVol} lots.` },
  { id: 'strike_active', group: 'activity', label: 'Strike suddenly active', tag: 'SA',
    desc: `≥ ${T.activeShare * 100}% of the day's volume traded inside the window (≥ ${T.activeMinVol} lots) — a quiet strike waking up.` },
  { id: 'breakout_activity', group: 'activity', label: 'Breakout + strike activity', tag: 'BO',
    desc: `Underlying moved ≥ ${T.breakoutUnderlyingPct}% and the with-trend option (CE up / PE down, within 3 strikes) trades at ≥ ${T.breakoutRvol}× RVOL.` },
  { id: 'atm_otm_momentum', group: 'activity', label: 'ATM/OTM momentum', tag: 'MO',
    desc: `ATM to OTM3 premium up ≥ ${T.momentumPct}% on ≥ ${T.minWinVol} lots.` },
  { id: 'gamma_burst', group: 'activity', label: 'Expiry-day gamma burst', tag: 'GB',
    desc: `Expires today, within 2 strikes of ATM, premium up ≥ ${T.gammaPct}%.` },
  { id: 'big_ticket', group: 'activity', label: 'Big-ticket print', tag: 'BT',
    desc: `Premium turnover in the window ≥ ₹${T.bigTicketLakh} lakh.` },
  { id: 'iv_spike_crush', group: 'volatility', label: 'IV spike / crush', tag: 'IV',
    desc: `IV moved ≥ ${T.ivPts} vol points either way.` },
  { id: 'pcr_shift', group: 'underlying', label: 'PCR shift', tag: 'PCR',
    desc: `Put-call OI ratio (ATM±band) moved ≥ ${T.pcrShift}. Flags the ATM CE and PE.` },
  { id: 'atm_tilt', group: 'underlying', label: 'ATM call-vs-put tilt', tag: 'TL',
    desc: `ATM CE % change minus ATM PE % change ≥ ${T.tiltPct} points either way. Flags the leading leg.` },
  { id: 'oi_wall_shift', group: 'underlying', label: 'OI wall shift', tag: 'WL',
    desc: 'The highest-OI CE or PE strike moved. Flags the new wall contract.' },
  { id: 'straddle_move', group: 'underlying', label: 'Straddle expansion / crush', tag: 'ST',
    desc: `ATM straddle premium changed ≥ ${T.straddlePct}% either way. Flags the ATM CE and PE.` },
];

export const PRESET_BY_ID: Record<PresetId, PresetDef> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p]),
) as Record<PresetId, PresetDef>;

export function isPresetId(v: string): v is PresetId {
  return v in PRESET_BY_ID;
}

type RowTest = (row: SnapshotRow, w: number, ctx: EvalContext) => boolean;

interface EvalContext {
  underlyings: Record<string, SnapshotUnderlying>;
  today: string;
}

function liquid(row: SnapshotRow, w: number): boolean {
  const vol = diffAt(row, w, D_WIN_VOL);
  return vol != null && vol >= T.minWinVol;
}

const ROW_TESTS: Partial<Record<PresetId, RowTest>> = {
  fresh_long_buildup: (r, w) => {
    const p = diffAt(r, w, D_PRICE_PCT), o = diffAt(r, w, D_OI_PCT);
    return liquid(r, w) && p != null && o != null && p >= T.buildPricePct && o >= T.buildOiPct;
  },
  call_writing: (r, w) => {
    const p = diffAt(r, w, D_PRICE_PCT), o = diffAt(r, w, D_OI_PCT);
    return r.t === 'CE' && liquid(r, w) && p != null && o != null && p <= -T.buildPricePct && o >= T.buildOiPct;
  },
  put_writing: (r, w) => {
    const p = diffAt(r, w, D_PRICE_PCT), o = diffAt(r, w, D_OI_PCT);
    return r.t === 'PE' && liquid(r, w) && p != null && o != null && p <= -T.buildPricePct && o >= T.buildOiPct;
  },
  short_covering: (r, w) => {
    const p = diffAt(r, w, D_PRICE_PCT), o = diffAt(r, w, D_OI_PCT);
    return liquid(r, w) && p != null && o != null && p >= T.buildPricePct && o <= -T.buildOiPct;
  },
  long_unwinding: (r, w) => {
    const p = diffAt(r, w, D_PRICE_PCT), o = diffAt(r, w, D_OI_PCT);
    return liquid(r, w) && p != null && o != null && p <= -T.buildPricePct && o <= -T.buildOiPct;
  },
  unusual_volume: (r, w) => {
    const rv = diffAt(r, w, D_RVOL), vol = diffAt(r, w, D_WIN_VOL);
    return rv != null && vol != null && rv >= T.uvRvol && vol >= T.uvMinVol;
  },
  strike_active: (r, w) => {
    const vol = diffAt(r, w, D_WIN_VOL);
    return vol != null && vol >= T.activeMinVol && r.v > 0 && vol / r.v >= T.activeShare;
  },
  breakout_activity: (r, w, ctx) => {
    const u = ctx.underlyings[r.u]?.chg?.[String(w)];
    const rv = diffAt(r, w, D_RVOL);
    if (typeof u !== 'number' || rv == null || rv < T.breakoutRvol || Math.abs(r.off) > 3) return false;
    return (u >= T.breakoutUnderlyingPct && r.t === 'CE') || (u <= -T.breakoutUnderlyingPct && r.t === 'PE');
  },
  atm_otm_momentum: (r, w) => {
    const steps = otmSteps(r.t, r.off);
    const p = diffAt(r, w, D_PRICE_PCT);
    return steps >= 0 && steps <= 3 && liquid(r, w) && p != null && p >= T.momentumPct;
  },
  gamma_burst: (r, w, ctx) => {
    const p = diffAt(r, w, D_PRICE_PCT);
    return r.e === ctx.today && Math.abs(r.off) <= 2 && p != null && p >= T.gammaPct;
  },
  big_ticket: (r, w) => {
    const t = windowTurnoverLakh(r, w);
    return t != null && t >= T.bigTicketLakh;
  },
  iv_spike_crush: (r, w) => {
    const iv = diffAt(r, w, D_IV_CHG);
    return iv != null && Math.abs(iv) >= T.ivPts;
  },
};

/** Group-level presets name contracts, not tests — resolved once per group. */
function groupHits(
  groups: SnapshotGroup[],
  byKey: Map<string, SnapshotRow>,
  w: number,
): Map<PresetId, Set<string>> {
  const out = new Map<PresetId, Set<string>>([
    ['pcr_shift', new Set()],
    ['atm_tilt', new Set()],
    ['oi_wall_shift', new Set()],
    ['straddle_move', new Set()],
  ]);
  const key = (u: string, e: string, s: number | null, t: OptType) => `${u}|${e}|${s}|${t}`;
  for (const g of groups) {
    const d = g.d?.[String(w)];
    if (!d) continue;
    const atmCe = g.atm != null ? byKey.get(key(g.u, g.e, g.atm, 'CE')) : undefined;
    const atmPe = g.atm != null ? byKey.get(key(g.u, g.e, g.atm, 'PE')) : undefined;
    const addAtm = (id: PresetId) => {
      if (atmCe) out.get(id)!.add(atmCe.id);
      if (atmPe) out.get(id)!.add(atmPe.id);
    };
    if (d.pcr != null && Math.abs(d.pcr) >= T.pcrShift) addAtm('pcr_shift');
    if (d.str != null && Math.abs(d.str) >= T.straddlePct) addAtm('straddle_move');
    if (d.tilt != null && Math.abs(d.tilt) >= T.tiltPct) {
      const lead = d.tilt > 0 ? atmCe : atmPe;
      if (lead) out.get('atm_tilt')!.add(lead.id);
    }
    if (g.ceWall != null && d.ceWallFrom != null && g.ceWall !== d.ceWallFrom) {
      const r = byKey.get(key(g.u, g.e, g.ceWall, 'CE'));
      if (r) out.get('oi_wall_shift')!.add(r.id);
    }
    if (g.peWall != null && d.peWallFrom != null && g.peWall !== d.peWallFrom) {
      const r = byKey.get(key(g.u, g.e, g.peWall, 'PE'));
      if (r) out.get('oi_wall_shift')!.add(r.id);
    }
  }
  return out;
}

/**
 * Evaluate every preset over `rows` (already filtered) for window `w`.
 * Returns row id → preset ids it matches, plus a per-preset count.
 */
export function evaluatePresets(
  rows: SnapshotRow[],
  allGroups: SnapshotGroup[],
  underlyings: Record<string, SnapshotUnderlying>,
  w: number,
  today: string,
): { hits: Map<string, PresetId[]>; counts: Record<PresetId, number> } {
  const ctx: EvalContext = { underlyings, today };
  const counts = Object.fromEntries(PRESETS.map((p) => [p.id, 0])) as Record<PresetId, number>;
  const hits = new Map<string, PresetId[]>();
  const add = (id: string, p: PresetId) => {
    const list = hits.get(id);
    if (list) list.push(p); else hits.set(id, [p]);
    counts[p] += 1;
  };

  for (const row of rows) {
    for (const p of PRESETS) {
      const test = ROW_TESTS[p.id];
      if (test && test(row, w, ctx)) add(row.id, p.id);
    }
  }

  const byKey = new Map<string, SnapshotRow>();
  for (const r of rows) byKey.set(`${r.u}|${r.e}|${r.s}|${r.t}`, r);
  const gh = groupHits(allGroups, byKey, w);
  for (const [pid, ids] of gh) for (const id of ids) add(id, pid);

  return { hits, counts };
}

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

export interface ScreenerFilters {
  segment: 'all' | Segment;
  symbols: string[];            // empty = all underlyings
  expiry: 'all' | 'near' | 'next' | string;
  type: 'both' | OptType;
  maxOff: number;               // strikes from ATM, ≥ the collector's band = no limit
}

export function sanitizeFilters(raw: Record<string, unknown> | null | undefined): ScreenerFilters {
  const r = raw ?? {};
  const seg = String(r.segment ?? 'all');
  const type = String(r.type ?? 'both');
  const exp = String(r.expiry ?? 'all');
  const symbols = Array.isArray(r.symbols)
    ? r.symbols.map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z0-9&\-_]{1,30}$/.test(s)).slice(0, 300)
    : [];
  const maxOff = Math.max(0, Math.min(15, Math.floor(Number(r.maxOff ?? 15)) || 0));
  return {
    segment: seg === 'index' || seg === 'stock' || seg === 'mcx' ? seg : 'all',
    symbols,
    expiry: exp === 'near' || exp === 'next' || /^\d{4}-\d{2}-\d{2}$/.test(exp) ? exp : 'all',
    type: type === 'CE' || type === 'PE' ? type : 'both',
    maxOff: r.maxOff == null ? 15 : maxOff,
  };
}

/** Nearest / next expiry per underlying, from the rows actually in the snapshot. */
export function expiryRanks(rows: SnapshotRow[]): Map<string, string[]> {
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = m.get(r.u);
    if (!s) { s = new Set(); m.set(r.u, s); }
    s.add(r.e);
  }
  const out = new Map<string, string[]>();
  for (const [u, s] of m) out.set(u, [...s].sort());
  return out;
}

export function applyFilters(rows: SnapshotRow[], f: ScreenerFilters): SnapshotRow[] {
  const syms = f.symbols.length ? new Set(f.symbols) : null;
  const ranks = f.expiry === 'near' || f.expiry === 'next' ? expiryRanks(rows) : null;
  return rows.filter((r) => {
    if (f.segment !== 'all' && r.k !== f.segment) return false;
    if (syms && !syms.has(r.u)) return false;
    if (f.type !== 'both' && r.t !== f.type) return false;
    if (Math.abs(r.off) > f.maxOff) return false;
    if (f.expiry === 'all') return true;
    if (ranks) {
      const list = ranks.get(r.u) ?? [];
      return r.e === (f.expiry === 'near' ? list[0] : list[1]);
    }
    return r.e === f.expiry;
  });
}

// ---------------------------------------------------------------------------
// result rows (what the page renders)
// ---------------------------------------------------------------------------

export interface ResultRow {
  id: string;
  sid: string;
  xs: string;
  x: 'NSE' | 'BSE' | 'MCX';
  u: string;
  k: Segment;
  e: string;
  s: number;
  t: OptType;
  money: string;
  lot: number;
  mult: number;
  tick: number;
  ltp: number;
  oi: number;
  dayVol: number;
  iv: number | null;
  pPct: number | null;
  oiPct: number | null;
  winVol: number | null;
  rvol: number | null;
  ivChg: number | null;
  spot: number | null;
  ts: number;
  tags: string[];
  presets: PresetId[];
  /** Still matching this scan (sticky preset hits that stopped matching are false). */
  active: boolean;
  /** Sort key used for the initial / re-sorted order. */
  score: number;
  d: Record<string, WindowDiff | null>;
}

export function toResultRow(
  row: SnapshotRow,
  w: number,
  underlyings: Record<string, SnapshotUnderlying>,
  presets: PresetId[] = [],
  active = true,
  score = 0,
): ResultRow {
  return {
    id: row.id, sid: row.sid, xs: row.xs, x: row.x, u: row.u, k: row.k, e: row.e, s: row.s, t: row.t,
    money: moneyness(row.t, row.off),
    lot: row.lot, mult: row.mult, tick: row.tick,
    ltp: row.ltp, oi: row.oi, dayVol: row.v, iv: row.iv,
    pPct: diffAt(row, w, D_PRICE_PCT),
    oiPct: diffAt(row, w, D_OI_PCT),
    winVol: diffAt(row, w, D_WIN_VOL),
    rvol: diffAt(row, w, D_RVOL),
    ivChg: diffAt(row, w, D_IV_CHG),
    spot: underlyings[row.u]?.spot ?? null,
    ts: row.ts,
    tags: presets.map((p) => PRESET_BY_ID[p].tag),
    presets,
    active,
    score,
    d: row.d,
  };
}

/** Round a price to the contract's tick (Dhan rejects off-tick limit prices). */
export function roundToTick(price: number, tick: number): number {
  const t = tick > 0 ? tick : 0.05;
  return Math.round(Math.round(price / t) * t * 100) / 100;
}

// ---------------------------------------------------------------------------
// API contract
// ---------------------------------------------------------------------------

export interface ScanRequest {
  filters: Partial<ScreenerFilters>;
  window: number;
  conditions: ScanCondition[];
  presets: PresetId[];
  match: 'any' | 'all';
  /** Contracts the page already listed as preset hits today — returned with current values
   *  even once they stop matching, so the hit log doesn't lose rows between scans. */
  sticky: string[];
}

export interface ScanResponse {
  success: boolean;
  error?: string;
  /** false until the collector has written its first snapshot. */
  hasData: boolean;
  dataDate: string | null;
  generatedAt: string | null;
  snapshotAgeSec: number | null;
  exchanges: Snapshot['exchanges'] | null;
  window: number;
  totalContracts: number;
  filteredContracts: number;
  symbols: { u: string; k: Segment }[];
  expiries: string[];
  custom: ResultRow[];
  customTotal: number;
  presetCounts: Record<PresetId, number>;
  presetHits: ResultRow[];
}

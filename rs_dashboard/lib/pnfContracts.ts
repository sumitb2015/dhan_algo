import fs from 'fs';
import path from 'path';

// F&O contracts for the Point & Figure page, from master_list.csv, resolved server-side: a security id is only ever looked up
// here, never taken from the browser. NSE index/stock futures and options, MCX commodity futures and options; expired contracts
// and NSE's `<n>NSETEST` dummy underlyings are dropped. Parsed once per file mtime, header-indexed (like lib/derivativeTick.ts).

const MASTER = path.join(path.resolve(process.cwd(), '..'), 'master_list.csv');

export type FnoKind = 'futures' | 'options';
export type OptType = 'CE' | 'PE';

export type FnoRow = {
  exch: 'NSE' | 'MCX';
  segment: 'NSE_FNO' | 'MCX_COMM';
  securityId: string;
  instrument: string;               // FUTIDX / FUTSTK / FUTCOM / OPTIDX / OPTSTK / OPTFUT
  underlying: string;
  displayName: string;
  expiry: string;                   // YYYY-MM-DD
  strike: number;                   // options only (futures carry -0.01 / 0)
  optType: OptType | null;
  lot: number;
};

export type Contract = Pick<FnoRow, 'segment' | 'securityId' | 'instrument' | 'displayName' | 'lot' | 'expiry'>;

const FUT = new Set(['FUTIDX', 'FUTSTK', 'FUTCOM']);
const OPT = new Set(['OPTIDX', 'OPTSTK', 'OPTFUT']);
const DUMMY = /^\d+NSETEST$/;

/** The live F&O rows in a master_list.csv text (expiry on or after `todayIso`). Pure: the parsing rules are tested on it. */
export function parseFnoRows(text: string, todayIso: string): FnoRow[] {
  const lines = text.split('\n');
  const head = lines[0].replace(/\r$/, '').split(',');
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`master_list.csv has no ${name} column`);
    return i;
  };
  const iEx = col('EXCH_ID'), iSeg = col('SEGMENT'), iId = col('SECURITY_ID'), iInst = col('INSTRUMENT'), iU = col('UNDERLYING_SYMBOL');
  const iDisp = col('DISPLAY_NAME'), iExp = col('SM_EXPIRY_DATE'), iK = col('STRIKE_PRICE'), iOt = col('OPTION_TYPE'), iLot = col('LOT_SIZE');
  const out: FnoRow[] = [];
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n];
    if (!line || line.includes('"')) continue;                 // derivative rows never quote a field
    const f = line.replace(/\r$/, '').split(',');
    const exch = f[iEx];
    const nse = exch === 'NSE' && f[iSeg] === 'D';
    if (!nse && !(exch === 'MCX' && f[iSeg] === 'M')) continue;
    const instrument = f[iInst];
    const isOpt = OPT.has(instrument);
    if (!isOpt && !FUT.has(instrument)) continue;
    if (exch === 'MCX' && instrument !== 'FUTCOM' && instrument !== 'OPTFUT') continue;   // MCX index futures/options: out of scope
    const underlying = f[iU];
    if (!underlying || DUMMY.test(underlying)) continue;
    const expiry = f[iExp].slice(0, 10);
    if (expiry < todayIso) continue;
    const ot = f[iOt];
    if (isOpt && ot !== 'CE' && ot !== 'PE') continue;
    out.push({
      exch: nse ? 'NSE' : 'MCX', segment: nse ? 'NSE_FNO' : 'MCX_COMM', securityId: f[iId], instrument, underlying,
      displayName: f[iDisp].replace(/\s+/g, ' ').trim(), expiry, strike: isOpt ? Number(f[iK]) : 0,
      optType: isOpt ? (ot as OptType) : null, lot: Number(f[iLot]) || 0,
    });
  }
  return out;
}

/** NSE spot index ids (IDX_I) by symbol, from the master's `NSE,I,…,INDEX` rows. Pure. */
export function parseIndexIds(text: string): Map<string, string> {
  const lines = text.split('\n');
  const head = lines[0].replace(/\r$/, '').split(',');
  const iId = head.indexOf('SECURITY_ID'), iInst = head.indexOf('INSTRUMENT'), iU = head.indexOf('UNDERLYING_SYMBOL');
  const out = new Map<string, string>();
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n];
    if (!line.startsWith('NSE,I,')) continue;
    const f = line.split(',');
    if (f[iInst] === 'INDEX' && f[iU] && !out.has(f[iU])) out.set(f[iU], f[iId]);
  }
  return out;
}

type Index = { mtime: number; day: string; rows: FnoRow[]; indexIds: Map<string, string> };
let cache: Index | null = null;

const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

function load(): Index {
  const mtime = fs.statSync(MASTER).mtimeMs;
  const day = istToday();
  if (cache && cache.mtime === mtime && cache.day === day) return cache;
  const text = fs.readFileSync(MASTER, 'utf8');
  cache = { mtime, day, rows: parseFnoRows(text, day), indexIds: parseIndexIds(text) };
  return cache;
}
const rows = () => load().rows;

/** The distinct underlyings of each kind, computed once per parsed row set (a search keystroke must not rescan every F&O row). */
type Und = { symbol: string; exch: 'NSE' | 'MCX'; instrument: string };
const undCache = new WeakMap<FnoRow[], Record<FnoKind, Und[]>>();
function underlyingsOf(from: FnoRow[]): Record<FnoKind, Und[]> {
  const hit = undCache.get(from);
  if (hit) return hit;
  const pick = (kind: FnoKind) => {
    const seen = new Map<string, Und>();
    for (const r of from) if (ofKind(r, kind) && !seen.has(r.underlying)) seen.set(r.underlying, { symbol: r.underlying, exch: r.exch, instrument: r.instrument });
    return [...seen.values()];
  };
  const out = { futures: pick('futures'), options: pick('options') };
  undCache.set(from, out);
  return out;
}

const ofKind = (r: FnoRow, kind: FnoKind) => (kind === 'futures' ? r.optType === null : r.optType !== null);

/** Underlyings with live contracts of `kind`, matching `q` (prefix first), index/MCX names before stocks of the same rank. */
export function fnoUnderlyings(kind: FnoKind, q: string, limit = 10, from: FnoRow[] = rows()): Und[] {
  const query = q.trim().toUpperCase();
  const all = underlyingsOf(from)[kind];
  const rank = (s: string) => (s.startsWith(query) ? 0 : s.includes(query) ? 1 : 2);
  return all.filter(u => !query || rank(u.symbol) < 2)
    .sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol))
    .slice(0, limit);
}

export function hasUnderlying(kind: FnoKind, underlying: string, from: FnoRow[] = rows()): boolean {
  return from.some(r => r.underlying === underlying && ofKind(r, kind));
}

/** Live expiries of `kind` for `underlying`, soonest first. */
export function expiriesFor(kind: FnoKind, underlying: string, from: FnoRow[] = rows()): string[] {
  return [...new Set(from.filter(r => r.underlying === underlying && ofKind(r, kind)).map(r => r.expiry))].sort();
}

/** Strikes with BOTH a CE and a PE for `underlying` at `expiry`, ascending (a straddle needs both legs). */
export function strikesFor(underlying: string, expiry: string, from: FnoRow[] = rows()): number[] {
  const sides = new Map<number, Set<string>>();
  for (const r of from) {
    if (r.underlying !== underlying || r.expiry !== expiry || r.optType === null) continue;
    (sides.get(r.strike) ?? sides.set(r.strike, new Set()).get(r.strike)!).add(r.optType);
  }
  return [...sides].filter(([, s]) => s.size === 2).map(([k]) => k).sort((a, b) => a - b);
}

/** The listed strike nearest `spot`; the middle strike when there is no usable spot. Null for an empty list. */
export function atmStrike(strikes: number[], spot: number | null): number | null {
  if (!strikes.length) return null;
  if (spot === null || !(spot > 0)) return strikes[Math.floor((strikes.length - 1) / 2)];
  return strikes.reduce((best, k) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best), strikes[0]);
}

const toContract = (r: FnoRow): Contract =>
  ({ segment: r.segment, securityId: r.securityId, instrument: r.instrument, displayName: r.displayName, lot: r.lot, expiry: r.expiry });

export function resolveFuture(underlying: string, expiry: string, from: FnoRow[] = rows()): Contract | null {
  const r = from.find(x => x.underlying === underlying && x.expiry === expiry && x.optType === null);
  return r ? toContract(r) : null;
}

export function resolveOption(underlying: string, expiry: string, strike: number, optType: OptType, from: FnoRow[] = rows()): Contract | null {
  const r = from.find(x => x.underlying === underlying && x.expiry === expiry && x.optType === optType && Math.abs(x.strike - strike) < 1e-6);
  return r ? toContract(r) : null;
}

/**
 * Where the underlying's spot price comes from, for the ATM default: an NSE index (its IDX_I id from the master's INDEX rows), an
 * NSE stock, or its nearest future — MCX commodities, and NSE index F&O whose index has no INDEX row (e.g. NIFTYFPI).
 */
export function spotSourceKind(underlying: string, from: FnoRow[] = rows(), indexIds: Map<string, string> = load().indexIds): 'index' | 'equity' | 'future' | null {
  const r = from.find(x => x.underlying === underlying);
  if (!r) return null;
  if (r.exch === 'MCX') return 'future';
  if (!r.instrument.endsWith('IDX')) return 'equity';
  return indexIds.has(underlying) ? 'index' : 'future';
}

/** The NSE spot index id (IDX_I) for an index underlying, from the master's INDEX rows; null when it has none. */
export function indexSpotId(underlying: string, indexIds: Map<string, string> = load().indexIds): string | null {
  return indexIds.get(underlying) ?? null;
}

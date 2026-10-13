import fs from 'fs';
import path from 'path';

// Tick size of a derivative contract from master_list.csv, resolved server-side. The master stores TICK_SIZE in
// PAISE (5.0 = Rs 0.05, an MCX contract can be 50.0 = Rs 0.50). Keyed by exchange + security id because ids are
// only unique per exchange. Parsed once per file mtime; only option/future rows kept.

const MASTER = path.join(path.resolve(process.cwd(), '..'), 'master_list.csv');
const SEGMENT_EXCH: Record<string, string> = { NSE_FNO: 'NSE', BSE_FNO: 'BSE', MCX_COMM: 'MCX' };

let cache: { mtime: number; ticks: Map<string, number> } | null = null;

function load(): Map<string, number> {
  const mtime = fs.statSync(MASTER).mtimeMs;
  if (cache && cache.mtime === mtime) return cache.ticks;
  const lines = fs.readFileSync(MASTER, 'utf8').split('\n');
  const head = lines[0].replace(/\r$/, '').split(',');
  const iEx = head.indexOf('EXCH_ID'), iId = head.indexOf('SECURITY_ID'), iInst = head.indexOf('INSTRUMENT'), iTick = head.indexOf('TICK_SIZE');
  if ([iEx, iId, iInst, iTick].some(i => i < 0)) throw new Error('master_list.csv header changed');
  const ticks = new Map<string, number>();
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n];
    if (!line || line.includes('"')) continue;   // derivative rows never quote a field
    const f = line.split(',');
    if (!f[iInst].startsWith('OPT') && !f[iInst].startsWith('FUT')) continue;
    const paise = Number(f[iTick]);
    if (paise > 0) ticks.set(`${f[iEx]}|${f[iId]}`, Math.round(paise) / 100);
  }
  cache = { mtime, ticks };
  return ticks;
}

/** Tick in rupees, or null when the contract/segment is unknown or the master cannot be read. */
export function derivativeTick(securityId: string, exchangeSegment: string): number | null {
  const exch = SEGMENT_EXCH[String(exchangeSegment).toUpperCase()];
  if (!exch) return null;
  try { return load().get(`${exch}|${securityId}`) ?? null; } catch { return null; }
}

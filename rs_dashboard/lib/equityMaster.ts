import fs from 'fs';
import path from 'path';

// NSE cash-equity lookup from master_list.csv, resolved server-side so an order route never
// trusts a client-supplied security id. Parsed once per file mtime; only NSE EQUITY rows kept.

const MASTER = path.join(path.resolve(process.cwd(), '..'), 'master_list.csv');

export interface EquityInfo {
  symbol: string;
  securityId: string;
  name: string;
  isin: string;
  tick: number; // INR (the master stores paise)
  series: string;
}

interface Master { mtime: number; bySymbol: Map<string, EquityInfo>; byId: Map<string, EquityInfo> }
let master: Master | null = null;

const SERIES_RANK: Record<string, number> = { EQ: 0, BE: 1 };

function splitCsv(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function load(): Master {
  const mtime = fs.statSync(MASTER).mtimeMs;
  if (master && master.mtime === mtime) return master;
  const bySymbol = new Map<string, EquityInfo>();
  const byId = new Map<string, EquityInfo>();
  for (const line of fs.readFileSync(MASTER, 'utf8').split('\n')) {
    if (!line.startsWith('NSE,E,')) continue;
    const f = splitCsv(line);
    if (f[4] !== 'EQUITY' || !(f[10] in SERIES_RANK)) continue;
    const tickPaise = Number(f[15]);
    const info: EquityInfo = {
      symbol: f[6], securityId: f[2], name: f[7], isin: f[3], series: f[10],
      tick: tickPaise > 0 ? tickPaise / 100 : 0,
    };
    byId.set(info.securityId, info);
    const prev = bySymbol.get(info.symbol);
    if (!prev || SERIES_RANK[info.series] < SERIES_RANK[prev.series]) bySymbol.set(info.symbol, info);
  }
  master = { mtime, bySymbol, byId };
  return master;
}

export function findEquity(symbol: string): EquityInfo | null {
  return load().bySymbol.get(symbol.trim().toUpperCase()) ?? null;
}

export function findEquityById(securityId: string): EquityInfo | null {
  return load().byId.get(String(securityId)) ?? null;
}

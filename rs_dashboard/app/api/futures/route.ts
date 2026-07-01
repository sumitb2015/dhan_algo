import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContractStats {
  expiry: string;
  label: string;
  daysToExpiry: number;
  price: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  oi: number;
  oiChange: number;
  oiHasData: boolean;
  basis: number | null;
  sparkline: { time: string; oi: number }[];
}

export interface FuturesResponse {
  success: boolean;
  dataDate: string;
  instruments: {
    NIFTY: ContractStats[];
    BANKNIFTY: ContractStats[];
  };
  error?: string;
}

interface Row {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number;
  contract: string;
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function parseFuturesCsv(filePath: string): Row[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const idx = (col: string) => headers.indexOf(col);
  const hasOI = idx('OI') !== -1;
  return lines.slice(1).flatMap(line => {
    const v = line.split(',');
    const get = (col: string) => (v[idx(col)] ?? '').trim();
    const row: Row = {
      datetime: get('Datetime'),
      open: parseFloat(get('Open')) || 0,
      high: parseFloat(get('High')) || 0,
      low: parseFloat(get('Low')) || 0,
      close: parseFloat(get('Close')) || 0,
      volume: parseFloat(get('Volume')) || 0,
      oi: hasOI ? (parseFloat(get('OI')) || 0) : 0,
      contract: get('Contract'),
    };
    return row.datetime && row.contract ? [row] : [];
  });
}

function toDate(datetime: string): string {
  return datetime.split(' ')[0]; // "2026-07-01"
}

function toTime(datetime: string): string {
  return (datetime.split(' ')[1] ?? '').substring(0, 5); // "09:15"
}

function fmtLabel(expiry: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [, m, d] = expiry.split('-');
  return `${months[parseInt(m) - 1]} ${parseInt(d)}`;
}

function niftySpotClose(): number | null {
  const p = path.join(PROJECT_ROOT, 'Historical Data', 'NIFTY_50_Daily_5Y.csv');
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf-8').trim().split('\n');
  if (lines.length < 2) return null;
  const headers = lines[0].split(',').map(h => h.trim());
  const closeIdx = headers.indexOf('Close');
  if (closeIdx === -1) return null;
  const last = lines[lines.length - 1].split(',');
  return parseFloat(last[closeIdx]) || null;
}

// ─── Per-contract computation ─────────────────────────────────────────────────

function buildContracts(
  rows: Row[],
  spotClose: number | null,
  useSpot: boolean
): ContractStats[] {
  const byContract = new Map<string, Row[]>();
  for (const row of rows) {
    if (!byContract.has(row.contract)) byContract.set(row.contract, []);
    byContract.get(row.contract)!.push(row);
  }

  const result: ContractStats[] = [];

  for (const [expiry, cRows] of byContract) {
    cRows.sort((a, b) => a.datetime.localeCompare(b.datetime));

    const dates = [...new Set(cRows.map(r => toDate(r.datetime)))].sort();
    const latestDate = dates[dates.length - 1];
    const prevDate = dates.length > 1 ? dates[dates.length - 2] : null;

    const todayRows = cRows.filter(r => toDate(r.datetime) === latestDate);
    const prevRows = prevDate ? cRows.filter(r => toDate(r.datetime) === prevDate) : [];

    const hasOI = todayRows.some(r => r.oi > 0);
    const latestOI = todayRows.length ? todayRows[todayRows.length - 1].oi : 0;
    const prevOI = prevRows.length ? prevRows[prevRows.length - 1].oi : 0;

    const latestClose = todayRows.length ? todayRows[todayRows.length - 1].close : 0;
    const expiryMs = new Date(expiry).getTime();
    const daysToExpiry = Math.ceil((expiryMs - Date.now()) / 86400000);

    result.push({
      expiry,
      label: fmtLabel(expiry),
      daysToExpiry,
      price: latestClose,
      open: todayRows.length ? todayRows[0].open : 0,
      high: todayRows.length ? Math.max(...todayRows.map(r => r.high)) : 0,
      low: todayRows.length ? Math.min(...todayRows.map(r => r.low)) : 0,
      volume: todayRows.reduce((s, r) => s + r.volume, 0),
      oi: latestOI,
      oiChange: latestOI - prevOI,
      oiHasData: hasOI,
      basis: useSpot && spotClose !== null ? latestClose - spotClose : null,
      sparkline: todayRows.map(r => ({ time: toTime(r.datetime), oi: r.oi })),
    });
  }

  return result.sort((a, b) => a.expiry.localeCompare(b.expiry));
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const spotClose = niftySpotClose();

    const niftyRows = parseFuturesCsv(
      path.join(PROJECT_ROOT, 'Historical Data', 'NIFTY_Futures_1min_Manual.csv')
    );
    const bnfRows = parseFuturesCsv(
      path.join(PROJECT_ROOT, 'Historical Data', 'BANKNIFTY_Futures_1min_Manual.csv')
    );

    if (!niftyRows.length && !bnfRows.length) {
      return NextResponse.json<FuturesResponse>({
        success: false,
        dataDate: '',
        instruments: { NIFTY: [], BANKNIFTY: [] },
        error: 'No futures data found. Run scripts/downloader/download_futures_manual.py first.',
      });
    }

    const niftyContracts = buildContracts(niftyRows, spotClose, true);
    const bnfContracts = buildContracts(bnfRows, null, false);

    const allDates = [...niftyRows, ...bnfRows]
      .map(r => toDate(r.datetime))
      .filter(Boolean)
      .sort();
    const dataDate = allDates[allDates.length - 1] ?? '';

    return NextResponse.json<FuturesResponse>({
      success: true,
      dataDate,
      instruments: { NIFTY: niftyContracts, BANKNIFTY: bnfContracts },
    });
  } catch (e: unknown) {
    return NextResponse.json<FuturesResponse>({
      success: false,
      dataDate: '',
      instruments: { NIFTY: [], BANKNIFTY: [] },
      error: e instanceof Error ? e.message : 'Unknown error',
    });
  }
}

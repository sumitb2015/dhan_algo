// Server side of the /candlestick page's pre-2019 history: Daily_Historical_Data_Fresh starts on 2019-01-01, so the
// chart puts Yahoo's daily rows from 2008 in front of it, rescaled onto the CSV's price basis (rebaseYahoo, the twin of
// the P&F page's rebase_yahoo). Raw Yahoo rows are cached in Historical Data/Yahoo_Daily_Pre2019/<SYMBOL>.csv, the
// same files the P&F page uses; a missing file is fetched once by scripts/tools/yahoo_pre2019.py (bulk: --all).

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, dedupe, runPythonJson } from './pyExec';
import { globalOnce } from './globalOnce';
import { parseYahooCsv, rebaseYahoo, type CandleRow } from './equityChart';

const PRE_DIR = path.join(PROJECT_ROOT, 'Historical Data', 'Yahoo_Daily_Pre2019');
const FETCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'yahoo_pre2019.py');
/** A symbol Yahoo gave nothing for (or the fetch failed) is not asked again for this long. */
const MISS_TTL_MS = 6 * 3600_000;
/** Only stitch when the CSV starts after this: older CSVs already cover the period. */
const STITCH_BEFORE = '2008-01-02';

const misses = globalOnce('equityPre2019Misses', () => new Map<string, number>());

export interface PreHistory {
  rows: CandleRow[];
  /** 'stitched': rows came back; 'refused': the two price bases did not line up; 'unavailable': no Yahoo data. */
  status: 'stitched' | 'refused' | 'unavailable' | 'not-needed';
  note?: string;
}

async function readCache(symbol: string): Promise<CandleRow[] | null> {
  try {
    return parseYahooCsv(await fs.promises.readFile(path.join(PRE_DIR, `${symbol}.csv`), 'utf-8'));
  } catch {
    return null;
  }
}

/** Yahoo rows before `csv`'s first day on its price basis. `symbol` must already be a validated NSE stock symbol. */
export async function loadPreHistory(symbol: string, csv: CandleRow[]): Promise<PreHistory> {
  if (csv.length === 0 || csv[0].date < STITCH_BEFORE) return { rows: [], status: 'not-needed' };
  let yahoo = await readCache(symbol);
  if (yahoo === null) {
    const missAt = misses.get(symbol);
    if (missAt !== undefined && Date.now() - missAt < MISS_TTL_MS) return { rows: [], status: 'unavailable' };
    try {
      await dedupe(`yahoo-pre2019:${symbol}`, () => runPythonJson<{ ok: boolean }>(FETCH_SCRIPT, [symbol], 45_000));
    } catch (err) {
      console.warn(`[equity-candles] pre-2019 fetch for ${symbol} failed:`, err instanceof Error ? err.message : err);
    }
    yahoo = await readCache(symbol);
    if (yahoo === null) {
      misses.set(symbol, Date.now());
      return { rows: [], status: 'unavailable' };
    }
  }
  const r = rebaseYahoo(yahoo, csv);
  if ('refused' in r) return { rows: [], status: 'refused', note: r.refused };
  if (r.rows.length === 0) return { rows: [], status: 'not-needed' };
  return { rows: r.rows, status: 'stitched', note: Math.abs(r.factor - 1) > 0.001 ? `rescaled x${r.factor.toFixed(4)}` : undefined };
}

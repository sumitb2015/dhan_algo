import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { runPythonJson, dedupe, PROJECT_ROOT } from '@/lib/pyExec';
import { readNifty50Index } from '@/lib/dataLoader';

// Kotak has no historical trade API — `NeoAPI.trade_report()` returns only the current day's book,
// with no date parameters — so unlike the Dhan side (which syncs from the broker), this data comes
// from Gain/Loss statement exports the user drops into REPORT_DIR. See the importer's docstring.
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'import_kotak_pnl_reports.py');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const REPORT_DIR = path.join(DEBUG_DIR, 'kotak_pnl_reports');
const HISTORY_FILE = path.join(DEBUG_DIR, 'kotak_trade_history.json');

const IMPORT_TIMEOUT_MS = 120_000;

interface DropFile {
  name: string;
  size: number;
  modified: string;
}

/** Exports sitting in the drop folder. `~$*.xlsx` are Excel lock files, not real exports. */
function listDropFiles(): DropFile[] {
  try {
    return fs
      .readdirSync(REPORT_DIR)
      .filter(f => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
      .map(f => {
        const st = fs.statSync(path.join(REPORT_DIR, f));
        return { name: f, size: st.size, modified: st.mtime.toISOString() };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

interface DailyPoint { date: string; tradeCount: number; [k: string]: unknown }

/**
 * Snap each period's stamp date back to the last real market day on or before it.
 *
 * The importer stamps a period at its export end date, which is whatever date the user picked --
 * frequently a Saturday. That matters beyond cosmetics: the diary's Day-of-Week panel filters to
 * Mon-Fri, so a point parked on a weekend disappears from it completely, and the weekly bucket it
 * lands in can be the one *after* the week the trading actually happened. Snapping to the NSE
 * calendar (same source the Dhan route uses for "Trading Days") keeps the point on a day the market
 * was open. Purely a placement fix -- no P&L figure is altered.
 */
function snapToMarketDays(points: DailyPoint[], marketDates: string[]): DailyPoint[] {
  if (!points.length || !marketDates.length) return points;
  const sorted = [...marketDates].sort();
  const snapped = points.map(p => {
    if (p.date <= sorted[0]) return p;
    // Last market date <= p.date, via binary search.
    let lo = 0, hi = sorted.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= p.date) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best === -1 ? p : { ...p, date: sorted[best], stampedFrom: p.date };
  });

  // Two periods could in principle snap onto the same market day; sum rather than let one win.
  const byDate = new Map<string, DailyPoint>();
  for (const p of snapped) {
    const prev = byDate.get(p.date);
    if (!prev) { byDate.set(p.date, p); continue; }
    byDate.set(p.date, {
      ...prev,
      grossPnl: (prev.grossPnl as number) + (p.grossPnl as number),
      charges: (prev.charges as number) + (p.charges as number),
      statutoryCharges: (prev.statutoryCharges as number) + (p.statutoryCharges as number),
      netPnl: (prev.netPnl as number) + (p.netPnl as number),
      tradeCount: prev.tradeCount + p.tradeCount,
    });
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export async function GET() {
  const dropFiles = listDropFiles();
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return NextResponse.json({ success: true, available: false, dropFiles, reportDir: REPORT_DIR });
    }
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));

    let marketTradingDates: string[] = [];
    if (data.fromDate && data.toDate) {
      const nifty = readNifty50Index();
      marketTradingDates = nifty.filter(r => r.date >= data.fromDate && r.date <= data.toDate).map(r => r.date);
    }
    if (Array.isArray(data.dailyPnl)) {
      const allMarketDates = readNifty50Index().map(r => r.date);
      data.dailyPnl = snapToMarketDays(data.dailyPnl, allMarketDates);
      // Snap every per-segment series too. Must be derived from the importer's own segment split —
      // an earlier version hardcoded { ALL, FNO } here, which silently aliased FNO to the all-segment
      // total and dropped COMMODITY entirely once commodity trades started arriving.
      if (data.dailyPnlBySegment && typeof data.dailyPnlBySegment === 'object') {
        data.dailyPnlBySegment = Object.fromEntries(
          Object.entries(data.dailyPnlBySegment as Record<string, DailyPoint[]>).map(([seg, pts]) => [
            seg,
            seg === 'ALL' ? data.dailyPnl : snapToMarketDays(pts, allMarketDates),
          ]),
        );
      }
    }

    // An export dropped since the last import is invisible until re-imported. Flag that rather than
    // quietly serving stale totals — the file being on disk reads to the user as "it's loaded".
    const imported = new Set<string>((data.periods ?? []).map((p: { sourceFile: string }) => p.sourceFile));
    for (const s of data.skipped ?? []) imported.add(s.sourceFile);
    for (const f of data.failures ?? []) imported.add(f.sourceFile);
    const pendingFiles = dropFiles.filter(f => !imported.has(f.name)).map(f => f.name);

    return NextResponse.json({ success: true, available: true, dropFiles, pendingFiles, reportDir: REPORT_DIR, marketTradingDates, ...data });
  } catch {
    return NextResponse.json({ success: true, available: false, dropFiles, reportDir: REPORT_DIR });
  }
}

// POST { action: "import" } — re-parse every export in the drop folder. Cheap (local file parse, no
// broker calls), so it just runs synchronously rather than using the spawn+poll status-file pattern
// the broker-backed refresh routes need.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.action !== 'import') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
  if (!fs.existsSync(REPORT_DIR) || listDropFiles().length === 0) {
    return NextResponse.json(
      { ok: false, error: `No .xlsx exports found in ${REPORT_DIR}. Drop Kotak Gain/Loss exports there first.` },
      { status: 409 },
    );
  }
  try {
    const result = await dedupe('kotak-pnl-import', () =>
      runPythonJson<Record<string, unknown>>(SCRIPT, [], IMPORT_TIMEOUT_MS),
    );
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

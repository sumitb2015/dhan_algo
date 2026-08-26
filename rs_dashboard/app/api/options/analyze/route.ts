import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { buildPositionSnapshot } from '@/lib/positionSnapshot';
import { ANALYTICS_UNDERLYINGS, type AnalyticsUnderlying } from '@/lib/analyticsUnderlyings';
import { PROJECT_ROOT, runPythonJson } from '@/lib/pyExec';
import type { Suggestion } from '../suggestions/route';

/**
 * The "Analyze" button on /options-analytics/[underlying]:
 * 1. Builds the live positions/payoff/greeks snapshot (lib/positionSnapshot.ts).
 * 2. Invokes the Antigravity Options Risk & Adjustment Analyzer (scripts/tools/antigravity_options_analyzer.py)
 *    to review risk profiling, Greeks balance, and generate concrete close/trim suggestions.
 * 3. Persists results to debug/options_suggestions_<UNDERLYING>.json so suggestions
 *    render immediately in the "Suggested Actions" panel.
 *
 * This never places an order. Every suggestion requires human confirmation via onConfirm/handleCloseLeg().
 */

const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'antigravity_options_analyzer.py');
const ANALYZE_TIMEOUT_MS = 45_000;

interface AnalyzerResult {
  success: boolean;
  underlying: string;
  summary: string;
  suggestions: Suggestion[];
  error?: string;
}

export async function POST(request: NextRequest) {
  let body: { underlying?: string; broker?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const underlyingRaw = (body.underlying ?? '').toUpperCase();
  if (!ANALYTICS_UNDERLYINGS.includes(underlyingRaw as AnalyticsUnderlying)) {
    return NextResponse.json({ success: false, error: `Unknown underlying: ${underlyingRaw}` }, { status: 400 });
  }
  const underlying = underlyingRaw as AnalyticsUnderlying;
  const broker = body.broker === 'kotak' ? 'kotak' : 'dhan';

  const cookie = request.headers.get('cookie') ?? '';
  if (!cookie) {
    return NextResponse.json({ success: false, error: 'No session cookie on this request' }, { status: 401 });
  }

  try {
    const snapshot = await buildPositionSnapshot({ underlying, broker, baseUrl: request.nextUrl.origin, cookie });

    if (!snapshot.legs.length) {
      return NextResponse.json({
        success: true,
        underlying,
        summary: `No open ${underlying} option positions on this broker — nothing to analyze.`,
        suggestions: [],
      });
    }

    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const snapshotFile = path.join(DEBUG_DIR, `snapshot_analyze_${underlying}.json`);
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2), 'utf8');

    // Run the Antigravity options analyzer
    const args = [
      '--underlying', underlying,
      '--broker', broker,
      '--snapshot-file', snapshotFile,
    ];

    const result = await runPythonJson<AnalyzerResult>(SCRIPT_PATH, args, ANALYZE_TIMEOUT_MS);

    // Clean up temporary snapshot file
    try {
      if (fs.existsSync(snapshotFile)) fs.unlinkSync(snapshotFile);
    } catch {
      // Ignore cleanup error
    }

    if (!result || result.success === false) {
      return NextResponse.json(
        { success: false, error: result?.error ?? 'Antigravity analysis failed to return a result' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      underlying,
      summary: result.summary,
      suggestions: result.suggestions ?? [],
    });
  } catch (err) {
    console.error('[/api/options/analyze]', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}

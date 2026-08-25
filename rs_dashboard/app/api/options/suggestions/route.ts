import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { ANALYTICS_UNDERLYINGS, type AnalyticsUnderlying } from '@/lib/analyticsUnderlyings';

/**
 * Read-only source for the "Suggested Actions" panel on the positions-analytics
 * page. A Claude session reviewing a book writes
 * debug/options_suggestions_<UNDERLYING>.json directly (this repo already has
 * filesystem access when a chat session is asked to check positions) — this
 * route only serves that file to the browser. Nothing here places, or can
 * place, an order: confirming a suggestion in the UI drives the SAME
 * handleCloseLeg()/closeLeg() flow the exit chips already use.
 *
 * "No suggestion file yet" is the normal state, not an error — missing or
 * malformed JSON returns an empty list rather than a 500, same convention as
 * app/api/copy-trade/route.ts's status file.
 */

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');

export interface Suggestion {
  id: string;
  strike: number;
  type: 'CE' | 'PE';
  expiry: string;
  side: 'BUY' | 'SELL';
  action: 'CLOSE' | 'TRIM';
  pct: 25 | 50 | 75 | 100;
  rationale: string;
}

export interface SuggestionsFile {
  underlying: AnalyticsUnderlying;
  generatedAt: string;
  expiresAt: string;
  suggestions: Suggestion[];
}

function readJson(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const underlyingRaw = (request.nextUrl.searchParams.get('underlying') ?? '').toUpperCase();

  // Validate BEFORE building the file path — the query string must never be
  // able to walk outside debug/.
  if (!ANALYTICS_UNDERLYINGS.includes(underlyingRaw as AnalyticsUnderlying)) {
    return NextResponse.json({ success: false, error: `Unknown underlying: ${underlyingRaw}` }, { status: 400 });
  }
  const underlying = underlyingRaw as AnalyticsUnderlying;

  const file = path.join(DEBUG_DIR, `options_suggestions_${underlying}.json`);
  const parsed = readJson(file) as SuggestionsFile | null;

  if (!parsed || !Array.isArray(parsed.suggestions)) {
    return NextResponse.json({ success: true, underlying, suggestions: [] as Suggestion[] });
  }

  // Expired suggestions are filtered out here (not just in the UI) so a
  // caller polling this route directly never sees stale actions either.
  const now = Date.now();
  const expiresAtMs = Date.parse(parsed.expiresAt);
  const live = Number.isFinite(expiresAtMs) && expiresAtMs > now ? parsed.suggestions : [];

  return NextResponse.json({ success: true, underlying, generatedAt: parsed.generatedAt, suggestions: live });
}

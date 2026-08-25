// Read-only snapshot of one underlying's open-position risk/payoff, for a
// Claude session asked to review a book and propose adjustments (see
// app/api/options/suggestions/route.ts and components/PositionsAnalysis.tsx's
// "Suggested Actions" panel for the other half of that flow) — or for manual
// eyeballing. The dashboard's own "Analyze" button (app/api/options/analyze/
// route.ts) does the same thing from inside the running server, so this
// script and that route share lib/positionSnapshot.ts's buildPositionSnapshot().
//
// Deliberately NOT a Next.js API route: this only ever needs to run on-demand
// from a terminal and never touches the running app's state. Run with plain
// `node` — Node's built-in TypeScript type-stripping handles this file the
// same way it already runs this repo's `lib/*.test.ts` files (see
// package.json's `test` script).
//
// Usage:
//   node scripts/analyze-positions.ts --underlying NIFTY [--broker dhan] [--base-url http://localhost:3000]
//
// Prints one JSON object to stdout: { underlying, spot, legs, netGreeks,
// payoffStats, exposure } — the same numbers /options-analytics/<underlying>
// renders in the browser for the same book.

import { createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildPositionSnapshot } from '../lib/positionSnapshot.ts';
import { ANALYTICS_UNDERLYINGS, type AnalyticsUnderlying } from '../lib/analyticsUnderlyings.ts';
import { COOKIE_SECRET, SESSION_COOKIE } from '../lib/auth.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const SESSION_FILE = path.join(PROJECT_ROOT, 'debug', 'session.json');

function parseArgs(argv: string[]): { underlying: string; broker: 'dhan' | 'kotak'; baseUrl: string } {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    underlying: get('--underlying', '').toUpperCase(),
    broker: (get('--broker', 'dhan').toLowerCase() as 'dhan' | 'kotak'),
    baseUrl: get('--base-url', 'http://localhost:3000'),
  };
}

/** Same session-cookie scheme as lib/session.ts's createDashboardSession() — mints one from an existing logged-in session rather than logging in again. */
function mintSessionCookie(): string {
  let raw: { sessions?: Record<string, unknown> };
  try {
    raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    throw new Error(`Could not read ${SESSION_FILE} — log into the dashboard at :3000 first, then re-run this script.`);
  }
  const uuid = Object.keys(raw.sessions ?? {})[0];
  if (!uuid) throw new Error(`No session found in ${SESSION_FILE} — log into the dashboard first.`);
  const sig = createHmac('sha256', COOKIE_SECRET).update(uuid).digest('hex');
  return `${SESSION_COOKIE}=${uuid}.${sig}`;
}

async function main() {
  const { underlying: underlyingRaw, broker, baseUrl } = parseArgs(process.argv.slice(2));
  if (!ANALYTICS_UNDERLYINGS.includes(underlyingRaw as AnalyticsUnderlying)) {
    console.error(`--underlying must be one of ${ANALYTICS_UNDERLYINGS.join(', ')}, got "${underlyingRaw}"`);
    process.exit(1);
  }
  const underlying = underlyingRaw as AnalyticsUnderlying;
  const cookie = mintSessionCookie();

  const snapshot = await buildPositionSnapshot({ underlying, broker, baseUrl, cookie });
  console.log(JSON.stringify(snapshot, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

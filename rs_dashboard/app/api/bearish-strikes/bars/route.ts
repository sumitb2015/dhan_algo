import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, dedupe, spaced, runPythonJson } from '@/lib/pyExec';

// Today's 1-minute OHLCV for a handful of option contracts — wraps
// scripts/tools/option_bars_batch.py (read-only). Per-contract cache for the current
// minute, so many tabs / quick refreshes never re-spawn; stale contracts are fetched
// in one spawn on the shared `dhan-spawn:<underlying>` lane (same account-wide Data API
// limit as the chain and Focus Tool VWAP routes). The page requests small chunks and
// loops; this route never fans out more than MAX_PER_CALL contracts.
//
// History: Supertrend / EMA20 need ~60 bars to settle, so the first fetch for a contract also pulls the
// last HISTORY_DAYS prior trading days. Those are immutable for the day, so they are cached once and every
// later per-minute refresh asks for today's bars only (VWAP resets per session downstream).

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'option_bars_batch.py');
const MAX_PER_CALL = 12;
const HISTORY_DAYS = 2;
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'CRUDEOIL', 'CRUDEOILM'];

interface Bar { t: string; o: number; h: number; l: number; c: number; v: number }
interface BatchResult { bars: Record<string, Bar[]>; errors: Record<string, string>; rateLimited?: boolean }
interface Entry { minute: string; bars: Bar[] }

const cache = new Map<string, Entry>();
/** Prior-day bars per contract, valid for the local calendar day they were fetched on. */
const history = new Map<string, { day: string; bars: Bar[] }>();

const localDay = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;   // same clock the Python script's date.today() uses
};
const failures = new Map<string, { minute: string; error: string }>();

// Dhan's Data API limit is per account, not per route. After a rate-limit answer (DH-904 / 805 / HTTP 429) stop
// spawning altogether for a while — asking again every minute for every contract would keep the limit tripped.
// Doubles on each repeat (90 s -> 5 min) and resets after a clean batch. Cached bars keep being served meanwhile.
let cooldownUntil = 0;
let cooldownStep = 90_000;
const COOLDOWN_MAX = 300_000;

const minuteKey = () => new Date().toISOString().slice(0, 16);

export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const underlying = (sp.get('underlying') ?? '').toUpperCase();
  const expiry = sp.get('expiry') ?? '';
  const contracts = (sp.get('contracts') ?? '')
    .split(',').map((s) => s.trim().toUpperCase())
    .filter((s) => /^\d+(\.\d+)?(CE|PE)$/.test(s))
    .slice(0, MAX_PER_CALL);

  if (!UNDERLYINGS.includes(underlying) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !contracts.length) {
    return NextResponse.json({ success: false, error: 'underlying, expiry (YYYY-MM-DD) and contracts (e.g. 24500CE) required' }, { status: 400 });
  }

  const now = minuteKey();
  const out: Record<string, Bar[]> = {};
  const errors: Record<string, string> = {};
  const stale: string[] = [];
  for (const c of contracts) {
    const k = `${underlying}:${expiry}:${c}`;
    const hit = cache.get(k);
    if (hit && hit.minute === now) { out[c] = hit.bars; continue; }
    if (Date.now() < cooldownUntil) {                                  // backing off: serve what we have, spawn nothing
      if (hit) out[c] = hit.bars; else errors[c] = 'rate limited';
      continue;
    }
    const bad = failures.get(k);
    if (bad && bad.minute === now) { errors[c] = bad.error; continue; }   // don't hammer a contract that just failed
    stale.push(c);
  }

  if (stale.length) {
    const day = localDay();
    const key = (c: string) => `${underlying}:${expiry}:${c}`;
    const needHistory = stale.filter((c) => history.get(key(c))?.day !== day);
    const todayOnly = stale.filter((c) => !needHistory.includes(c));
    const run = (contractsArg: string[], historyDays: number) =>
      dedupe(`bearish-bars:${underlying}:${expiry}:${contractsArg.join(',')}:${historyDays}:${now}`, () =>
        spaced(`dhan-spawn:${underlying}`, () =>
          runPythonJson<BatchResult>(
            SCRIPT,
            ['--underlying', underlying, '--expiry', expiry, '--contracts', contractsArg.join(','), '--history-days', String(historyDays)],
            historyDays > 0 ? 90_000 : 60_000,
          ),
        ),
      );
    for (const [group, days] of [[needHistory, HISTORY_DAYS], [todayOnly, 0]] as const) {
      if (!group.length) continue;
      try {
        const res = await run([...group], days);
        if (res.rateLimited) {
          cooldownUntil = Date.now() + cooldownStep;
          cooldownStep = Math.min(cooldownStep * 2, COOLDOWN_MAX);
          console.warn(`[bearish-strikes/bars] Dhan rate limit — backing off ${Math.round((cooldownUntil - Date.now()) / 1000)}s`);
        } else if (Object.keys(res.bars ?? {}).length) cooldownStep = 90_000;
        for (const c of group) {
          const k = key(c);
          const b = res.bars?.[c];
          if (!b) {
            const error = res.errors?.[c] ?? res.errors?.['*'] ?? 'no data';
            failures.set(k, { minute: now, error });
            errors[c] = error;
            continue;
          }
          let merged = b;
          if (days > 0) {
            history.set(k, { day, bars: b.filter((x) => x.t.slice(0, 10) < day) });   // may be empty (new strike): cached so it is not refetched
          } else {
            merged = [...(history.get(k)?.bars ?? []), ...b];
          }
          cache.set(k, { minute: now, bars: merged });
          out[c] = merged;
          failures.delete(k);
        }
      } catch (err) {
        for (const c of group) errors[c] = String(err);
      }
    }
  }

  const retryInS = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  return NextResponse.json({ success: true, bars: out, errors, rateLimited: retryInS > 0, retryInS });
}

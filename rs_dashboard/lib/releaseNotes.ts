/**
 * Release notes derived from `git log` — pure parsing, grouping and unread
 * maths. No I/O and no `@/` imports, so `node --test` can run it directly.
 */

export type NoteType = 'new' | 'fix' | 'perf';

export interface ReleaseNote {
  hash: string;
  /** ISO-8601 author date. */
  date: string;
  type: NoteType;
  scope: string | null;
  subject: string;
  /** First few lines of the commit body, trimmed. Empty when there is none. */
  detail: string;
  /** Dashboard page the scope maps to, or null when the scope is not a page. */
  href: string | null;
}

export interface NoteDay {
  /** YYYY-MM-DD (the commit's own calendar date, not the viewer's). */
  day: string;
  notes: ReleaseNote[];
}

const TYPE_MAP: Record<string, NoteType> = { feat: 'new', fix: 'fix', perf: 'perf' };

/** Scopes that are repo plumbing, never user-visible. */
const HIDDEN_SCOPES = new Set(['skills', 'claude', 'deps']);

/** Commit scope -> dashboard route. Only scopes that are a page of their own. */
export const SCOPE_TO_HREF: Record<string, string> = {
  'focus-tool': '/focus-tool',
  'multi-leg-focus': '/multi-leg-focus',
  baskets: '/baskets',
  'cyber-scalper': '/cyber-scalper',
  'advanced-scalper': '/advanced-scalper',
  'options-monitor': '/options-monitor',
  'options-screener': '/options-screener',
  'margin-allocator': '/margin-allocator',
  'synthetic-futures': '/synthetic-futures',
  'bearish-strikes': '/bearish-strikes',
  'rs-strategy': '/rs-strategy',
  'nifty-covered-call': '/nifty-covered-call',
  'ultimate-scanner': '/ultimate-scanner',
  'market-pulse': '/market-pulse',
  'us-markets': '/us-markets',
  'india-markets': '/india-markets',
  breakdown: '/breakdown-scalper',
  'breakdown-scalper': '/breakdown-scalper',
  scalping: '/breakdown-scalper',
  'algo-lab': '/algo-lab',
  algolab: '/algo-lab',
  'daily-market': '/daily-market',
  movers: '/movers',
  rrg: '/rrg',
  breadth: '/breadth',
  'fii-dii': '/fii-dii',
  momentum: '/momentum',
  strategies: '/strategies',
  backtest: '/backtest',
  'harvest-desk': '/harvest-desk',
  'cash-secured-puts': '/cash-secured-puts',
  csp: '/cash-secured-puts',
  'triple-straddle': '/options/triple-straddle',
  gex: '/options/gex',
};

/** Field / record separators used by RELEASE_LOG_FORMAT (git's %x1f / %x1e). */
const FS = '\x1f';
const RS = '\x1e';

/** `--pretty` format the API route passes to `git log`. */
export const RELEASE_LOG_FORMAT = '%H%x1f%aI%x1f%s%x1f%b%x1e';

const SUBJECT_RE = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;
const DETAIL_LINES = 4;

export function hrefForScope(scope: string | null): string | null {
  if (!scope) return null;
  return SCOPE_TO_HREF[scope.trim().toLowerCase()] ?? null;
}

function cleanDetail(body: string): string {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^co-authored-by:/i.test(l));
  return lines.slice(0, DETAIL_LINES).join('\n');
}

/**
 * Parse `git log --pretty=RELEASE_LOG_FORMAT` output. Keeps feat / fix / perf
 * only (docs, chore, test, style, refactor, data, merges and anything that is
 * not `type(scope): subject` are dropped), and drops hidden scopes. Newest
 * first, as git emits it.
 */
export function parseCommits(raw: string): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  for (const record of raw.split(RS)) {
    const fields = record.replace(/^\s+/, '').split(FS);
    if (fields.length < 3) continue;
    const [hash, date, rawSubject, body = ''] = fields;
    const subject = rawSubject.replace(/^﻿/, '').trim();
    const m = SUBJECT_RE.exec(subject);
    if (!m) continue;
    const type = TYPE_MAP[m[1].toLowerCase()];
    if (!type) continue;
    const scope = m[2]?.trim() || null;
    if (scope && HIDDEN_SCOPES.has(scope.toLowerCase())) continue;
    if (!hash || Number.isNaN(Date.parse(date))) continue;
    notes.push({
      hash,
      date,
      type,
      scope,
      subject: m[4].trim(),
      detail: cleanDetail(body),
      href: hrefForScope(scope),
    });
  }
  return notes;
}

/** Group newest-first notes by the commit's own calendar date (from the ISO string). */
export function groupByDay(notes: ReleaseNote[]): NoteDay[] {
  const days: NoteDay[] = [];
  for (const n of notes) {
    const day = n.date.slice(0, 10);
    const last = days[days.length - 1];
    if (last && last.day === day) last.notes.push(n);
    else days.push({ day, notes: [n] });
  }
  return days;
}

/** Notes strictly newer than `lastSeenIso`. A never-seen viewer (null) has 0 unread. */
export function countUnread(notes: ReleaseNote[], lastSeenIso: string | null): number {
  if (!lastSeenIso) return 0;
  const seen = Date.parse(lastSeenIso);
  if (Number.isNaN(seen)) return 0;
  let n = 0;
  for (const note of notes) if (Date.parse(note.date) > seen) n++;
  return n;
}

/** Newest note date, used as the "seen up to" watermark. */
export function latestDate(notes: ReleaseNote[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const n of notes) {
    const ms = Date.parse(n.date);
    if (ms > bestMs) {
      bestMs = ms;
      best = n.date;
    }
  }
  return best;
}

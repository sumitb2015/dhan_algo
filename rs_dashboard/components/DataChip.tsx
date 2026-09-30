// The header `DATA: YYYY-MM-DD` chip (CLAUDE.md: every page showing market
// data must say how current it is). Markup is the dhan-page-theme standard
// amber pill — amber means "metadata" here, not a warning.
//
// `date` must come from the payload (the data's own session date), never from
// `new Date()`: a client clock says when you looked, not what you are looking at.

export default function DataChip({ date, lastSession }: { date: string | null | undefined; lastSession?: boolean }) {
  return (
    <span
      className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300
                 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 whitespace-nowrap"
      title="Session date of the data on screen"
    >
      DATA: {date || '—'}{date && lastSession ? ' · last session' : ''}
    </span>
  );
}

/**
 * Normalise a payload date to "YYYY-MM-DD": "DD-MM-YYYY", an ISO date/datetime,
 * or epoch seconds (e.g. "1790762700.0" from the Python candle fetchers), which
 * is read as an IST calendar date — the NSE session it belongs to.
 */
export function toIsoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  if (/^\d{9,11}(\.\d+)?$/.test(s)) {
    // en-CA formats as YYYY-MM-DD.
    return new Date(Number(s) * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  }
  const dmy = /^(\d{2})-(\d{2})-(\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return iso ? iso[1] : null;
}

'use client';

import type { TrendingOiRow } from '@/app/api/trending-oi/route';

interface TrendingOiTableProps {
  rows: TrendingOiRow[];
}

function formatNum(value: number | null, digits = 0): string {
  if (value === null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatSigned(value: number | null, digits = 0): string {
  if (value === null || Number.isNaN(value)) return '—';
  const formatted = formatNum(Math.abs(value), digits);
  return value >= 0 ? `+${formatted}` : `-${formatted}`;
}

function changeColor(value: number | null): string {
  if (value === null || value === 0) return 'text-zinc-400';
  return value > 0 ? 'text-emerald-400' : 'text-rose-400';
}

const COLUMNS = [
  '#',
  'Date',
  'Time',
  'LTP',
  'Day H/L Break',
  'Chng. In Call OI',
  'Chng. In Put OI',
  'Diff. in OI',
  'Direction of chng.',
  'Chng. In Direction',
  'Direction of chng. %',
  'Net PCR',
  'Day High/Low Diff. in OI',
  'Sentiment',
  'Total Call LTP',
  'Call LTP Chng.',
  'CE+PE LTP Chng.',
  'Put LTP Chng.',
  'Total Put LTP',
];

export function TrendingOiTable({ rows }: TrendingOiTableProps) {
  if (rows.length === 0) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 text-sm text-zinc-400">
        No snapshots yet — the table fills in as new interval buckets are polled.
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-auto max-h-[calc(100vh-220px)]">
      <table className="w-full text-xs text-left whitespace-nowrap">
        <thead>
          <tr className="bg-zinc-800">
            {COLUMNS.map((col) => (
              <th
                key={col}
                className="sticky top-0 z-10 py-2.5 px-3 border-b border-zinc-700 text-center text-xs font-bold text-white uppercase tracking-wider bg-zinc-800"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800 font-mono">
          {rows.map((row, i) => (
            <tr key={`${row.date}-${row.time}-${i}`} className="hover:bg-zinc-800/60">
              <td className="py-2 px-3 text-center text-zinc-500 font-semibold">{i + 1}</td>
              <td className="py-2 px-3 text-center text-zinc-300">{row.date}</td>
              <td className="py-2 px-3 text-center text-zinc-200 font-medium">{row.time}</td>
              <td className="py-2 px-3 text-right tabular-nums font-semibold text-zinc-100">
                {row.spot != null ? formatNum(row.spot, 2) : '—'}
              </td>
              <td className="py-2 px-3 text-center">
                {row.day_hl_break ? (
                  <span
                    className={`px-2 py-0.5 rounded font-bold text-[11px] whitespace-nowrap text-white ${
                      row.day_hl_break.includes('D.H.B.') ? 'bg-emerald-600' : 'bg-rose-600'
                    }`}
                  >
                    {row.day_hl_break}
                  </span>
                ) : (
                  <span className="text-zinc-600">—</span>
                )}
              </td>
              <td className={`py-2 px-3 text-right tabular-nums font-medium ${changeColor(row.chng_in_call_oi)}`}>
                {formatNum(row.chng_in_call_oi)}
              </td>
              <td className={`py-2 px-3 text-right tabular-nums font-medium ${changeColor(row.chng_in_put_oi)}`}>
                {formatNum(row.chng_in_put_oi)}
              </td>
              <td className={`py-2 px-3 text-right tabular-nums font-semibold ${changeColor(row.diff_in_oi)}`}>
                {formatSigned(row.diff_in_oi)}
              </td>
              <td className="py-2 px-3 text-center">
                {row.direction ? (
                  <span
                    className={`inline-flex items-center justify-center w-6 h-6 rounded font-extrabold text-xs text-white shadow-sm ${
                      row.direction === 'up' ? 'bg-emerald-600' : 'bg-rose-500'
                    }`}
                  >
                    {row.direction === 'up' ? '↑' : '↓'}
                  </span>
                ) : (
                  <span className="text-zinc-600">—</span>
                )}
              </td>
              <td className={`py-2 px-3 text-right tabular-nums font-medium ${changeColor(row.chng_in_direction)}`}>
                {formatSigned(row.chng_in_direction)}
              </td>
              <td className={`py-2 px-3 text-right tabular-nums font-medium ${changeColor(row.direction_pct)}`}>
                {row.direction_pct != null ? `${formatSigned(row.direction_pct, 2)} %` : '—'}
              </td>
              <td className="py-2 px-3 text-center tabular-nums font-bold text-xs text-zinc-100">
                {row.net_pcr != null ? formatNum(row.net_pcr, 2) : '—'}
              </td>
              <td className="py-2 px-3 text-center">
                {row.day_hl_diff_oi ? (
                  <span
                    className={`px-2 py-0.5 rounded font-bold text-[11px] whitespace-nowrap text-white ${
                      row.day_hl_diff_oi.includes('High') ? 'bg-emerald-600' : 'bg-rose-600'
                    }`}
                  >
                    {row.day_hl_diff_oi}
                  </span>
                ) : (
                  <span className="text-zinc-600">—</span>
                )}
              </td>
              <td className="py-2 px-3 text-center">
                {row.sentiment ? (
                  <span
                    className={`px-3 py-1 rounded font-bold text-[11px] whitespace-nowrap text-white shadow-sm ${
                      row.sentiment === 'Bullish' ? 'bg-emerald-600' : 'bg-rose-600'
                    }`}
                  >
                    {row.sentiment}
                  </span>
                ) : (
                  <span className="text-zinc-600">—</span>
                )}
              </td>
              <td className="py-2 px-3 text-right tabular-nums text-zinc-300">{formatNum(row.total_call_ltp, 2)}</td>
              <td className={`py-2 px-3 text-right tabular-nums ${changeColor(row.call_ltp_chng)}`}>
                {formatSigned(row.call_ltp_chng, 2)}
              </td>
              <td className={`py-2 px-3 text-right tabular-nums ${changeColor(row.ce_pe_ltp_chng)}`}>
                {formatSigned(row.ce_pe_ltp_chng, 2)}
              </td>
              <td className={`py-2 px-3 text-right tabular-nums ${changeColor(row.put_ltp_chng)}`}>
                {formatSigned(row.put_ltp_chng, 2)}
              </td>
              <td className="py-2 px-3 text-right tabular-nums text-zinc-300">{formatNum(row.total_put_ltp, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

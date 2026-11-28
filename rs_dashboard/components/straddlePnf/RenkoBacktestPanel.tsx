'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FlaskConical, Loader2, X } from 'lucide-react';
import { IST_OFFSET_S } from '@/lib/istTime';

// The last Renko + Supertrend option-selling backtest (scripts/analysis/backtest_renko_st_options.py), read through
// /api/renko-backtest. Read-only: it shows a saved run; running one stays a terminal command.

type Stats = {
  trades: number; gross?: number; costs?: number; net?: number; net_slip?: number; win_rate?: number; avg_win?: number;
  avg_loss?: number; max_dd?: number; best_day?: number; worst_day?: number; green_days?: number; days?: number;
  pe_net?: number; ce_net?: number; overnight_trades?: number; overnight_net?: number; avg_hold_min?: number;
};
type Trade = { expiry: string; type: 'CE' | 'PE'; strike: number; entry_t: number; entry: number; exit_t: number; exit: number; pts: number; net: number; why: string };
type Config = {
  key: string; label: string; brick: number | null; brick_range: [number, number]; bricks: number;
  stats: Stats; stats_next_minute: Stats; weekly: { expiry: string; net: number; trades: number }[];
  stale_exits: { day: string; type: string; strike: number; age_min: number; price: number }[]; trades: Trade[];
};
type Result = {
  id: string; generated_at: string; strategy: string;
  params: {
    start: string; end: string; st_period: number; st_mult: number; lot: number; cost_per_order: number; slip_pts: number;
    hold?: 'mis' | 'nrml' | 'carry'; cutoff?: string | null; expiry_square_off?: string; square_off?: string; source?: 'dhan' | 'db'; underlying: string;
  };
  market: { sessions: number; spot_start: number; spot_end: number; spot_low: number; spot_high: number; change_pct: number };
  configs: Config[];
};

const inr = (v: number | undefined) => (v === undefined ? '—' : `${v < 0 ? '−' : ''}₹${Math.abs(v).toLocaleString('en-IN')}`);
const pnlClass = (v: number | undefined) => (v === undefined || v === 0 ? 'text-zinc-300' : v > 0 ? 'text-emerald-400' : 'text-red-400');
const istStamp = (t: number) => {
  const iso = new Date((t + IST_OFFSET_S) * 1000).toISOString();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`;
};
const HOLD_TEXT: Record<string, string> = { mis: 'MIS', nrml: 'NRML', carry: 'Held overnight' };
const holdChip = (p: Result['params']) => (p.hold ? `${HOLD_TEXT[p.hold]}${p.cutoff ? ` · flat at ${p.cutoff}` : ''}` : 'Held overnight');
const WHY_TEXT: Record<string, string> = { flip: 'flip', eod: 'square-off', expiry: 'expiry 15:15', end: 'end' };
const brickText = (c: Config) => (c.brick !== null ? `${c.brick}` : `${c.brick_range[0]}–${c.brick_range[1]}`);

const TH = 'px-2 py-1.5 text-right text-xs font-bold text-white whitespace-nowrap';
const THL = 'px-2 py-1.5 text-left text-xs font-bold text-white whitespace-nowrap';
const TD = 'px-2 py-1 text-right font-mono tabular-nums whitespace-nowrap';

export default function RenkoBacktestPanel({ onClose }: { onClose: () => void }) {
  const [result, setResult] = useState<Result | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState('auto');

  useEffect(() => {
    const ctl = new AbortController();
    fetch('/api/renko-backtest', { cache: 'no-store', signal: ctl.signal })
      .then(async r => {
        const j = await r.json() as { result?: Result | null; command?: string; error?: string };
        if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
        setResult(j.result ?? null);
        setCommand(j.command ?? null);
      })
      .catch(e => { if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : 'Failed to load the backtest'); })
      .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    return () => ctl.abort();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cfg = useMemo(() => result?.configs.find(c => c.key === selected) ?? result?.configs[0] ?? null, [result, selected]);
  // an MIS / NRML run is flat every evening: the overnight column would be all zeros
  const showOvernight = !!result?.configs.some(c => (c.stats.overnight_trades ?? 0) > 0);

  return (
    <div className="fixed inset-0 z-50 bg-oncolor-dark/70 flex items-center justify-center p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Renko backtest"
           className="w-full max-w-6xl max-h-[90vh] flex flex-col bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl"
           onClick={e => e.stopPropagation()}>
        {/* header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-zinc-800">
          <div className="h-8 w-8 shrink-0 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
            <FlaskConical className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-zinc-100">Renko + Supertrend backtest</h2>
            <p className="text-[11px] text-zinc-400 mt-0.5">
              {result ? result.strategy : 'Sell the current week ATM PE when bullish, ATM CE when bearish'}
            </p>
            {result && (
              <div className="flex flex-wrap gap-1.5 mt-2 text-[11px] font-mono">
                <span className="px-2 py-0.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-300">DATA: {result.params.start} → {result.params.end}</span>
                <span className="px-2 py-0.5 rounded-md border border-zinc-700 bg-zinc-800 text-zinc-300">{result.market.sessions} sessions</span>
                <span className="px-2 py-0.5 rounded-md border border-zinc-700 bg-zinc-800 text-zinc-300">
                  NIFTY {result.market.spot_start.toLocaleString('en-IN')} → {result.market.spot_end.toLocaleString('en-IN')}{' '}
                  <span className={pnlClass(result.market.change_pct)}>({result.market.change_pct > 0 ? '+' : ''}{result.market.change_pct}%)</span>
                </span>
                <span className="px-2 py-0.5 rounded-md border border-zinc-700 bg-zinc-800 text-zinc-300">Supertrend ({result.params.st_period}, {result.params.st_mult})</span>
                <span className="px-2 py-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">{holdChip(result.params)}</span>
                <span className="px-2 py-0.5 rounded-md border border-zinc-700 bg-zinc-800 text-zinc-300" title={result.params.underlying}>
                  Signals: {result.params.source === 'db' ? 'DB spot' : 'NIFTY index'}
                </span>
                <span className="px-2 py-0.5 rounded-md border border-zinc-700 bg-zinc-800 text-zinc-300">1 lot = {result.params.lot}</span>
                <span className="px-2 py-0.5 rounded-md border border-zinc-700 bg-zinc-800 text-zinc-300">₹{result.params.cost_per_order}/order</span>
              </div>
            )}
          </div>
          <button type="button" aria-label="Close" onClick={onClose}
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-2">
              <Loader2 className="h-6 w-6 animate-spin text-emerald-400" aria-hidden="true" />
              <p className="text-zinc-200 font-semibold text-sm">Loading the last backtest</p>
            </div>
          )}
          {!loading && error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
              {error}
            </div>
          )}
          {!loading && !error && !result && (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
              <FlaskConical className="h-6 w-6 text-zinc-600" aria-hidden="true" />
              <p className="text-sm text-zinc-400">No backtest has been run yet.</p>
              {command && <p className="text-[11px] text-zinc-500">Run <code className="font-mono text-zinc-300">{command}</code> from the project root.</p>}
            </div>
          )}

          {result && (
            <>
              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="w-full text-[11px]">
                  <thead className="bg-zinc-800">
                    <tr>
                      <th className={THL}>Brick (pts)</th>
                      <th className={TH}>Trades</th><th className={TH}>Gross</th><th className={TH}>Costs</th><th className={TH}>Net</th>
                      <th className={TH} title={`Net after ${result.params.slip_pts} pt slippage per order`}>Net + slip</th>
                      <th className={TH}>Win %</th><th className={TH}>Avg win</th><th className={TH}>Avg loss</th><th className={TH}>Max DD</th>
                      <th className={TH}>PE net</th><th className={TH}>CE net</th>
                      {showOvernight && <th className={TH} title="Trades held over at least one close, and their net">Overnight</th>}
                      <th className={TH} title="Net with every order filled one minute later (look-ahead check)">Next-min net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.configs.map(c => {
                      const s = c.stats;
                      const on = c.key === cfg?.key;
                      return (
                        <tr key={c.key} onClick={() => setSelected(c.key)} aria-selected={on}
                            className={`cursor-pointer border-t border-zinc-800 ${on ? 'bg-emerald-500/10' : 'hover:bg-zinc-800/60'}`}>
                          <td className="px-2 py-1 text-left font-semibold text-zinc-100 whitespace-nowrap">
                            {c.key === 'auto' ? <>Auto <span className="font-mono text-zinc-400">({brickText(c)})</span></> : <span className="font-mono">{brickText(c)}</span>}
                          </td>
                          <td className={`${TD} text-zinc-300`}>{s.trades}</td>
                          <td className={`${TD} ${pnlClass(s.gross)}`}>{inr(s.gross)}</td>
                          <td className={`${TD} text-zinc-400`}>{inr(s.costs)}</td>
                          <td className={`${TD} font-bold ${pnlClass(s.net)}`}>{inr(s.net)}</td>
                          <td className={`${TD} ${pnlClass(s.net_slip)}`}>{inr(s.net_slip)}</td>
                          <td className={`${TD} text-zinc-300`}>{s.win_rate ?? '—'}</td>
                          <td className={`${TD} text-emerald-400`}>{inr(s.avg_win)}</td>
                          <td className={`${TD} text-red-400`}>{inr(s.avg_loss)}</td>
                          <td className={`${TD} text-red-400`}>{inr(s.max_dd)}</td>
                          <td className={`${TD} ${pnlClass(s.pe_net)}`}>{inr(s.pe_net)}</td>
                          <td className={`${TD} ${pnlClass(s.ce_net)}`}>{inr(s.ce_net)}</td>
                          {showOvernight && <td className={`${TD} ${pnlClass(s.overnight_net)}`}>{s.overnight_trades ?? 0} · {inr(s.overnight_net)}</td>}
                          <td className={`${TD} ${pnlClass(c.stats_next_minute.net)}`}>{inr(c.stats_next_minute.net)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {cfg && (
                <div className="grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] gap-4">
                  <div className="space-y-3">
                    <div className="rounded-lg border border-zinc-800">
                      <div className="px-3 py-2 text-xs font-bold text-zinc-100 border-b border-zinc-800">
                        {cfg.label} by expiry week
                      </div>
                      <table className="w-full text-[11px]">
                        <thead className="bg-zinc-800"><tr><th className={THL}>Expiry</th><th className={TH}>Trades</th><th className={TH}>Net</th></tr></thead>
                        <tbody>
                          {cfg.weekly.map(w => (
                            <tr key={w.expiry} className="border-t border-zinc-800">
                              <td className="px-2 py-1 font-mono text-zinc-300">{w.expiry}</td>
                              <td className={`${TD} text-zinc-300`}>{w.trades}</td>
                              <td className={`${TD} ${pnlClass(w.net)}`}>{inr(w.net)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="text-[11px] text-zinc-400 space-y-1 px-1">
                      <p>Bricks {cfg.bricks}, avg hold {cfg.stats.avg_hold_min ?? '—'} min.</p>
                      <p>Best day <span className={pnlClass(cfg.stats.best_day)}>{inr(cfg.stats.best_day)}</span>, worst <span className={pnlClass(cfg.stats.worst_day)}>{inr(cfg.stats.worst_day)}</span>, green days {cfg.stats.green_days}/{cfg.stats.days}.</p>
                      {cfg.stale_exits.length > 0 && (
                        <p className="text-amber-300">{cfg.stale_exits.length} exit{cfg.stale_exits.length > 1 ? 's' : ''} priced from an older mark: the strike left the stored ATM ±10 range.</p>
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border border-zinc-800 min-w-0">
                    <div className="px-3 py-2 text-xs font-bold text-zinc-100 border-b border-zinc-800">{cfg.label} trades ({cfg.trades.length})</div>
                    <div className="max-h-80 overflow-y-auto">
                      <table className="w-full text-[11px]">
                        <thead className="bg-zinc-800 sticky top-0 z-10">
                          <tr>
                            <th className={THL}>Sold</th><th className={TH}>Strike</th><th className={TH}>Entry</th>
                            <th className={THL}>In</th><th className={TH}>Exit</th><th className={THL}>Out</th>
                            <th className={TH}>Pts</th><th className={TH}>Net</th><th className={THL}>Why</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cfg.trades.map((t, i) => (
                            <tr key={i} className="border-t border-zinc-800">
                              <td className={`px-2 py-1 font-bold ${t.type === 'PE' ? 'text-emerald-400' : 'text-red-400'}`}>{t.type}</td>
                              <td className={`${TD} text-zinc-300`}>{t.strike}</td>
                              <td className={`${TD} text-zinc-300`}>{t.entry.toFixed(2)}</td>
                              <td className="px-2 py-1 font-mono text-zinc-400 whitespace-nowrap">{istStamp(t.entry_t)}</td>
                              <td className={`${TD} text-zinc-300`}>{t.exit.toFixed(2)}</td>
                              <td className="px-2 py-1 font-mono text-zinc-400 whitespace-nowrap">{istStamp(t.exit_t)}</td>
                              <td className={`${TD} ${pnlClass(t.pts)}`}>{t.pts.toFixed(2)}</td>
                              <td className={`${TD} ${pnlClass(t.net)}`}>{inr(t.net)}</td>
                              <td className="px-2 py-1 text-zinc-400">{WHY_TEXT[t.why] ?? t.why}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              <ul className="text-[11px] text-zinc-500 space-y-0.5 list-disc pl-4">
                <li>Bricks and line from this page&apos;s own Renko and Supertrend code, on {result.params.underlying}. Entry only on a brick whose colour agrees with the line; a line flip exits and sells the other side. Fill at the option&apos;s close on the brick&apos;s minute (&quot;Next-min net&quot; fills a minute later).</li>
                <li>{result.params.hold && result.params.hold !== 'carry'
                  ? `Flat every evening: no entries from ${result.params.cutoff}, square-off at ${result.params.cutoff}, as the page's ${HOLD_TEXT[result.params.hold]} AUTO does.`
                  : `Held overnight (the page's AUTO squares off daily); expiry-day shorts closed at ${result.params.expiry_square_off ?? result.params.square_off}.`}
                  {' '}One window only ({result.market.sessions} sessions). Max DD is on closed trades; open losses while a short was held could be deeper.</li>
                <li>Run {result.id} · generated {result.generated_at.replace('T', ' ')} · re-run: <code className="font-mono text-zinc-400">venv/bin/python scripts/analysis/backtest_renko_st_options.py</code></li>
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

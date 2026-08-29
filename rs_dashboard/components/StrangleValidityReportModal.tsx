'use client';

import { useState, useEffect } from 'react';

export type RegimeKey = 'all' | 'pre_sep2025' | 'post_sep2025';

interface DteStats {
  count: number; avg: number; median: number; std: number;
  min: number; max: number; p10: number; p25: number; p75: number; p90: number;
  seller_win_pct: number; avg_decay_pct: number; avg_range: number; avg_range_pct: number;
}

interface AnalysisData {
  date_range: { from: string; to: string };
  total_days: number;
  total_expiries: number;
  summary: {
    overall_avg: number; overall_median: number;
    overall_min: number; overall_max: number;
    avg_daily_decay_pct: number; seller_win_pct: number;
  };
  by_weekday: Record<string, DteStats>;
  by_dte: Record<string, DteStats>;
  range_analysis: {
    by_dte: Record<string, { avg_range: number; avg_range_pct: number; seller_win_pct?: number }>;
    by_weekday: Record<string, { avg_range: number; avg_range_pct: number }>;
  };
  insights: string[];
}

interface OffsetData {
  regimes: {
    all: AnalysisData;
    pre_sep2025: AnalysisData;
    post_sep2025: AnalysisData;
  };
}

interface StrangleFullData {
  generated_at: string;
  regime_cutoff: string;
  [key: string]: OffsetData | string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  fullData: StrangleFullData | null;
  activeRegime: RegimeKey;
  selectedOffset: number;
}

const fmtPremium = (n: number | undefined) =>
  n != null ? `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}` : '—';

const fmtPct = (n: number | undefined) =>
  n != null ? `${n.toFixed(1)}%` : '—';

const fmtCount = (n: number | undefined) =>
  n != null ? n.toLocaleString('en-IN') : '—';

export default function StrangleValidityReportModal({
  isOpen,
  onClose,
  fullData,
  activeRegime,
  selectedOffset,
}: Props) {
  const [tab, setTab] = useState<'matrix' | 'decay' | 'cushion' | 'risk' | 'playbook'>('matrix');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !fullData) return null;

  const currentOffsetData = fullData[`offset_${selectedOffset}`] as OffsetData | undefined;
  const current = currentOffsetData?.regimes[activeRegime];

  const handleCopy = () => {
    const summaryText = `NIFTY OTM Strangle Analysis — Executive Summary & Validity Audit
Generated: ${fullData.generated_at}
Selected Offset: Offset ${selectedOffset} (ATM+${selectedOffset} / ATM-${selectedOffset} · ±${selectedOffset * 50} pts)
Dataset: ${current?.total_days ?? 0} trading days (${current?.date_range?.from} → ${current?.date_range?.to})
Sample Expiries: ${current?.total_expiries ?? 0} weekly cycles

Key Metrics for Offset ${selectedOffset} (${activeRegime.toUpperCase()}):
• Overall Average Opening Premium: ₹${current?.summary?.overall_avg ?? '—'} (Median: ₹${current?.summary?.overall_median ?? '—'})
• Average Daily Decay: ${current?.summary?.avg_daily_decay_pct ?? '—'}%
• Seller Win Rate: ${current?.summary?.seller_win_pct ?? '—'}%

Offset Matrix Comparison (Post-Sep 2025 Regime):
• Offset 1 (±50 pts): ₹182.1 avg open | 43.2% daily decay | 93.1% win | 98.9% 0-DTE decay
• Offset 2 (±100 pts): ₹145.8 avg open | 44.8% daily decay | 93.1% win | 99.8% 0-DTE decay
• Offset 3 (±150 pts): ₹117.2 avg open | 46.2% daily decay | 93.1% win | 99.6% 0-DTE decay
• Offset 5 (±250 pts): ₹76.9 avg open | 47.8% daily decay | 92.7% win | 98.8% 0-DTE decay
• Offset 10 (±500 pts): ₹30.7 avg open | 45.3% daily decay | 90.0% win | 96.3% 0-DTE decay

Key Insight:
OTM strangles decay faster in percentage terms (~45-48% daily vs 35% for ATM) and have dramatically reduced gamma on expiry day (₹38-73 range vs ₹185 for ATM). Stop losses and Inversion Guard (CE > PE) remain mandatory.`;

    navigator.clipboard.writeText(summaryText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/80 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl max-h-[90vh] bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-zinc-300 font-sans"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Glow accent */}
        <div className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-sky-500/[0.07] blur-3xl rounded-full" />

        {/* ── Modal Header ──────────────────────────────────────────────── */}
        <div className="relative border-b border-zinc-800/80 px-6 py-4 flex items-center justify-between bg-zinc-900/50">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400 font-mono font-bold text-sm">
              AI
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white tracking-tight">
                  Strangle Premium Analysis — Intelligence & Validity Report
                </h2>
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30">
                  OFFSETS 1–10 AUDIT
                </span>
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">
                Multi-strike OTM decay matrix, buffer advantages, gamma compression, and execution guidelines.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="px-2.5 py-1.5 text-xs font-mono font-bold bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 text-zinc-300 hover:text-white rounded-lg transition-colors flex items-center gap-1.5"
              title="Copy markdown summary"
            >
              {copied ? (
                <>
                  <span className="text-emerald-400">✓</span> Copied
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Copy Summary
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center transition-colors border border-zinc-800"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── Navigation Tabs ───────────────────────────────────────────── */}
        <div className="relative border-b border-zinc-800/80 px-6 py-2 bg-zinc-900/20 flex gap-2 overflow-x-auto">
          {[
            { id: 'matrix',   label: '1. Offset Matrix (1–10)' },
            { id: 'decay',    label: '2. DTE Decay Curve' },
            { id: 'cushion',  label: '3. Volatility & Buffer' },
            { id: 'risk',     label: '4. Win Rate vs Tail Risk' },
            { id: 'playbook', label: '5. Execution Playbook' },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as any)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                tab === t.id
                  ? 'bg-sky-500/15 text-sky-400 border border-sky-500/30'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60 border border-transparent'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Modal Body Content ────────────────────────────────────────── */}
        <div className="relative p-6 overflow-y-auto space-y-6 flex-1 text-xs leading-relaxed text-zinc-300">
          {tab === 'matrix' && (
            <div className="space-y-4">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-white">Strangle Offsets 1 to 10 Comparison Matrix</h3>
                  <span className="text-zinc-500 font-mono text-[10px]">
                    Post-Sep 2025 Regime (N = 289 days, 51 expiries)
                  </span>
                </div>

                <div className="overflow-x-auto rounded-lg border border-zinc-800 font-mono">
                  <table className="w-full text-xs">
                    <thead className="bg-zinc-950 text-zinc-400">
                      <tr>
                        <th className="text-left px-3 py-2 text-white font-sans">Offset & Strike Distance</th>
                        <th className="text-right px-3 py-2">Avg Open</th>
                        <th className="text-right px-3 py-2">Median</th>
                        <th className="text-right px-3 py-2 text-sky-400">Daily Decay %</th>
                        <th className="text-right px-3 py-2 text-emerald-400">Seller Win %</th>
                        <th className="text-right px-3 py-2 text-amber-400">0-DTE Decay %</th>
                        <th className="text-right px-3 py-2">0-DTE Range</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/60 bg-zinc-900/30">
                      {[
                        { off: 1, dist: '±50 pts (±0.2%)',  avg: 182.10, med: 166.70, dec: 43.2, win: 93.1, d0dec: 98.9, d0rng: 142.5 },
                        { off: 2, dist: '±100 pts (±0.4%)', avg: 145.77, med: 132.80, dec: 44.8, win: 93.1, d0dec: 99.8, d0rng: 100.6 },
                        { off: 3, dist: '±150 pts (±0.6%)', avg: 117.15, med: 105.70, dec: 46.2, win: 93.1, d0dec: 99.6, d0rng: 73.0 },
                        { off: 4, dist: '±200 pts (±0.8%)', avg: 94.53,  med: 84.50,  dec: 47.1, win: 92.7, d0dec: 99.4, d0rng: 53.8 },
                        { off: 5, dist: '±250 pts (±1.0%)', avg: 76.93,  med: 67.80,  dec: 47.8, win: 92.7, d0dec: 98.8, d0rng: 38.4 },
                        { off: 6, dist: '±300 pts (±1.2%)', avg: 63.10,  med: 54.60,  dec: 47.8, win: 92.4, d0dec: 98.0, d0rng: 28.5 },
                        { off: 7, dist: '±350 pts (±1.4%)', avg: 52.13,  med: 44.50,  dec: 47.6, win: 92.4, d0dec: 97.6, d0rng: 22.1 },
                        { off: 8, dist: '±400 pts (±1.6%)', avg: 43.31,  med: 36.30,  dec: 47.0, win: 92.0, d0dec: 97.0, d0rng: 17.6 },
                        { off: 9, dist: '±450 pts (±1.8%)', avg: 36.37,  med: 30.10,  dec: 46.0, win: 91.7, d0dec: 96.5, d0rng: 14.3 },
                        { off: 10, dist: '±500 pts (±2.0%)', avg: 30.71, med: 24.80,  dec: 45.3, win: 90.0, d0dec: 96.3, d0rng: 12.1 },
                      ].map((r) => {
                        const isSelected = r.off === selectedOffset;
                        return (
                          <tr key={r.off} className={isSelected ? 'bg-sky-500/15 font-bold border-l-2 border-sky-400' : ''}>
                            <td className="px-3 py-2 text-left font-sans">
                              <span className="text-white">Offset {r.off}</span>{' '}
                              <span className="text-zinc-500 text-[10px]">({r.dist})</span>
                              {isSelected && <span className="ml-1.5 text-[9px] px-1 py-0.2 rounded bg-sky-400/20 text-sky-300 font-mono">ACTIVE</span>}
                            </td>
                            <td className="px-3 py-2 text-right">₹{r.avg.toFixed(2)}</td>
                            <td className="px-3 py-2 text-right text-zinc-400">₹{r.med.toFixed(2)}</td>
                            <td className="px-3 py-2 text-right text-sky-400 font-bold">{r.dec.toFixed(1)}%</td>
                            <td className="px-3 py-2 text-right text-emerald-400 font-bold">{r.win.toFixed(1)}%</td>
                            <td className="px-3 py-2 text-right text-amber-400 font-bold">{r.d0dec.toFixed(1)}%</td>
                            <td className="px-3 py-2 text-right text-zinc-300">₹{r.d0rng.toFixed(1)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-4 space-y-1.5">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider text-sky-400">
                  Key Statistical Takeaway
                </h4>
                <p className="text-zinc-300">
                  OTM strangles achieve higher daily % decay (~45–48%) compared to ATM straddles (~35%), while drastically dampening gamma volatility on expiry days (from ₹185 down to ₹12–73).
                </p>
              </div>
            </div>
          )}

          {tab === 'decay' && (
            <div className="space-y-4">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-white">
                    Decay Profile by DTE for Offset {selectedOffset} (ATM±{selectedOffset})
                  </h3>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30">
                    ±{selectedOffset * 50} Points
                  </span>
                </div>

                <div className="overflow-x-auto rounded-lg border border-zinc-800 font-mono">
                  <table className="w-full text-xs">
                    <thead className="bg-zinc-950 text-zinc-400">
                      <tr>
                        <th className="text-left px-3 py-2 text-white font-sans">DTE & Timing</th>
                        <th className="text-right px-3 py-2">Avg Open</th>
                        <th className="text-right px-3 py-2">Median</th>
                        <th className="text-right px-3 py-2 text-sky-400">Avg Decay %</th>
                        <th className="text-right px-3 py-2 text-emerald-400">Seller Win %</th>
                        <th className="text-right px-3 py-2">Avg Intraday Range</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/60 bg-zinc-900/30">
                      {['4', '3', '2', '1', '0'].map((d) => {
                        const s = current?.by_dte[d];
                        const dayLabel = d === '4' ? 'Wed (Cycle Open)' : d === '3' ? 'Thursday' : d === '2' ? 'Friday' : d === '1' ? 'Mon (Pre-Expiry)' : 'Tue (Expiry Day)';
                        return (
                          <tr key={d} className={d === '0' ? 'bg-sky-500/10 font-bold' : ''}>
                            <td className="px-3 py-2 text-left font-sans">
                              <span className="text-white font-bold">{d} DTE</span>{' '}
                              <span className="text-zinc-500 text-[10px]">({dayLabel})</span>
                            </td>
                            <td className="px-3 py-2 text-right">{fmtPremium(s?.avg)}</td>
                            <td className="px-3 py-2 text-right text-zinc-400">{fmtPremium(s?.median)}</td>
                            <td className="px-3 py-2 text-right text-sky-400 font-bold">{fmtPct(s?.avg_decay_pct)}</td>
                            <td className="px-3 py-2 text-right text-emerald-400 font-bold">{fmtPct(s?.seller_win_pct)}</td>
                            <td className="px-3 py-2 text-right">{fmtPremium(s?.avg_range)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-4 space-y-2">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider text-amber-400">
                  DTE Acceleration Dynamics
                </h4>
                <ul className="list-disc list-inside space-y-1 text-zinc-300">
                  <li><strong>DTE 4 to 2 (Wed–Fri):</strong> Slow, stable burn (14–18% daily decay) with low delta sensitivity.</li>
                  <li><strong>DTE 1 (Monday):</strong> Accelerated decay (25–37%) as weekend risk dissolves into pre-expiry session.</li>
                  <li><strong>DTE 0 (Tuesday Expiry):</strong> Full 96% to 99.8% collapse. Unless spot crosses the OTM strike, premium approaches zero.</li>
                </ul>
              </div>
            </div>
          )}

          {tab === 'cushion' && (
            <div className="space-y-4">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
                <h3 className="text-sm font-bold text-white mb-2">The OTM Volatility Buffer & Gamma Compression</h3>
                <p className="text-zinc-400 mb-4">
                  Comparing ATM Straddle vs OTM Strangles reveals why systematic trading strategies frequently select strangles for calmer adjustment profiles.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono">
                  <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800">
                    <div className="text-[10px] text-zinc-500 uppercase font-sans">ATM Straddle (0 DTE)</div>
                    <div className="text-base font-bold text-rose-400 mt-1">₹184.6 Range</div>
                    <div className="text-[10px] text-zinc-400 mt-1">131% of opening premium</div>
                  </div>
                  <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800">
                    <div className="text-[10px] text-zinc-500 uppercase font-sans">Offset 3 (±150 pts, 0 DTE)</div>
                    <div className="text-base font-bold text-amber-400 mt-1">₹73.0 Range</div>
                    <div className="text-[10px] text-zinc-400 mt-1">60% gamma reduction</div>
                  </div>
                  <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800">
                    <div className="text-[10px] text-zinc-500 uppercase font-sans">Offset 5 (±250 pts, 0 DTE)</div>
                    <div className="text-base font-bold text-emerald-400 mt-1">₹38.4 Range</div>
                    <div className="text-[10px] text-zinc-400 mt-1">79% gamma reduction</div>
                  </div>
                </div>
              </div>

              <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-4 space-y-1.5">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider text-emerald-400">
                  Adjustment Cushion Advantage
                </h4>
                <p className="text-zinc-300">
                  In a strangle, spot can move ±100 to ±250 points without testing the strike. In contrast, an ATM straddle immediately incurs directional delta from the very first candle.
                </p>
              </div>
            </div>
          )}

          {tab === 'risk' && (
            <div className="space-y-4">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <span className="text-rose-400 font-bold">⚠️</span> Strangle Seller Win Rate (90–93%) vs Tail Trend Risk
                </h3>
                <p className="text-zinc-300">
                  While seller win rate remains above <strong>90% to 93%</strong> across all offsets, the risk profile shifts in critical ways:
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div className="bg-emerald-950/30 border border-emerald-500/30 rounded-lg p-3">
                    <div className="text-emerald-400 font-bold text-xs mb-1">Normal Range Days (92% Edge)</div>
                    <p className="text-zinc-400 text-[11px]">
                      Spot oscillates inside the breakeven band. Both legs decay quickly, generating steady positive carry.
                    </p>
                  </div>
                  <div className="bg-rose-950/30 border border-rose-500/30 rounded-lg p-3">
                    <div className="text-rose-400 font-bold text-xs mb-1">Breakout Days (8% Tail Risk)</div>
                    <p className="text-zinc-400 text-[11px]">
                      When a 300+ point trend develops, the threatened OTM leg transitions toward ATM and expands rapidly while the far OTM opposite leg decays to zero and stops compensating.
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider mb-2">
                  Strangle Inversion Guard Rule
                </h4>
                <p className="text-zinc-300 text-xs leading-relaxed">
                  In dynamic rebalancing strategies, <strong className="text-white">CE Strike &gt; PE Strike</strong> must be strictly maintained. If adjustments or strike rolls force strikes to touch or invert, the strategy must trigger an emergency cycle exit and reset at the new spot.
                </p>
              </div>
            </div>
          )}

          {tab === 'playbook' && (
            <div className="space-y-4">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
                <h3 className="text-sm font-bold text-white mb-3">Strangle Execution Playbook</h3>

                <div className="space-y-3 font-mono text-xs">
                  <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                    <div className="text-emerald-400 font-bold text-xs mb-1 font-sans">
                      Setup 1: Optimal Carry (Offset 2 to 3 / ±100 to ±150 pts)
                    </div>
                    <div className="text-zinc-400 text-[11px]">
                      • Best on Wednesday (DTE 4) & Thursday (DTE 3).<br/>
                      • Opens at ₹117–145, capturing ~45% daily decay.<br/>
                      • 150-point buffer absorbs opening market noise with 93.1% win rate.
                    </div>
                  </div>

                  <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                    <div className="text-sky-400 font-bold text-xs mb-1 font-sans">
                      Setup 2: Expiry Day Harvest (Offset 3 to 5 / ±150 to ±250 pts)
                    </div>
                    <div className="text-zinc-400 text-[11px]">
                      • Best on Tuesday (DTE 0) at 09:15.<br/>
                      • Opens at ₹21–43, decaying &gt;98.8% by 15:30.<br/>
                      • Intraday range is low (₹38–73), providing a high-confidence scalp.
                    </div>
                  </div>

                  <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                    <div className="text-amber-400 font-bold text-xs mb-1 font-sans">
                      Setup 3: Defensive Wide Strangle (Offset 6 to 10 / ±300 to ±500 pts)
                    </div>
                    <div className="text-zinc-400 text-[11px]">
                      • Used during elevated VIX / event days.<br/>
                      • Extremely wide ±500 buffer ensures near-zero touch risk during normal sessions.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Modal Footer ──────────────────────────────────────────────── */}
        <div className="relative border-t border-zinc-800/80 px-6 py-3 bg-zinc-900/40 flex items-center justify-between">
          <span className="text-[11px] text-zinc-500 font-mono">
            Active View: <strong className="text-zinc-300">Offset {selectedOffset} (ATM±{selectedOffset})</strong> · <strong className="text-zinc-300">{activeRegime.toUpperCase()}</strong>
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg transition-colors"
          >
            Close Report
          </button>
        </div>
      </div>
    </div>
  );
}

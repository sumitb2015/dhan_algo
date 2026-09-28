'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import NavBar from '@/components/NavBar';
import {
  Award, RefreshCw, Search, Loader2, AlertCircle, ChevronDown, ChevronUp,
  RotateCcw, Info,
} from 'lucide-react';
import { NIFTY50_SET } from '@/lib/nifty50';
import { pctFrom, pctColor, pctFmt } from '@/lib/pctFormat';
import type { MoverResult, MoversResponse } from '@/app/api/movers/route';

// ─── Factor model ───────────────────────────────────────────────────────────
// Every factor is reduced to a 0-100 percentile rank *within the currently
// selected universe* (Nifty 50 or Nifty 500), so a 3-month return and an RSI
// reading can be blended on the same scale. The composite score is the
// weight-normalized average of those percentiles — move a fader, the whole
// board re-ranks.

type FactorCategory = 'Momentum' | 'Trend' | 'Strength' | 'Participation';

interface FactorDef {
  id: string;
  label: string;
  short: string;
  category: FactorCategory;
  hint: string;
  extract: (r: MoverResult) => number | null;
  defaultWeight: number;
}

const FACTORS: FactorDef[] = [
  { id: '1d', label: '1 Day Change', short: '1D', category: 'Momentum', hint: 'Latest session % move', extract: r => r.priceChange1D, defaultWeight: 5 },
  { id: '1w', label: '1 Week Change', short: '1W', category: 'Momentum', hint: '5-session % move', extract: r => r.priceChange1W, defaultWeight: 10 },
  { id: '1m', label: '1 Month Change', short: '1M', category: 'Momentum', hint: '~21-session % move', extract: r => r.priceChange1M, defaultWeight: 15 },
  { id: '3m', label: '3 Month Change', short: '3M', category: 'Momentum', hint: '~65-session % move', extract: r => r.priceChange3M, defaultWeight: 15 },
  { id: '1y', label: '1 Year Change', short: '1Y', category: 'Momentum', hint: '~252-session % move', extract: r => r.priceChange1Y, defaultWeight: 10 },
  { id: 'rsi', label: 'RSI (14)', short: 'RSI', category: 'Momentum', hint: 'Wilder 14-period RSI — higher reads more bullish', extract: r => r.rsi14, defaultWeight: 5 },
  { id: 'hi52', label: 'vs 52W High', short: '52W Hi', category: 'Strength', hint: '% below 52-week high — closer to 0 is stronger', extract: r => r.pctFrom52WHigh, defaultWeight: 10 },
  { id: 'lo52', label: 'vs 52W Low', short: '52W Lo', category: 'Strength', hint: '% above 52-week low — further from the bottom is stronger', extract: r => r.pctFrom52WLow, defaultWeight: 5 },
  { id: 'ma50', label: 'vs 50DMA', short: '50DMA', category: 'Trend', hint: '% above/below the 50-day moving average', extract: r => pctFrom(r.latestClose, r.ma50), defaultWeight: 10 },
  { id: 'ma200', label: 'vs 200DMA', short: '200DMA', category: 'Trend', hint: '% above/below the 200-day moving average', extract: r => pctFrom(r.latestClose, r.ma200), defaultWeight: 10 },
  { id: 'volr', label: 'Volume Ratio', short: 'VolR', category: 'Participation', hint: 'Latest volume ÷ 20-day average volume', extract: r => r.volumeRatio, defaultWeight: 5 },
];

const CATEGORY_ORDER: FactorCategory[] = ['Momentum', 'Trend', 'Strength', 'Participation'];

interface Preset {
  label: string;
  description: string;
  weights: Record<string, number>;
}

const PRESETS: Record<string, Preset> = {
  balanced: {
    label: 'Balanced',
    description: 'Equal-handed blend of momentum, trend position and 52-week strength',
    weights: Object.fromEntries(FACTORS.map(f => [f.id, f.defaultWeight])),
  },
  momentum: {
    label: 'Momentum Rally',
    description: 'Overweights recent price acceleration over the last 1-3 months',
    weights: { '1d': 5, '1w': 15, '1m': 20, '3m': 20, '1y': 15, rsi: 10, hi52: 5, lo52: 0, ma50: 5, ma200: 5, volr: 0 },
  },
  trend: {
    label: 'Trend Strength',
    description: 'Overweights moving-average position and proximity to the 52-week range',
    weights: { '1d': 0, '1w': 5, '1m': 5, '3m': 10, '1y': 10, rsi: 5, hi52: 20, lo52: 10, ma50: 15, ma200: 15, volr: 5 },
  },
  shortterm: {
    label: 'Short-Term Movers',
    description: 'Overweights today and this week, confirmed by volume conviction',
    weights: { '1d': 25, '1w': 25, '1m': 10, '3m': 5, '1y': 0, rsi: 10, hi52: 5, lo52: 0, ma50: 10, ma200: 5, volr: 15 },
  },
};

// ─── Persisted weights ───────────────────────────────────────────────────────
// A trader who tunes a custom weighting shouldn't lose it on refresh — save
// to localStorage on every change, restore on mount.

const WEIGHTS_STORAGE_KEY = 'dhanAlgo.stockRanking.weights.v1';

function clampWeights(raw: unknown): Record<string, number> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const f of FACTORS) {
    const v = obj[f.id];
    out[f.id] = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : f.defaultWeight;
  }
  return out;
}

function matchPreset(weights: Record<string, number>): string {
  const match = Object.entries(PRESETS).find(([, p]) => FACTORS.every(f => (p.weights[f.id] ?? 0) === weights[f.id]));
  return match ? match[0] : 'custom';
}

// Rank each stock's raw factor value into a 0-100 percentile within the
// universe. Invalid readings (e.g. a stock too new to have a 200DMA) fall
// back to 50 — neutral, rather than dragging the composite to zero.
function percentileRanks(values: (number | null)[]): number[] {
  const valid = values.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => x.v != null && Number.isFinite(x.v));
  const out = new Array(values.length).fill(50);
  if (valid.length <= 1) return out;
  const sorted = [...valid].sort((a, b) => a.v - b.v);
  const n = sorted.length;
  sorted.forEach((x, rank) => { out[x.i] = (rank / (n - 1)) * 100; });
  return out;
}

interface RankedStock {
  row: MoverResult;
  score: number;
  breakdown: { factor: FactorDef; raw: number | null; pct: number; weight: number }[];
}

function useRanking(rows: MoverResult[], weights: Record<string, number>): RankedStock[] {
  return useMemo(() => {
    if (rows.length === 0) return [];
    const percentilesByFactor = FACTORS.map(f => percentileRanks(rows.map(f.extract)));
    const totalWeight = FACTORS.reduce((s, f) => s + (weights[f.id] ?? 0), 0) || 1;

    const ranked = rows.map((row, i) => {
      let sum = 0;
      const breakdown = FACTORS.map((f, fi) => {
        const w = weights[f.id] ?? 0;
        const pct = percentilesByFactor[fi][i];
        sum += w * pct;
        return { factor: f, raw: f.extract(row), pct, weight: w };
      });
      return { row, score: sum / totalWeight, breakdown };
    });

    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }, [rows, weights]);
}

// One sentence naming the 1-2 factors that actually moved a stock's score —
// the factors with the largest weight × percentile contribution, not just
// the highest raw percentile (a 100th-percentile factor weighted at 0
// explains nothing about the score).
function explainRank(breakdown: RankedStock['breakdown']): string {
  const contributors = breakdown
    .filter(b => b.weight > 0)
    .sort((a, b) => b.weight * b.pct - a.weight * a.pct)
    .slice(0, 2);
  if (contributors.length === 0) return 'Every factor weight is 0 — the score is undefined.';
  return `Led by ${contributors.map(b => `${b.factor.label} (${b.pct.toFixed(0)}p)`).join(' and ')}`;
}

// ─── Score gauge (top-3 podium) ─────────────────────────────────────────────

function ScoreGauge({ score, size = 60 }: { score: number; size?: number }) {
  const deg = Math.max(0, Math.min(100, score)) * 3.6;
  const fillVar = score >= 50 ? 'var(--color-emerald-400)' : 'var(--color-red-400)';
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="absolute inset-0 rounded-full"
        style={{ background: `conic-gradient(${fillVar} ${deg}deg, var(--color-zinc-800) ${deg}deg)` }}
      />
      <div className="absolute inset-[4px] rounded-full bg-zinc-950 flex flex-col items-center justify-center">
        <span className="text-base font-bold text-white leading-none tabular-nums">{score.toFixed(0)}</span>
        <span className="text-[8px] text-zinc-500 font-semibold mt-0.5">SCORE</span>
      </div>
    </div>
  );
}

// ─── Heat strip — one cell per factor, coloured by percentile tier ──────────

function heatColor(pct: number): string {
  if (pct >= 75) return 'bg-emerald-400';
  if (pct >= 55) return 'bg-emerald-700';
  if (pct > 45) return 'bg-zinc-700';
  if (pct > 25) return 'bg-red-800';
  return 'bg-red-400';
}

function HeatStrip({ breakdown }: { breakdown: RankedStock['breakdown'] }) {
  return (
    <div className="flex items-center gap-[2px]" role="img" aria-label="Per-factor percentile heat strip">
      {breakdown.map(b => (
        <div
          key={b.factor.id}
          title={`${b.factor.label}: ${b.raw != null && Number.isFinite(b.raw) ? b.raw.toFixed(2) : '—'} (${b.pct.toFixed(0)}th pct, weight ${b.weight})`}
          className={`h-4 w-2 rounded-[1px] ${heatColor(b.pct)}`}
        />
      ))}
    </div>
  );
}

// ─── Weighting console — vertical fader per factor, grouped by category ────

function Fader({ factor, value, onChange }: { factor: FactorDef; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col items-center gap-1.5 w-12 shrink-0" title={factor.hint}>
      <span className="text-[10px] font-mono font-semibold text-zinc-400 tabular-nums">{value}</span>
      <div className="relative flex items-center justify-center" style={{ height: 96 }}>
        <div className="absolute w-1.5 rounded-full bg-zinc-800" style={{ height: 88 }} />
        <div
          className="absolute w-1.5 rounded-full bg-emerald-500/70"
          style={{ height: `${(value / 100) * 88}px`, bottom: 0 }}
        />
        <input
          type="range"
          min={0}
          max={100}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          aria-label={`${factor.label} weight`}
          className="ranking-fader"
        />
      </div>
      <span className="text-[9px] font-semibold text-zinc-500 uppercase tracking-wide text-center leading-tight">{factor.short}</span>
      <style jsx>{`
        .ranking-fader {
          position: absolute;
          width: 96px;
          height: 20px;
          -webkit-appearance: none;
          appearance: none;
          background: transparent;
          transform: rotate(-90deg);
          cursor: pointer;
        }
        .ranking-fader::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 18px;
          height: 10px;
          border-radius: 2px;
          background: var(--color-zinc-100);
          border: 1px solid var(--color-zinc-500);
          box-shadow: 0 1px 2px color-mix(in srgb, var(--color-zinc-950) 40%, transparent);
        }
        .ranking-fader::-moz-range-thumb {
          width: 18px;
          height: 10px;
          border-radius: 2px;
          background: var(--color-zinc-100);
          border: 1px solid var(--color-zinc-500);
        }
        .ranking-fader::-webkit-slider-runnable-track { background: transparent; }
        .ranking-fader::-moz-range-track { background: transparent; }
      `}</style>
    </div>
  );
}

function WeightingConsole({
  weights, onChange, activePreset, onPreset, onReset,
}: {
  weights: Record<string, number>;
  onChange: (id: string, v: number) => void;
  activePreset: string;
  onPreset: (key: string) => void;
  onReset: () => void;
}) {
  const totalWeight = FACTORS.reduce((s, f) => s + (weights[f.id] ?? 0), 0);
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div className="flex items-center gap-1.5 flex-wrap">
          {Object.entries(PRESETS).map(([key, preset]) => (
            <button
              key={key}
              onClick={() => onPreset(key)}
              title={preset.description}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg border transition-all ${
                activePreset === key
                  ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                  : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-white hover:border-zinc-700'
              }`}
            >
              {preset.label}
            </button>
          ))}
          {activePreset === 'custom' && (
            <span className="px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-sky-500/25 bg-sky-500/10 text-sky-400">
              Custom
            </span>
          )}
        </div>
        <button
          onClick={onReset}
          className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-white hover:border-zinc-700 transition-all"
        >
          <RotateCcw className="h-3 w-3" /> Equal weight
        </button>
      </div>

      <div className="flex items-start gap-6 overflow-x-auto pb-1">
        {CATEGORY_ORDER.map(cat => (
          <div key={cat} className="flex flex-col gap-2 shrink-0">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">{cat}</span>
            <div className="flex items-start gap-3">
              {FACTORS.filter(f => f.category === cat).map(f => (
                <Fader key={f.id} factor={f} value={weights[f.id] ?? 0} onChange={v => onChange(f.id, v)} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-zinc-600 mt-3 flex items-center gap-1.5">
        <Info className="h-3 w-3 shrink-0" />
        Each factor is ranked to a 0-100 percentile within the current universe, then blended by these weights
        (total weight {totalWeight}) into the composite score. Drag any fader — the board re-ranks live and your
        weighting is saved on this device for next time.
      </p>
    </div>
  );
}

// ─── Podium ──────────────────────────────────────────────────────────────────

function PodiumCard({ rank, entry }: { rank: number; entry: RankedStock }) {
  const medal = rank === 1 ? 'border-amber-500/40 bg-amber-500/5' : rank === 2 ? 'border-zinc-400/30 bg-zinc-400/5' : 'border-orange-700/40 bg-orange-700/5';
  return (
    <div className={`flex items-center gap-3 rounded-xl border p-3 ${medal}`}>
      <span className="text-2xl font-bold text-zinc-600 w-6 shrink-0 tabular-nums">{rank}</span>
      <ScoreGauge score={entry.score} size={56} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-bold text-white truncate">{entry.row.symbol}</span>
          <span className="text-[10px] text-zinc-500 truncate">{entry.row.sector || '—'}</span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-[11px]">
          <span className={pctColor(entry.row.priceChange1D)}>1D {pctFmt(entry.row.priceChange1D)}</span>
          <span className={pctColor(entry.row.priceChange1M)}>1M {pctFmt(entry.row.priceChange1M)}</span>
        </div>
        <p className="text-[10px] text-zinc-500 mt-1 truncate">{explainRank(entry.breakdown)}</p>
        <div className="mt-1.5"><HeatStrip breakdown={entry.breakdown} /></div>
      </div>
    </div>
  );
}

// ─── Ranked table ────────────────────────────────────────────────────────────

function RankedTable({ ranked, search }: { ranked: RankedStock[]; search: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rawPage, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ranked;
    return ranked.filter(e => e.row.symbol.toLowerCase().includes(q) || (e.row.sector || '').toLowerCase().includes(q));
  }, [ranked, search]);

  // O(1) rank lookup for the visible rows instead of an indexOf scan of the
  // full universe on every render (each row's global rank was already known,
  // and discarded, when useRanking sorted `ranked`).
  const rankBySymbol = useMemo(() => {
    const m = new Map<string, number>();
    ranked.forEach((e, i) => m.set(e.row.symbol, i + 1));
    return m;
  }, [ranked]);

  useEffect(() => setPage(0), [search]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamp rather than rely on an effect: `ranked` can shrink (e.g. the Nifty
  // 500 -> Nifty 50 tab switch) without `search` changing, which would
  // otherwise leave `page` pointing past the end and render an empty table.
  const page = Math.min(rawPage, pages - 1);
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap text-xs text-zinc-300">
        <span>{filtered.length} ranked stocks</span>
        {pages > 1 && (
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="px-2 py-1 rounded border border-zinc-700 bg-zinc-900 disabled:opacity-30 hover:border-zinc-500 text-zinc-200">‹</button>
            <span>{page + 1} / {pages}</span>
            <button onClick={() => setPage(p => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1} className="px-2 py-1 rounded border border-zinc-700 bg-zinc-900 disabled:opacity-30 hover:border-zinc-500 text-zinc-200">›</button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-zinc-800 border-b border-zinc-700">
              <th className="px-3 py-2 text-left text-xs font-bold text-white w-10">#</th>
              <th className="px-3 py-2 text-left text-xs font-bold text-white">Symbol</th>
              <th className="px-3 py-2 text-left text-xs font-bold text-white">Sector</th>
              <th className="px-3 py-2 text-right text-xs font-bold text-white">Score</th>
              <th className="px-3 py-2 text-left text-xs font-bold text-white" title="Momentum · Trend · Strength · Participation, left to right">Factors</th>
              <th className="px-3 py-2 text-right text-xs font-bold text-white">Price</th>
              <th className="px-3 py-2 text-right text-xs font-bold text-white">1D %</th>
              <th className="px-3 py-2 text-right text-xs font-bold text-white">1M %</th>
              <th className="px-3 py-2 text-right text-xs font-bold text-white">RSI 14</th>
              <th className="px-3 py-2 text-right text-xs font-bold text-white">vs 200DMA</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((entry, i) => {
              const rank = rankBySymbol.get(entry.row.symbol) ?? 0;
              const isOpen = expanded === entry.row.symbol;
              return (
                <React.Fragment key={entry.row.symbol}>
                  <tr
                    onClick={() => setExpanded(isOpen ? null : entry.row.symbol)}
                    className={`border-b border-zinc-900 hover:bg-zinc-900/50 transition-colors cursor-pointer ${i % 2 === 0 ? '' : 'bg-zinc-950/30'}`}
                  >
                    <td className="px-3 py-2 text-zinc-500 tabular-nums">{rank}</td>
                    <td className="px-3 py-2 font-semibold text-zinc-100 whitespace-nowrap">{entry.row.symbol}</td>
                    <td className="px-3 py-2 text-zinc-300 text-[11px] whitespace-nowrap">{entry.row.sector || '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className={`font-bold tabular-nums ${entry.score >= 50 ? 'text-emerald-300' : 'text-red-400'}`}>{entry.score.toFixed(1)}</span>
                        <div className="w-14 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                          <div
                            className={`h-full ${entry.score >= 50 ? 'bg-emerald-400' : 'bg-red-400'}`}
                            style={{ width: `${Math.max(0, Math.min(100, entry.score))}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2"><HeatStrip breakdown={entry.breakdown} /></td>
                    <td className="px-3 py-2 text-right text-white whitespace-nowrap">{entry.row.latestClose.toFixed(2)}</td>
                    <td className={`px-3 py-2 text-right whitespace-nowrap ${pctColor(entry.row.priceChange1D)}`}>{pctFmt(entry.row.priceChange1D)}</td>
                    <td className={`px-3 py-2 text-right whitespace-nowrap ${pctColor(entry.row.priceChange1M)}`}>{pctFmt(entry.row.priceChange1M)}</td>
                    <td className="px-3 py-2 text-right text-zinc-200 tabular-nums">{entry.row.rsi14.toFixed(1)}</td>
                    <td className={`px-3 py-2 text-right whitespace-nowrap ${pctColor(pctFrom(entry.row.latestClose, entry.row.ma200))}`}>{pctFmt(pctFrom(entry.row.latestClose, entry.row.ma200))}</td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-zinc-950/70 border-b border-zinc-900">
                      <td colSpan={10} className="px-4 py-3">
                        <p className="text-[11px] text-zinc-400 mb-2">{explainRank(entry.breakdown)}</p>
                        <div className="flex flex-wrap gap-x-6 gap-y-2">
                          {entry.breakdown.map(b => (
                            <div key={b.factor.id} className="flex items-center gap-2 min-w-[150px]">
                              <span className="text-[10px] text-zinc-500 w-14 shrink-0">{b.factor.short}</span>
                              <div className="w-20 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                                <div className={`h-full ${b.pct >= 50 ? 'bg-emerald-400' : 'bg-red-400'}`} style={{ width: `${b.pct}%` }} />
                              </div>
                              <span className="text-[10px] text-zinc-400 tabular-nums w-10">{b.pct.toFixed(0)}p</span>
                              <span className="text-[10px] text-zinc-600">w={b.weight}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Universe = 'nifty50' | 'nifty500';

export default function StockRanking() {
  const [stockData, setStockData] = useState<MoversResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [universe, setUniverse] = useState<Universe>('nifty50');
  const [search, setSearch] = useState('');
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [weights, setWeights] = useState<Record<string, number>>(PRESETS.balanced.weights);
  const [activePreset, setActivePreset] = useState<string>('balanced');
  const skipNextPersistRef = useRef(true);

  // Restore any weighting saved from a previous visit. Runs client-only
  // (avoids an SSR/hydration mismatch from reading localStorage during
  // render), so the first paint briefly shows the Balanced default before
  // this effect swaps in the saved weights.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WEIGHTS_STORAGE_KEY);
      if (raw) {
        const clamped = clampWeights(JSON.parse(raw));
        if (clamped) {
          setWeights(clamped);
          setActivePreset(matchPreset(clamped));
        }
      }
    } catch { /* localStorage unavailable (private window, etc.) — keep defaults */ }
  }, []);

  // Persist on every change, but skip the very first run: without this, the
  // initial-mount commit (still holding the Balanced default) would write
  // over a previously saved custom weighting before the restore effect above
  // gets a chance to apply it.
  useEffect(() => {
    if (skipNextPersistRef.current) { skipNextPersistRef.current = false; return; }
    try { localStorage.setItem(WEIGHTS_STORAGE_KEY, JSON.stringify(weights)); } catch { /* ignore */ }
  }, [weights]);

  const fetchData = useCallback(async (bust = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/movers?index=nifty500${bust ? '&bust=1' : ''}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'API error');
      setStockData(json.data as MoversResponse);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const universeRows = useMemo(() => {
    if (!stockData?.allMovers) return [];
    return universe === 'nifty50' ? stockData.allMovers.filter(r => NIFTY50_SET.has(r.symbol)) : stockData.allMovers;
  }, [stockData, universe]);

  const ranked = useRanking(universeRows, weights);

  const handleWeightChange = (id: string, v: number) => {
    setWeights(w => ({ ...w, [id]: v }));
    setActivePreset('custom');
  };
  const handlePreset = (key: string) => {
    setWeights({ ...PRESETS[key].weights });
    setActivePreset(key);
  };
  const handleReset = () => {
    setWeights(Object.fromEntries(FACTORS.map(f => [f.id, 10])));
    setActivePreset('custom');
  };

  const n50Count = stockData?.allMovers ? stockData.allMovers.filter(r => NIFTY50_SET.has(r.symbol)).length : 0;
  const n500Count = stockData?.allMovers?.length ?? 0;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Award className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">Equity · Nifty 50 / 500</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Stock Ranking</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Composite weighted-factor score across momentum, trend & strength</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => fetchData(true)}
            disabled={loading}
            className="p-1.5 border border-zinc-800 rounded-lg bg-zinc-900/40 text-zinc-400 hover:text-white transition-all hover:border-zinc-700 disabled:opacity-40"
            title="Reload from disk"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {stockData?.dataDate ?? '—'}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </header>

      <main className="flex-1 flex flex-col gap-4 px-6 py-5 max-w-[1680px] w-full mx-auto">

        {/* Controls row */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-1 p-1 bg-zinc-900/60 border border-zinc-800 rounded-xl">
            {([
              { key: 'nifty50', label: 'Nifty 50', count: n50Count },
              { key: 'nifty500', label: 'Nifty 500', count: n500Count },
            ] as const).map(({ key, label, count }) => (
              <button
                key={key}
                onClick={() => { setUniverse(key); setSearch(''); }}
                className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  universe === key ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'text-zinc-300 hover:text-white'
                }`}
              >
                {label}
                {count > 0 && <span className="ml-1.5 text-[10px] opacity-60">{count}</span>}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3 ml-auto">
            <button
              onClick={() => setConsoleOpen(o => !o)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:text-white hover:border-zinc-700 transition-all"
            >
              Weighting console
              <ChevronDown className={`h-3 w-3 transition-transform ${consoleOpen ? 'rotate-180' : ''}`} />
            </button>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter symbol or sector…"
                className="pl-8 pr-3 py-1.5 text-xs bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 w-52"
              />
            </div>
          </div>
        </div>

        {consoleOpen && (
          <WeightingConsole
            weights={weights}
            onChange={handleWeightChange}
            activePreset={activePreset}
            onPreset={handlePreset}
            onReset={handleReset}
          />
        )}

        {loading ? (
          <div className="flex items-center justify-center py-24 text-zinc-300 gap-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Ranking {universe === 'nifty50' ? 'Nifty 50' : 'Nifty 500'} stocks…</span>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center py-24 text-red-400 gap-2">
            <AlertCircle className="h-5 w-5" />
            <span className="text-sm">{error}</span>
          </div>
        ) : ranked.length === 0 ? (
          <div className="flex items-center justify-center py-24 text-zinc-500 gap-2 text-sm">
            No stock data yet — fetch it from the Performance page first.
          </div>
        ) : (
          <>
            {/* Podium — top 3 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {ranked.slice(0, 3).map((entry, i) => (
                <PodiumCard key={entry.row.symbol} rank={i + 1} entry={entry} />
              ))}
            </div>

            <RankedTable ranked={ranked} search={search} />
          </>
        )}
      </main>
    </div>
  );
}

'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Download, Search, ChevronUp, ChevronDown, TrendingUp, BarChart2, Settings, X, RotateCcw } from 'lucide-react';
import { ScannerResult, ScannerResponse, ScannerParams, DEFAULT_SCANNER_PARAMS } from '@/lib/scannerTypes';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';

// ─── Settings ─────────────────────────────────────────────────────────────────

interface ScannerSettings extends ScannerParams {
  // Display thresholds (applied client-side only)
  rsiOverbought: number;
  rsiBullish: number;
  rsiBearish: number;
  rsiOversold: number;
  adxStrong: number;
  adxVeryStrong: number;
  volSpike: number;
  volStrongSpike: number;
}

const DEFAULT_SETTINGS: ScannerSettings = {
  ...DEFAULT_SCANNER_PARAMS,
  rsiOverbought: 70,
  rsiBullish: 60,
  rsiBearish: 40,
  rsiOversold: 30,
  adxStrong: 25,
  adxVeryStrong: 30,
  volSpike: 1.5,
  volStrongSpike: 2.0,
};

const SETTINGS_KEY = 'scanner_settings_v1';

function loadSettings(): ScannerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_SETTINGS;
}

// ─── Indicator cell helpers ───────────────────────────────────────────────────

type Signal = 'strong_bull' | 'bull' | 'neutral' | 'bear' | 'strong_bear';

function sigCell(signal: Signal) {
  switch (signal) {
    case 'strong_bull': return <span title="Strong Bullish">🟢</span>;
    case 'bull':        return <span title="Bullish">✅</span>;
    case 'neutral':     return <span title="Neutral">⚠️</span>;
    case 'bear':        return <span title="Bearish">❌</span>;
    case 'strong_bear': return <span title="Strong Bearish">🔴</span>;
  }
}

function boolCell(v: boolean, strongTrue?: boolean, strongFalse?: boolean) {
  if (v && strongTrue) return sigCell('strong_bull');
  if (v) return sigCell('bull');
  if (!v && strongFalse) return sigCell('strong_bear');
  return sigCell('bear');
}

function rsiCell(rsi: number, s: ScannerSettings) {
  if (rsi >= s.rsiOverbought) return sigCell('strong_bull');
  if (rsi >= s.rsiBullish)    return sigCell('bull');
  if (rsi >= s.rsiBearish)    return sigCell('neutral');
  if (rsi >= s.rsiOversold)   return sigCell('bear');
  return sigCell('strong_bear');
}

function adxCell(adx: number, s: ScannerSettings) {
  if (adx >= s.adxVeryStrong) return sigCell('strong_bull');
  if (adx >= s.adxStrong)     return sigCell('bull');
  return sigCell('neutral');
}

function macdCell(r: ScannerResult) {
  if (r.macdCrossover) return sigCell('strong_bull');
  if (r.macdBullish) return sigCell('bull');
  return sigCell('bear');
}

function volCell(ratio: number, s: ScannerSettings) {
  if (ratio >= s.volStrongSpike) return sigCell('strong_bull');
  if (ratio >= s.volSpike)       return sigCell('bull');
  if (ratio >= 0.8)              return sigCell('neutral');
  return sigCell('bear');
}

function rsCell(r: ScannerResult) {
  if (r.rsRising20 && r.rsAboveMA) return sigCell('strong_bull');
  if (r.rsRising20 || r.rsAboveMA) return sigCell('bull');
  return sigCell('bear');
}

// ─── Score bar ────────────────────────────────────────────────────────────────

function ScoreBar({ score, max = 15 }: { score: number; max?: number }) {
  const pct = (score / max) * 100;
  const color = pct >= 80 ? 'bg-emerald-500' : pct >= 60 ? 'bg-lime-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-1.5 justify-end">
      <div className="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn(
        'text-[11px] font-bold tabular-nums w-8 text-right',
        pct >= 80 ? 'text-emerald-400' : pct >= 60 ? 'text-lime-400' : pct >= 40 ? 'text-amber-400' : 'text-red-400',
      )}>
        {score}/{max}
      </span>
    </div>
  );
}

// ─── Table primitives ─────────────────────────────────────────────────────────

type SortKey = keyof ScannerResult | 'none';

function TH({
  children, right, sortKey, currentSort, onSort, className,
}: {
  children?: React.ReactNode;
  right?: boolean;
  sortKey?: SortKey;
  currentSort?: { key: SortKey; dir: 'asc' | 'desc' };
  onSort?: (k: SortKey) => void;
  className?: string;
}) {
  const active = currentSort?.key === sortKey;
  return (
    <th
      className={cn(
        'py-2 px-2 text-xs font-bold text-white bg-zinc-800 whitespace-nowrap uppercase tracking-wide select-none',
        right ? 'text-right' : 'text-left',
        sortKey ? 'cursor-pointer hover:bg-zinc-700 transition-colors' : '',
        className,
      )}
      onClick={() => sortKey && onSort?.(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sortKey && active && (
          currentSort?.dir === 'asc'
            ? <ChevronUp className="h-3 w-3 text-violet-400 shrink-0" />
            : <ChevronDown className="h-3 w-3 text-violet-400 shrink-0" />
        )}
      </span>
    </th>
  );
}

function TD({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return (
    <td className={cn('py-1.5 px-2 text-[12px]', right ? 'text-right' : 'text-left', className)}>
      {children}
    </td>
  );
}

function PctBadge({ v }: { v: number }) {
  return (
    <span className={cn(
      'text-[11px] font-semibold tabular-nums',
      v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-300',
    )}>
      {v > 0 ? '+' : ''}{v.toFixed(2)}%
    </span>
  );
}

// ─── Settings panel ───────────────────────────────────────────────────────────

function NumInput({
  label, value, onChange, min = 1, max, step = 1, unit,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-[52px]">
      <span className="text-[9px] text-zinc-400 uppercase tracking-wide leading-tight">{label}</span>
      <div className="flex items-center gap-0.5">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const n = step < 1 ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
            if (!isNaN(n)) onChange(n);
          }}
          className="w-14 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-1 text-[12px] text-white tabular-nums text-center focus:border-emerald-500 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        {unit && <span className="text-[10px] text-zinc-500">{unit}</span>}
      </div>
    </div>
  );
}

function SectionHeader({ children, tag }: { children: React.ReactNode; tag?: 'api' | 'ui' }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="text-[11px] font-bold text-zinc-100">{children}</span>
      {tag === 'api' && (
        <span className="text-[8px] uppercase tracking-wide bg-amber-500/15 text-amber-400 px-1.5 py-0.5 rounded font-bold">
          Re-scan
        </span>
      )}
      {tag === 'ui' && (
        <span className="text-[8px] uppercase tracking-wide bg-cyan-500/10 text-cyan-400 px-1.5 py-0.5 rounded font-bold">
          Live
        </span>
      )}
    </div>
  );
}

function SettingsPanel({
  settings,
  onUpdate,
  onClose,
  onReset,
}: {
  settings: ScannerSettings;
  onUpdate: (patch: Partial<ScannerSettings>) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 w-72 bg-zinc-950 border-l border-zinc-800 z-50 flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-emerald-400" />
            <span className="text-[13px] font-bold text-white">Indicator Settings</span>
          </div>
          <button
            onClick={onClose}
            className="h-6 w-6 flex items-center justify-center rounded text-zinc-500 hover:text-white hover:bg-zinc-800 transition-all"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-white">

          {/* RSI */}
          <div className="space-y-2">
            <SectionHeader tag="api">RSI</SectionHeader>
            <div className="flex flex-wrap gap-2">
              <NumInput label="Period" value={settings.rsiPeriod} min={2} max={50}
                onChange={(v) => onUpdate({ rsiPeriod: v })} />
            </div>
            <SectionHeader tag="ui">RSI Thresholds</SectionHeader>
            <div className="flex flex-wrap gap-2">
              <NumInput label="Overbought" value={settings.rsiOverbought} min={50} max={100}
                onChange={(v) => onUpdate({ rsiOverbought: v })} />
              <NumInput label="Bullish" value={settings.rsiBullish} min={40} max={90}
                onChange={(v) => onUpdate({ rsiBullish: v })} />
              <NumInput label="Bearish" value={settings.rsiBearish} min={10} max={60}
                onChange={(v) => onUpdate({ rsiBearish: v })} />
              <NumInput label="Oversold" value={settings.rsiOversold} min={1} max={50}
                onChange={(v) => onUpdate({ rsiOversold: v })} />
            </div>
          </div>

          <div className="h-px bg-zinc-800/70" />

          {/* MACD */}
          <div className="space-y-2">
            <SectionHeader tag="api">MACD</SectionHeader>
            <div className="flex flex-wrap gap-2">
              <NumInput label="Fast" value={settings.macdFast} min={2} max={50}
                onChange={(v) => onUpdate({ macdFast: v })} />
              <NumInput label="Slow" value={settings.macdSlow} min={5} max={100}
                onChange={(v) => onUpdate({ macdSlow: v })} />
              <NumInput label="Signal" value={settings.macdSignal} min={1} max={30}
                onChange={(v) => onUpdate({ macdSignal: v })} />
            </div>
          </div>

          <div className="h-px bg-zinc-800/70" />

          {/* Supertrend */}
          <div className="space-y-2">
            <SectionHeader tag="api">Supertrend</SectionHeader>
            <div className="flex flex-wrap gap-2">
              <NumInput label="Period" value={settings.stPeriod} min={1} max={30}
                onChange={(v) => onUpdate({ stPeriod: v })} />
              <NumInput label="Multiplier" value={settings.stMultiplier} min={0.5} max={10} step={0.5}
                onChange={(v) => onUpdate({ stMultiplier: v })} />
            </div>
          </div>

          <div className="h-px bg-zinc-800/70" />

          {/* EMAs */}
          <div className="space-y-2">
            <SectionHeader tag="api">EMA Periods</SectionHeader>
            <div className="flex flex-wrap gap-2">
              <NumInput label="EMA 1" value={settings.emaPeriod1} min={2} max={100}
                onChange={(v) => onUpdate({ emaPeriod1: v })} />
              <NumInput label="EMA 2" value={settings.emaPeriod2} min={5} max={200}
                onChange={(v) => onUpdate({ emaPeriod2: v })} />
              <NumInput label="EMA 3" value={settings.emaPeriod3} min={20} max={500}
                onChange={(v) => onUpdate({ emaPeriod3: v })} />
            </div>
          </div>

          <div className="h-px bg-zinc-800/70" />

          {/* ADX */}
          <div className="space-y-2">
            <SectionHeader tag="api">ADX</SectionHeader>
            <div className="flex flex-wrap gap-2">
              <NumInput label="Period" value={settings.adxPeriod} min={2} max={50}
                onChange={(v) => onUpdate({ adxPeriod: v })} />
            </div>
            <SectionHeader tag="ui">ADX Thresholds</SectionHeader>
            <div className="flex flex-wrap gap-2">
              <NumInput label="Strong" value={settings.adxStrong} min={10} max={60}
                onChange={(v) => onUpdate({ adxStrong: v })} />
              <NumInput label="Very Strong" value={settings.adxVeryStrong} min={15} max={80}
                onChange={(v) => onUpdate({ adxVeryStrong: v })} />
            </div>
          </div>

          <div className="h-px bg-zinc-800/70" />

          {/* Volume */}
          <div className="space-y-2">
            <SectionHeader tag="api">Volume</SectionHeader>
            <div className="flex flex-wrap gap-2">
              <NumInput label="MA Period" value={settings.volMaPeriod} min={5} max={100}
                onChange={(v) => onUpdate({ volMaPeriod: v })} />
            </div>
            <SectionHeader tag="ui">Volume Thresholds</SectionHeader>
            <div className="flex flex-wrap gap-2">
              <NumInput label="Spike ×" value={settings.volSpike} min={1} max={10} step={0.1}
                onChange={(v) => onUpdate({ volSpike: v })} />
              <NumInput label="Strong ×" value={settings.volStrongSpike} min={1} max={20} step={0.1}
                onChange={(v) => onUpdate({ volStrongSpike: v })} />
            </div>
          </div>

          <div className="h-px bg-zinc-800/70" />

          {/* Bollinger Bands */}
          <div className="space-y-2">
            <SectionHeader tag="api">Bollinger Bands</SectionHeader>
            <div className="flex flex-wrap gap-2">
              <NumInput label="Period" value={settings.bbPeriod} min={5} max={100}
                onChange={(v) => onUpdate({ bbPeriod: v })} />
            </div>
          </div>

          <div className="h-px bg-zinc-800/70" />

          {/* ATR */}
          <div className="space-y-2">
            <SectionHeader tag="api">ATR</SectionHeader>
            <div className="flex flex-wrap gap-2">
              <NumInput label="Period" value={settings.atrPeriod} min={1} max={50}
                onChange={(v) => onUpdate({ atrPeriod: v })} />
            </div>
          </div>

          {/* Bottom padding */}
          <div className="h-4" />
        </div>

        {/* Footer */}
        <div className="shrink-0 px-4 py-3 border-t border-zinc-800 flex items-center justify-between">
          <button
            onClick={onReset}
            className="flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-white transition-colors"
          >
            <RotateCcw className="h-3 w-3" /> Reset defaults
          </button>
          <div className="flex items-center gap-1 text-[9px] text-zinc-500">
            <span className="bg-amber-500/15 text-amber-400 px-1 py-0.5 rounded">Re-scan</span>
            <span>= triggers API call</span>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Universe options ─────────────────────────────────────────────────────────

const UNIVERSES = [
  { value: 'nifty50',  label: 'NIFTY 50' },
  { value: 'nifty500', label: 'NIFTY 500' },
  { value: 'all',      label: 'All NSE Stocks' },
] as const;
type Universe = typeof UNIVERSES[number]['value'];

// ─── Score filter presets ─────────────────────────────────────────────────────

const PRESETS = [
  { label: 'All', filter: () => true },
  { label: 'Score ≥80%', filter: (r: ScannerResult) => r.scorePercent >= 80 },
  { label: 'Score ≥60%', filter: (r: ScannerResult) => r.scorePercent >= 60 },
  { label: 'Trend Aligned', filter: (r: ScannerResult) => r.aboveEma20 && r.aboveEma50 && r.aboveEma200 && r.supertrendBullish },
  { label: 'RS Strong', filter: (r: ScannerResult) => r.rsRising20 && r.rsAboveMA && r.rsScore >= 60 },
  { label: 'Momentum', filter: (r: ScannerResult) => r.rsi14 > 60 && r.macdBullish && r.adx14 > 25 },
  { label: 'Vol Spike', filter: (r: ScannerResult) => r.volumeRatio >= 1.5 },
  { label: 'NR4/NR7', filter: (r: ScannerResult) => r.isNR4 || r.isNR7 },
];

// ─── CSV export ───────────────────────────────────────────────────────────────

function exportCSV(rows: ScannerResult[]) {
  const headers = [
    'Symbol', 'Sector', 'Close', '1D%', '1W%', '1M%',
    'EMA20', 'EMA50', 'EMA200', 'ST', 'RSI', 'MACD', 'ADX', 'BB', 'Vol×', 'RS', 'RS Score',
    'Score', 'Score%',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.symbol, r.sector, r.latestClose.toFixed(2),
      r.priceChange1D.toFixed(2), r.priceChange1W.toFixed(2), r.priceChange1M.toFixed(2),
      r.aboveEma20 ? 1 : 0,
      r.aboveEma50 ? 1 : 0,
      r.aboveEma200 ? 1 : 0,
      r.supertrendBullish ? 1 : 0,
      r.rsi14.toFixed(1),
      r.macdBullish ? 1 : 0,
      r.adx14.toFixed(1),
      r.bbExpanding ? 1 : 0,
      r.volumeRatio.toFixed(2),
      (r.rsRising20 && r.rsAboveMA) ? 2 : (r.rsRising20 || r.rsAboveMA) ? 1 : 0,
      r.rsScore,
      r.score,
      r.scorePercent.toFixed(1),
    ].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `scanner_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ─── Build API URL from settings ─────────────────────────────────────────────

function buildScanUrl(universe: Universe, s: ScannerSettings): string {
  const p = new URLSearchParams({ index: universe });
  const d = DEFAULT_SCANNER_PARAMS;
  // Only append params that differ from defaults to keep URL clean
  if (s.rsiPeriod    !== d.rsiPeriod)    p.set('rsiPeriod',    String(s.rsiPeriod));
  if (s.emaPeriod1   !== d.emaPeriod1)   p.set('emaPeriod1',   String(s.emaPeriod1));
  if (s.emaPeriod2   !== d.emaPeriod2)   p.set('emaPeriod2',   String(s.emaPeriod2));
  if (s.emaPeriod3   !== d.emaPeriod3)   p.set('emaPeriod3',   String(s.emaPeriod3));
  if (s.macdFast     !== d.macdFast)     p.set('macdFast',     String(s.macdFast));
  if (s.macdSlow     !== d.macdSlow)     p.set('macdSlow',     String(s.macdSlow));
  if (s.macdSignal   !== d.macdSignal)   p.set('macdSignal',   String(s.macdSignal));
  if (s.stPeriod     !== d.stPeriod)     p.set('stPeriod',     String(s.stPeriod));
  if (s.stMultiplier !== d.stMultiplier) p.set('stMultiplier', String(s.stMultiplier));
  if (s.bbPeriod     !== d.bbPeriod)     p.set('bbPeriod',     String(s.bbPeriod));
  if (s.adxPeriod    !== d.adxPeriod)    p.set('adxPeriod',    String(s.adxPeriod));
  if (s.atrPeriod    !== d.atrPeriod)    p.set('atrPeriod',    String(s.atrPeriod));
  if (s.volMaPeriod  !== d.volMaPeriod)  p.set('volMaPeriod',  String(s.volMaPeriod));
  return `/api/scanner?${p.toString()}`;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Scanner() {
  const [universe, setUniverse] = useState<Universe>('nifty50');
  const [data, setData] = useState<ScannerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'score', dir: 'desc' });
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<ScannerSettings>(DEFAULT_SETTINGS);

  // Load settings from localStorage after mount
  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  // Persist settings to localStorage on change
  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  }, [settings]);

  // Debounce ref for API params changes
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchData = useCallback(async (showLoading = true, overrideSettings?: ScannerSettings) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const s = overrideSettings ?? settings;
      const res = await fetch(buildScanUrl(universe, s));
      const json = await res.json();
      if (json.success) { setData(json.data); setLastUpdated(new Date()); }
      else setError(json.error ?? 'Unknown error');
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }, [universe, settings]);

  useEffect(() => { fetchData(); }, [fetchData]);

  function updateSettings(patch: Partial<ScannerSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      // Check if any API param changed
      const apiKeys: (keyof ScannerParams)[] = [
        'rsiPeriod', 'emaPeriod1', 'emaPeriod2', 'emaPeriod3',
        'macdFast', 'macdSlow', 'macdSignal', 'stPeriod', 'stMultiplier',
        'bbPeriod', 'adxPeriod', 'atrPeriod', 'volMaPeriod',
      ];
      const apiChanged = apiKeys.some((k) => prev[k] !== next[k]);
      if (apiChanged) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          fetchData(true, next);
        }, 1500);
      }
      return next;
    });
  }

  function resetSettings() {
    setSettings(DEFAULT_SETTINGS);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    fetchData(true, DEFAULT_SETTINGS);
  }

  // Sort handler
  function handleSort(key: SortKey) {
    setSort((prev) => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }));
  }

  // Filter + sort
  const rows: ScannerResult[] = React.useMemo(() => {
    if (!data) return [];
    let filtered = data.results;

    if (search.trim()) {
      const q = search.trim().toUpperCase();
      filtered = filtered.filter((r) => r.symbol.includes(q) || r.sector.toUpperCase().includes(q));
    }

    filtered = filtered.filter(PRESETS[preset].filter);

    if (sort.key !== 'none') {
      filtered = [...filtered].sort((a, b) => {
        const va = a[sort.key as keyof ScannerResult];
        const vb = b[sort.key as keyof ScannerResult];
        if (typeof va === 'boolean' && typeof vb === 'boolean') {
          return sort.dir === 'desc' ? (vb ? 1 : 0) - (va ? 1 : 0) : (va ? 1 : 0) - (vb ? 1 : 0);
        }
        if (typeof va === 'number' && typeof vb === 'number') {
          return sort.dir === 'desc' ? vb - va : va - vb;
        }
        return sort.dir === 'desc'
          ? String(vb).localeCompare(String(va))
          : String(va).localeCompare(String(vb));
      });
    }

    return filtered;
  }, [data, search, preset, sort]);

  // Summary counts — use settings thresholds
  const stats = data ? {
    total:         data.results.length,
    aboveEma200:   data.results.filter((r) => r.aboveEma200).length,
    trending:      data.results.filter((r) => r.aboveEma20 && r.aboveEma50 && r.aboveEma200).length,
    supertrendBull:data.results.filter((r) => r.supertrendBullish).length,
    rsiOB:         data.results.filter((r) => r.rsi14 >= settings.rsiOverbought).length,
    macdBull:      data.results.filter((r) => r.macdBullish).length,
    adxStrong:     data.results.filter((r) => r.adx14 >= settings.adxStrong).length,
    volSpike:      data.results.filter((r) => r.volumeRatio >= settings.volSpike).length,
    rsStrong:      data.results.filter((r) => r.rsRising20 && r.rsAboveMA).length,
    highScore:     data.results.filter((r) => r.scorePercent >= 60).length,
  } : null;

  const thProps = { currentSort: sort, onSort: handleSort };

  // EMA column labels from settings
  const ema1Label = `E${settings.emaPeriod1}`;
  const ema2Label = `E${settings.emaPeriod2}`;
  const ema3Label = `E${settings.emaPeriod3}`;

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-white">

      {/* Header */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0">
        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-md bg-gradient-to-tr from-emerald-600 to-cyan-500 flex items-center justify-center shrink-0">
            <BarChart2 className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-[14px] font-bold tracking-tight text-white">Tech Scanner</span>
        </div>

        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />

        {/* Nav */}
        <NavBar />

        {/* Universe selector */}
        <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
          {UNIVERSES.map((u) => (
            <button
              key={u.value}
              onClick={() => setUniverse(u.value)}
              className={cn(
                'px-2.5 py-1 font-semibold rounded transition-all',
                universe === u.value ? 'bg-emerald-500/10 text-emerald-400' : 'text-zinc-300 hover:text-white',
              )}
            >
              {u.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {lastUpdated && (
            <span className="text-[10px] text-zinc-500 hidden md:inline tabular-nums">
              {lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
            </span>
          )}
          {data && (
            <button
              onClick={() => exportCSV(rows)}
              className="h-7 px-2.5 flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800 transition-all text-[11px] font-medium"
            >
              <Download className="h-3 w-3" /> CSV
            </button>
          )}
          <button
            onClick={() => fetchData()}
            disabled={loading}
            className="h-7 w-7 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800 transition-all disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
          {/* Settings button */}
          <button
            onClick={() => setShowSettings((v) => !v)}
            className={cn(
              'h-7 w-7 flex items-center justify-center rounded-lg border transition-all',
              showSettings
                ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800',
            )}
            title="Indicator Settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* Settings panel */}
      {showSettings && (
        <SettingsPanel
          settings={settings}
          onUpdate={updateSettings}
          onClose={() => setShowSettings(false)}
          onReset={resetSettings}
        />
      )}

      <main className="flex-1 w-full max-w-[1800px] mx-auto px-4 py-3 flex flex-col gap-3">

        {/* Stat strip */}
        {stats && (
          <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5">
            {[
              { label: 'Total',                              value: stats.total,          color: 'text-white' },
              { label: `> ${ema3Label}`,                     value: stats.aboveEma200,    color: 'text-blue-300' },
              { label: 'EMA Trend',                          value: stats.trending,       color: 'text-emerald-300' },
              { label: 'Supertrend',                         value: stats.supertrendBull, color: 'text-teal-300' },
              { label: `RSI ≥ ${settings.rsiOverbought}`,   value: stats.rsiOB,          color: 'text-amber-300' },
              { label: 'MACD Bull',                          value: stats.macdBull,       color: 'text-cyan-300' },
              { label: `ADX ≥ ${settings.adxStrong}`,       value: stats.adxStrong,      color: 'text-violet-300' },
              { label: `Vol ≥ ${settings.volSpike}×`,       value: stats.volSpike,       color: 'text-orange-300' },
              { label: 'RS Strong',                          value: stats.rsStrong,       color: 'text-pink-300' },
              { label: 'Score ≥60%',                        value: stats.highScore,      color: 'text-lime-300' },
            ].map((s) => (
              <div key={s.label} className="flex flex-col items-center bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2">
                <span className={cn('text-[16px] font-bold tabular-nums leading-tight', s.color)}>{s.value}</span>
                <span className="text-[9px] text-zinc-300 uppercase tracking-wide mt-0.5 text-center whitespace-nowrap">{s.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 flex-1 min-w-[160px] max-w-[280px]">
            <Search className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search symbol / sector…"
              className="bg-transparent text-[12px] text-white placeholder:text-zinc-500 outline-none w-full"
            />
          </div>

          {/* Quick filter presets */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5 flex-wrap">
            {PRESETS.map((p, i) => (
              <button
                key={i}
                onClick={() => setPreset(i)}
                className={cn(
                  'px-2.5 py-1 font-semibold rounded transition-all',
                  preset === i ? 'bg-emerald-500/10 text-emerald-400' : 'text-zinc-300 hover:text-white',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          {rows.length > 0 && (
            <span className="text-[11px] text-zinc-300 ml-auto tabular-nums">{rows.length} stocks</span>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-950/10 p-4 text-center text-red-400 text-[12px]">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center p-16 rounded-lg border border-zinc-900 bg-zinc-950">
            <RefreshCw className="h-6 w-6 text-emerald-500 animate-spin" />
            <span className="text-zinc-300 text-[12px] mt-3">
              Computing indicators for {universe === 'nifty50' ? 'Nifty 50' : universe === 'nifty500' ? 'Nifty 500' : 'all NSE'} stocks…
            </span>
            {universe === 'all' && (
              <span className="text-zinc-500 text-[11px] mt-1">This may take 10–20 seconds for the full universe</span>
            )}
          </div>
        )}

        {/* Legend */}
        {!loading && data && (
          <div className="flex flex-wrap items-center gap-3 px-1 text-[10px] text-zinc-500">
            <span className="font-semibold text-zinc-300 uppercase tracking-wide">Legend:</span>
            <span>🟢 Strong Bullish</span>
            <span>✅ Bullish</span>
            <span>⚠️ Neutral</span>
            <span>❌ Bearish</span>
            <span>🔴 Strong Bearish</span>
            <span className="ml-auto text-zinc-500">Data: {data.dataDate}</span>
          </div>
        )}

        {/* Table */}
        {!loading && rows.length > 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-center">
                <thead>
                  <tr>
                    <TH right className="sticky left-0 z-10 bg-zinc-800 text-left" sortKey="symbol" {...thProps}>#  Symbol</TH>
                    <TH className="hidden lg:table-cell" sortKey="sector" {...thProps}>Sector</TH>
                    <TH right sortKey="latestClose" {...thProps}>Close</TH>
                    <TH right sortKey="priceChange1D" {...thProps}>1D%</TH>
                    <TH right sortKey="priceChange1W" {...thProps}>1W%</TH>
                    <TH right sortKey="priceChange1M" {...thProps}>1M%</TH>
                    {/* EMA — labels reflect configured periods */}
                    <TH sortKey="aboveEma20" {...thProps}>{ema1Label}</TH>
                    <TH sortKey="aboveEma50" {...thProps}>{ema2Label}</TH>
                    <TH sortKey="aboveEma200" {...thProps}>{ema3Label}</TH>
                    {/* Momentum */}
                    <TH sortKey="supertrendBullish" {...thProps}>ST</TH>
                    <TH sortKey="rsi14" {...thProps}>RSI</TH>
                    <TH sortKey="macdBullish" {...thProps}>MACD</TH>
                    <TH sortKey="adx14" {...thProps}>ADX</TH>
                    {/* Volatility */}
                    <TH sortKey="bbExpanding" {...thProps}>BB</TH>
                    <TH sortKey="atrExpanding" {...thProps}>ATR</TH>
                    {/* Volume */}
                    <TH sortKey="volumeRatio" {...thProps}>Vol</TH>
                    {/* RS */}
                    <TH sortKey="rsScore" {...thProps}>RS</TH>
                    <TH sortKey="rsScore" {...thProps}>RS%</TH>
                    {/* NR */}
                    <TH sortKey="isNR7" {...thProps}>NR</TH>
                    {/* Score */}
                    <TH right sortKey="scorePercent" {...thProps}>Score</TH>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={r.symbol}
                      className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors"
                    >
                      <TD className="sticky left-0 bg-zinc-950 group-hover:bg-zinc-800/20 text-left">
                        <div className="flex items-center gap-1.5">
                          <span className="text-zinc-500 text-[10px] w-5 tabular-nums">{i + 1}</span>
                          <span className="font-mono font-semibold text-white">{r.symbol}</span>
                        </div>
                      </TD>
                      <TD className="hidden lg:table-cell text-zinc-300 max-w-[100px] truncate text-left">{r.sector}</TD>
                      <TD right className="text-zinc-100 tabular-nums">₹{r.latestClose.toFixed(2)}</TD>
                      <TD right><PctBadge v={r.priceChange1D} /></TD>
                      <TD right><PctBadge v={r.priceChange1W} /></TD>
                      <TD right><PctBadge v={r.priceChange1M} /></TD>
                      {/* EMA */}
                      <TD>{boolCell(r.aboveEma20)}</TD>
                      <TD>{boolCell(r.aboveEma50)}</TD>
                      <TD>{boolCell(r.aboveEma200, r.ema50AboveEma200)}</TD>
                      {/* Momentum */}
                      <TD>{boolCell(r.supertrendBullish)}</TD>
                      <TD>
                        {rsiCell(r.rsi14, settings)}
                        <span className="ml-1 text-[10px] text-zinc-500 tabular-nums">{r.rsi14.toFixed(0)}</span>
                      </TD>
                      <TD>{macdCell(r)}</TD>
                      <TD>
                        {adxCell(r.adx14, settings)}
                        <span className="ml-1 text-[10px] text-zinc-500 tabular-nums">{r.adx14.toFixed(0)}</span>
                      </TD>
                      {/* Volatility */}
                      <TD>{boolCell(r.bbExpanding)}</TD>
                      <TD>{boolCell(r.atrExpanding)}</TD>
                      {/* Volume */}
                      <TD>
                        {volCell(r.volumeRatio, settings)}
                        <span className="ml-1 text-[10px] text-zinc-500 tabular-nums">{r.volumeRatio.toFixed(1)}×</span>
                      </TD>
                      {/* RS */}
                      <TD>{rsCell(r)}</TD>
                      <TD>
                        <span className={cn(
                          'inline-flex items-center px-1.5 py-px rounded text-[10px] font-bold tabular-nums',
                          r.rsScore >= 80 ? 'bg-emerald-500/15 text-emerald-400' :
                          r.rsScore >= 60 ? 'bg-lime-500/15 text-lime-400' :
                          r.rsScore >= 40 ? 'bg-zinc-700 text-zinc-300' :
                          'bg-red-500/10 text-red-400',
                        )}>
                          {r.rsScore}
                        </span>
                      </TD>
                      {/* NR */}
                      <TD>
                        {r.isNR4 && <span className="text-[10px] font-bold text-cyan-400">NR4</span>}
                        {r.isNR7 && <span className="text-[10px] font-bold text-sky-400 ml-0.5">NR7</span>}
                        {!r.isNR4 && !r.isNR7 && <span className="text-zinc-500">—</span>}
                      </TD>
                      {/* Score */}
                      <TD right><ScoreBar score={r.score} /></TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && rows.length === 0 && !error && data && (
          <div className="flex flex-col items-center justify-center p-12 rounded-lg border border-zinc-900 bg-zinc-950">
            <TrendingUp className="h-8 w-8 text-zinc-500 mb-3" />
            <p className="text-zinc-300 text-[13px]">No stocks match the current filter</p>
          </div>
        )}

      </main>
    </div>
  );
}

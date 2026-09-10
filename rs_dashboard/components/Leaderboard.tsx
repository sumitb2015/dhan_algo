'use client';

import React, { useState, useMemo } from 'react';
import {
  Search, ChevronDown, ChevronUp, Star,
  TrendingUp, TrendingDown, Minus, ArrowUpRight, ArrowDownRight,
  Download, Zap, Trophy, Flame, Eye
} from 'lucide-react';
import { RSResult } from '@/lib/rs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';

interface LeaderboardProps {
  data: RSResult[];
  selectedSymbol: string | null;
  onSelectSymbol: (symbol: string) => void;
  favorites: string[];
  onToggleFavorite: (symbol: string) => void;
}

type SortField =
  | 'symbol' | 'rsScore' | 'rsRatio' | 'rsRank' | 'rsChange1W'
  | 'priceChange1D' | 'priceChange1W' | 'priceChange1M' | 'priceChange3M' | 'priceChange1Y'
  | 'latestClose' | 'pctFrom52WHigh';
type SortOrder = 'asc' | 'desc';
type MomentumFilter = 'all' | 'rising' | 'falling';

type QuickPreset = 'none' | 'top20' | 'leaders' | 'momentum' | 'near52wh' | 'rsnewhi';

const QUICK_PRESETS: { id: QuickPreset; label: string; icon: React.ReactNode; description: string }[] = [
  { id: 'top20',    label: 'Top 20',       icon: <Trophy className="h-3 w-3" />,   description: 'Top 20 by RS Score' },
  { id: 'leaders',  label: 'Grade A',      icon: <Zap className="h-3 w-3" />,      description: 'Grade A leaders only' },
  { id: 'momentum', label: 'Rising RS',    icon: <Flame className="h-3 w-3" />,    description: 'Rising RS momentum' },
  { id: 'near52wh', label: 'Near 52W Hi',  icon: <ArrowUpRight className="h-3 w-3" />, description: 'Within 5% of 52-week high' },
  { id: 'rsnewhi',  label: 'RS New Hi',    icon: <TrendingUp className="h-3 w-3" />,   description: 'RS at 20-day high' },
];

function Sparkline({ data }: { data: number[] }) {
  if (!data || data.length === 0) return <div className="text-zinc-600 text-xs">—</div>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min === 0 ? 1 : max - min;
  const width = 64;
  const height = 24;
  const pad = 2;

  // A single-point trend (e.g. a recently-listed stock with < 20 trading
  // days of RS history) has no span to divide across — treat it as width 1
  // so x/y positions resolve instead of dividing by zero into NaN.
  const denom = data.length - 1 || 1;

  const points = data
    .map((val, idx) => {
      const x = pad + (idx / denom) * (width - pad * 2);
      const y = pad + (1 - (val - min) / range) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const last = data[data.length - 1];
  const first = data[0];
  const isUp = last >= first;
  // Series colour tied to actual price direction — the CLAUDE.md "saturated
  // data colour" exception, not chrome, so it stays a direct hex pair rather
  // than the page's amber accent.
  const color = isUp ? '#10b981' : '#ef4444';
  const lastX = pad + ((data.length - 1) / denom) * (width - pad * 2);
  const lastY = pad + (1 - (last - min) / range) * (height - pad * 2);

  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" points={points} />
      <circle cx={lastX} cy={lastY} r="2" fill={color} />
    </svg>
  );
}

function MomentumBadge({ momentum, change }: { momentum: RSResult['rsMomentum']; change: number }) {
  if (momentum === 'rising') {
    return (
      <div className="flex items-center gap-1 text-emerald-400">
        <TrendingUp className="h-3 w-3" />
        <span className="text-xs font-mono font-semibold">+{(change * 100).toFixed(2)}%</span>
      </div>
    );
  }
  if (momentum === 'falling') {
    return (
      <div className="flex items-center gap-1 text-red-400">
        <TrendingDown className="h-3 w-3" />
        <span className="text-xs font-mono font-semibold">{(change * 100).toFixed(2)}%</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 text-zinc-500">
      <Minus className="h-3 w-3" />
      <span className="text-xs font-mono">{(change * 100).toFixed(2)}%</span>
    </div>
  );
}

function exportToCSV(data: RSResult[]) {
  const headers = [
    'Symbol', 'Rank', 'RS Score', 'Grade', 'RS Momentum', 'RS Ratio', 'RS Change 1W',
    'Close', '1D%', '1W%', '1M%', '3M%', '1Y%', '% From 52W Hi', 'Sector'
  ];
  const rows = data.map((s) => [
    s.symbol,
    s.rsRank,
    s.rsScore,
    s.rsRating,
    s.rsMomentum,
    (s.rsRatio * 100).toFixed(2),
    (s.rsChange1W * 100).toFixed(2),
    s.latestClose.toFixed(2),
    s.priceChange1D.toFixed(2),
    s.priceChange1W.toFixed(2),
    s.priceChange1M.toFixed(2),
    s.priceChange3M.toFixed(2),
    s.priceChange1Y.toFixed(2),
    (s.pctFrom52WHigh ?? 0).toFixed(2),
    s.sector ?? '',
  ]);

  const csv = [headers, ...rows].map((r) => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rs_scanner_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Leaderboard({
  data,
  selectedSymbol,
  onSelectSymbol,
  favorites,
  onToggleFavorite,
}: LeaderboardProps) {
  const [search, setSearch] = useState('');
  const [selectedSector, setSelectedSector] = useState('All');
  const [selectedRating, setSelectedRating] = useState('All');
  const [momentumFilter, setMomentumFilter] = useState<MomentumFilter>('all');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [activePreset, setActivePreset] = useState<QuickPreset>('none');

  const [sortField, setSortField] = useState<SortField>('rsScore');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const totalStocks = data.length;

  const sectors = useMemo(() => {
    const set = new Set<string>();
    data.forEach((item) => { if (item.sector) set.add(item.sector); });
    return ['All', ...Array.from(set).sort()];
  }, [data]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
    setPage(1);
  };

  const handlePreset = (preset: QuickPreset) => {
    setActivePreset(preset === activePreset ? 'none' : preset);
    setPage(1);
    // Reset other filters when applying a preset
    if (preset !== activePreset) {
      setSearch('');
      setSelectedSector('All');
      setSelectedRating('All');
      setMomentumFilter('all');
      setShowFavoritesOnly(false);
    }
  };

  const processedData = useMemo(() => {
    let filtered = [...data];

    // Apply quick preset
    if (activePreset === 'top20') {
      filtered = filtered.sort((a, b) => b.rsScore - a.rsScore).slice(0, 20);
    } else if (activePreset === 'leaders') {
      filtered = filtered.filter((s) => s.rsRating === 'A');
    } else if (activePreset === 'momentum') {
      filtered = filtered.filter((s) => s.rsMomentum === 'rising');
    } else if (activePreset === 'near52wh') {
      filtered = filtered.filter((s) => (s.pctFrom52WHigh ?? -100) >= -5);
    } else if (activePreset === 'rsnewhi') {
      filtered = filtered.filter((s) => s.isRSNewHigh);
    } else {
      // Manual filters
      filtered = filtered.filter((item) => {
        const matchesSearch = item.symbol.toLowerCase().includes(search.toLowerCase());
        const matchesSector = selectedSector === 'All' || item.sector === selectedSector;
        const matchesRating = selectedRating === 'All' || item.rsRating === selectedRating;
        const matchesMomentum = momentumFilter === 'all' || item.rsMomentum === momentumFilter;
        const matchesFav = !showFavoritesOnly || favorites.includes(item.symbol);
        return matchesSearch && matchesSector && matchesRating && matchesMomentum && matchesFav;
      });
    }

    if (activePreset !== 'top20') {
      filtered.sort((a, b) => {
        const aVal = a[sortField as keyof RSResult] as number | string | undefined;
        const bVal = b[sortField as keyof RSResult] as number | string | undefined;
        if (aVal === undefined) return 1;
        if (bVal === undefined) return -1;
        if (typeof aVal === 'string') {
          return sortOrder === 'asc' ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
        }
        return sortOrder === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
      });
    }

    return filtered;
  }, [data, search, selectedSector, selectedRating, momentumFilter, showFavoritesOnly, favorites, sortField, sortOrder, activePreset]);

  const paginatedData = useMemo(() => {
    const start = (page - 1) * pageSize;
    return processedData.slice(start, start + pageSize);
  }, [processedData, page, pageSize]);

  const totalPages = Math.max(1, Math.ceil(processedData.length / pageSize));

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ChevronDown className="inline h-3 w-3 ml-0.5 text-zinc-500" />;
    return sortOrder === 'asc'
      ? <ChevronUp className="inline h-3.5 w-3.5 ml-0.5 text-amber-400" />
      : <ChevronDown className="inline h-3.5 w-3.5 ml-0.5 text-amber-400" />;
  };

  const gradeStyle: Record<string, string> = {
    A: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
    B: 'bg-blue-500/15 text-blue-300 border border-blue-500/30',
    C: 'bg-zinc-600/20 text-zinc-400 border border-zinc-600/40',
    D: 'bg-red-500/10 text-red-400 border border-red-500/25',
  };

  // Flat fills, not gradients — the Bloomberg style has no gradients anywhere.
  const scoreBarStyle = (score: number) => {
    if (score >= 80) return 'bg-emerald-500';
    if (score >= 60) return 'bg-blue-500';
    if (score >= 40) return 'bg-zinc-500';
    return 'bg-red-500';
  };

  const pctColor = (val: number) => val >= 0 ? 'text-emerald-400' : 'text-red-400';
  const pctFmt = (val: number) => `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;

  const from52WColor = (val: number) => {
    if (val >= -2) return 'text-emerald-400';
    if (val >= -5) return 'text-amber-400';
    if (val >= -15) return 'text-zinc-300';
    return 'text-zinc-500';
  };

  return (
    <div className="flex flex-col h-full rounded-xl border border-zinc-800 bg-zinc-900/70 overflow-hidden">
      {/* ── Quick Presets ── */}
      <div className="flex-none px-3 pt-3 pb-2 border-b border-amber-500/25 bg-zinc-950/60">
        <div className="flex items-center gap-1.5 flex-wrap">
          {QUICK_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              onClick={() => handlePreset(preset.id)}
              title={preset.description}
              variant="outline"
              size="xs"
              className={`gap-1 rounded-lg text-[11px] font-semibold h-6 ${
                activePreset === preset.id
                  ? 'bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/20'
                  : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300 hover:border-zinc-700'
              }`}
            >
              {preset.icon}
              {preset.label}
            </Button>
          ))}
          {activePreset !== 'none' && (
            <Button
              onClick={() => setActivePreset('none')}
              variant="ghost"
              size="xs"
              className="text-[10px] text-zinc-600 hover:text-zinc-400 h-6"
            >
              Clear
            </Button>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              onClick={() => { setShowFavoritesOnly(!showFavoritesOnly); setActivePreset('none'); setPage(1); }}
              variant="outline"
              size="xs"
              className={`gap-1 rounded-lg text-[11px] font-semibold h-6 ${
                showFavoritesOnly
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/15'
                  : 'bg-zinc-900/60 border-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Eye className="h-3 w-3" />
              Watch
            </Button>
            <Button
              onClick={() => exportToCSV(processedData)}
              variant="outline"
              size="xs"
              className="gap-1 rounded-lg text-[11px] font-semibold h-6 border-zinc-800 bg-zinc-900/60 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700"
              title="Export filtered results to CSV"
            >
              <Download className="h-3 w-3" />
              CSV
            </Button>
          </div>
        </div>
      </div>

      {/* ── Search & Filters ── */}
      {activePreset === 'none' && (
        <div className="flex-none px-3 py-2 border-b border-zinc-800/60 bg-zinc-900/10 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[120px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500 pointer-events-none" />
            <Input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-8 h-7 border-zinc-800 bg-zinc-900/60 text-white placeholder:text-zinc-600 text-xs rounded-lg focus-visible:ring-amber-500/40"
            />
          </div>

          {/* Momentum Filter */}
          <div className="flex items-center bg-zinc-900/60 border border-zinc-800 p-0.5 rounded-lg">
            {(['all', 'rising', 'falling'] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMomentumFilter(m); setPage(1); }}
                className={`flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-md transition-all ${
                  momentumFilter === m
                    ? m === 'rising' ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
                      : m === 'falling' ? 'bg-red-500/15 text-red-400 border border-red-500/25'
                      : 'bg-zinc-800 text-zinc-200 border border-zinc-700'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {m === 'rising' && <TrendingUp className="h-3 w-3" />}
                {m === 'falling' && <TrendingDown className="h-3 w-3" />}
                {m === 'all' && <Minus className="h-3 w-3" />}
                <span className="capitalize hidden sm:block">{m}</span>
              </button>
            ))}
          </div>

          <Select value={selectedSector} onValueChange={(v) => { if (v) { setSelectedSector(v); setPage(1); } }}>
            <SelectTrigger className="h-7 w-auto min-w-[110px] border-zinc-800 bg-zinc-900/60 text-zinc-300 text-xs rounded-lg focus-visible:ring-amber-500/40">
              <SelectValue placeholder="All Sectors" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All Sectors</SelectItem>
              {sectors.filter((s) => s !== 'All').map((sec) => (
                <SelectItem key={sec} value={sec}>{sec}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={selectedRating} onValueChange={(v) => { if (v) { setSelectedRating(v); setPage(1); } }}>
            <SelectTrigger className="h-7 w-auto min-w-[100px] border-zinc-800 bg-zinc-900/60 text-zinc-300 text-xs rounded-lg focus-visible:ring-amber-500/40">
              <SelectValue placeholder="All Grades" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All Grades</SelectItem>
              <SelectItem value="A">Grade A</SelectItem>
              <SelectItem value="B">Grade B</SelectItem>
              <SelectItem value="C">Grade C</SelectItem>
              <SelectItem value="D">Grade D</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* ── Table ── */}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-left border-collapse" style={{ minWidth: 720 }}>
          <thead className="sticky top-0 z-10">
            {/* text-xs font-bold text-white on solid bg-zinc-800 — CLAUDE.md's
                dashboard table-header rule, not specific to this page. */}
            <tr className="bg-zinc-800 text-xs font-bold text-white uppercase tracking-wide select-none">
              <th className="py-2.5 px-2 w-8 text-center">★</th>
              <th className="py-2.5 px-3 cursor-pointer hover:text-amber-300 transition-colors whitespace-nowrap" onClick={() => handleSort('symbol')}>
                Symbol <SortIcon field="symbol" />
              </th>
              <th className="py-2.5 px-2 text-center cursor-pointer hover:text-amber-300 transition-colors" onClick={() => handleSort('rsRank')} title="RS Rank (1 = strongest)">
                Rank <SortIcon field="rsRank" />
              </th>
              <th className="py-2.5 px-2 text-center cursor-pointer hover:text-amber-300 transition-colors" onClick={() => handleSort('rsScore')}>
                Score <SortIcon field="rsScore" />
              </th>
              <th className="py-2.5 px-2 text-center">Grade</th>
              <th className="py-2.5 px-2 text-center cursor-pointer hover:text-amber-300 transition-colors" onClick={() => handleSort('rsChange1W')} title="RS momentum: 5-day RS change">
                RS Mom <SortIcon field="rsChange1W" />
              </th>
              <th className="py-2.5 px-2 text-right cursor-pointer hover:text-amber-300 transition-colors" onClick={() => handleSort('latestClose')}>
                Close <SortIcon field="latestClose" />
              </th>
              <th className="py-2.5 px-2 text-right cursor-pointer hover:text-amber-300 transition-colors" onClick={() => handleSort('priceChange1D')}>
                1D <SortIcon field="priceChange1D" />
              </th>
              <th className="py-2.5 px-2 text-right cursor-pointer hover:text-amber-300 transition-colors" onClick={() => handleSort('priceChange3M')}>
                3M <SortIcon field="priceChange3M" />
              </th>
              <th
                className="py-2.5 px-2 text-right cursor-pointer hover:text-amber-300 transition-colors whitespace-nowrap"
                onClick={() => handleSort('pctFrom52WHigh')}
                title="% below 52-week high (0% = at 52W high)"
              >
                52WH% <SortIcon field="pctFrom52WHigh" />
              </th>
              <th className="py-2.5 px-3 text-center">Trend</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900/50 text-sm">
            {paginatedData.length === 0 ? (
              <tr>
                <td colSpan={11} className="py-10 text-center text-zinc-500 text-sm">
                  No matching stocks found.
                </td>
              </tr>
            ) : (
              paginatedData.map((item) => {
                const isSelected = selectedSymbol === item.symbol;
                const isFavorite = favorites.includes(item.symbol);
                const pctFrom52W = item.pctFrom52WHigh ?? 0;

                return (
                  <tr
                    key={item.symbol}
                    onClick={() => onSelectSymbol(item.symbol)}
                    className={`cursor-pointer hover:bg-zinc-800/40 transition-colors duration-100 select-none ${
                      isSelected ? 'bg-amber-500/10 border-l-2 border-l-amber-500' : 'border-l-2 border-l-transparent'
                    }`}
                  >
                    {/* Favorite */}
                    <td className="py-2.5 px-2 text-center" onClick={(e) => { e.stopPropagation(); onToggleFavorite(item.symbol); }}>
                      <button className="text-zinc-600 hover:text-amber-400 transition-colors">
                        <Star className={`h-3 w-3 ${isFavorite ? 'fill-amber-400 text-amber-400' : ''}`} />
                      </button>
                    </td>

                    {/* Symbol + Sector + RS New High */}
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-white tracking-wide text-sm leading-none">{item.symbol}</span>
                        {item.isRSNewHigh && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/25 uppercase tracking-wide leading-none">
                            <Zap className="h-2.5 w-2.5" />NH
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-zinc-600 truncate max-w-[100px] mt-0.5">{item.sector || 'Unassigned'}</div>
                    </td>

                    {/* Rank */}
                    <td className="py-2.5 px-2 text-center">
                      <span className={`font-mono text-xs font-bold ${item.rsRank <= Math.ceil(totalStocks * 0.1) ? 'text-emerald-400' : item.rsRank <= Math.ceil(totalStocks * 0.3) ? 'text-blue-400' : 'text-zinc-500'}`}>
                        #{item.rsRank}
                      </span>
                    </td>

                    {/* RS Score */}
                    <td className="py-2.5 px-2">
                      <div className="flex flex-col items-center gap-1 min-w-[52px]">
                        <span className="font-bold text-white text-sm leading-none">{item.rsScore}</span>
                        <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${scoreBarStyle(item.rsScore)}`} style={{ width: `${item.rsScore}%` }} />
                        </div>
                      </div>
                    </td>

                    {/* Grade */}
                    <td className="py-2.5 px-2 text-center">
                      <Badge className={`text-[11px] font-bold px-2 h-5 rounded-full ${gradeStyle[item.rsRating]}`}>
                        {item.rsRating}
                      </Badge>
                    </td>

                    {/* RS Momentum */}
                    <td className="py-2.5 px-2 text-center">
                      <MomentumBadge momentum={item.rsMomentum} change={item.rsChange1W} />
                    </td>

                    {/* Close Price */}
                    <td className="py-2.5 px-2 text-right font-mono text-zinc-200 text-xs font-medium">
                      ₹{item.latestClose.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>

                    {/* 1D */}
                    <td className={`py-2.5 px-2 text-right font-mono text-xs font-semibold ${pctColor(item.priceChange1D)}`}>
                      <div className="flex items-center justify-end gap-0.5">
                        {item.priceChange1D >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                        {Math.abs(item.priceChange1D).toFixed(2)}%
                      </div>
                    </td>

                    {/* 3M */}
                    <td className={`py-2.5 px-2 text-right font-mono text-xs font-medium ${pctColor(item.priceChange3M)}`}>
                      {pctFmt(item.priceChange3M)}
                    </td>

                    {/* % From 52W High */}
                    <td className={`py-2.5 px-2 text-right font-mono text-xs font-medium ${from52WColor(pctFrom52W)}`}>
                      <div className="flex flex-col items-end gap-0.5">
                        <span>{pctFrom52W >= 0 ? '0.0%' : `${pctFrom52W.toFixed(1)}%`}</span>
                        {pctFrom52W >= -2 && (
                          <span className="text-[9px] text-emerald-400 leading-none">@ hi</span>
                        )}
                      </div>
                    </td>

                    {/* RS Trend Sparkline */}
                    <td className="py-2.5 px-3 text-center">
                      <div className="flex items-center justify-center">
                        <Sparkline data={item.trend} />
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      <div className="flex-none px-3 py-2 border-t border-zinc-800/60 bg-zinc-900/10 flex items-center justify-between text-[11px] text-zinc-400">
        <div className="flex items-center gap-2">
          <span>
            <span className="text-zinc-300 font-medium">{processedData.length}</span>
            <span className="text-zinc-600"> / {totalStocks} stocks</span>
          </span>
          <Select value={String(pageSize)} onValueChange={(v) => { if (v) { setPageSize(Number(v)); setPage(1); } }}>
            <SelectTrigger className="h-6 w-auto border-zinc-800 bg-zinc-900/60 text-zinc-400 text-[11px] rounded-lg">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[15, 20, 30, 50].map((n) => (
                <SelectItem key={n} value={String(n)}>{n}/page</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <Button disabled={page === 1} onClick={() => setPage(1)} variant="outline" size="xs" className="h-6 border-zinc-800 hover:border-zinc-700 rounded-lg">«</Button>
          <Button disabled={page === 1} onClick={() => setPage(page - 1)} variant="outline" size="xs" className="h-6 border-zinc-800 hover:border-zinc-700 rounded-lg">‹</Button>
          <span className="px-2 font-medium text-zinc-300 tabular-nums">{page} / {totalPages}</span>
          <Button disabled={page === totalPages} onClick={() => setPage(page + 1)} variant="outline" size="xs" className="h-6 border-zinc-800 hover:border-zinc-700 rounded-lg">›</Button>
          <Button disabled={page === totalPages} onClick={() => setPage(totalPages)} variant="outline" size="xs" className="h-6 border-zinc-800 hover:border-zinc-700 rounded-lg">»</Button>
        </div>
      </div>
    </div>
  );
}

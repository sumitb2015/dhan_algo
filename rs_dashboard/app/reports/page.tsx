'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import NavBar from '@/components/NavBar';
import {
  Layers, Download, Play, RefreshCw, FileSpreadsheet, FileText,
  ChevronUp, ChevronDown, Search, BarChart3, TrendingUp, Briefcase,
  Wrench, Clock, AlertCircle, CheckCircle2, Loader2, ImageIcon,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type FileInfo = { path: string; name: string; size: number; modifiedAt: string };

type Report = {
  id: string;
  name: string;
  description: string;
  category: 'analysis' | 'screener' | 'portfolio' | 'tools';
  estimatedMinutes: number;
  csvPreview: string | null;
  primaryFile: FileInfo | null;
  files: FileInfo[];
  running: boolean;
  runError: string | null;
};

type SortDir = 'asc' | 'desc';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Asia/Kolkata',
  });
}

function fileExt(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function FileIcon({ name }: { name: string }) {
  const ext = fileExt(name);
  if (ext === 'xlsx') return <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-400" />;
  if (ext === 'png') return <ImageIcon className="h-3.5 w-3.5 text-violet-400" />;
  return <FileText className="h-3.5 w-3.5 text-zinc-400" />;
}

function pctColor(v: number | null) {
  if (v === null) return 'text-zinc-500';
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-400';
}

function pctFmt(v: number | null, decimals = 2) {
  if (v === null) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(decimals) + '%';
}

const CATEGORY_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  analysis: { label: 'Analysis', color: 'text-sky-400 bg-sky-500/10 border-sky-500/20', icon: <BarChart3 className="h-4 w-4" /> },
  screener: { label: 'Screeners', color: 'text-violet-400 bg-violet-500/10 border-violet-500/20', icon: <TrendingUp className="h-4 w-4" /> },
  portfolio: { label: 'Portfolio', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', icon: <Briefcase className="h-4 w-4" /> },
  tools: { label: 'Tools', color: 'text-amber-400 bg-amber-500/10 border-amber-500/20', icon: <Wrench className="h-4 w-4" /> },
};

// ─── Report Card ──────────────────────────────────────────────────────────────

function ReportCard({
  report,
  onRun,
  onPreview,
  activePreviewId,
}: {
  report: Report;
  onRun: (id: string) => void;
  onPreview: (id: string) => void;
  activePreviewId: string | null;
}) {
  const meta = CATEGORY_META[report.category];
  const isPreviewing = activePreviewId === report.id;

  return (
    <div className={`rounded-xl border bg-zinc-950/60 backdrop-blur transition-all duration-200 ${
      isPreviewing ? 'border-emerald-500/30 shadow-lg shadow-emerald-500/5' : 'border-zinc-800/60 hover:border-zinc-700/80'
    }`}>
      <div className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${meta.color}`}>
                {meta.label}
              </span>
              {report.running && (
                <span className="flex items-center gap-1 text-[10px] text-amber-400 font-medium">
                  <Loader2 className="h-3 w-3 animate-spin" /> Running…
                </span>
              )}
              {report.runError && !report.running && (
                <span className="flex items-center gap-1 text-[10px] text-red-400 font-medium">
                  <AlertCircle className="h-3 w-3" /> Error
                </span>
              )}
            </div>
            <h3 className="text-sm font-semibold text-zinc-100 truncate">{report.name}</h3>
          </div>
          {/* Est time */}
          <span className="shrink-0 flex items-center gap-1 text-[10px] text-zinc-600">
            <Clock className="h-3 w-3" />{report.estimatedMinutes}m
          </span>
        </div>

        <p className="text-xs text-zinc-500 leading-relaxed mb-3">{report.description}</p>

        {/* Last generated */}
        {report.primaryFile ? (
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 mb-3">
            <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
            <span className="truncate">
              Last: {fmtDate(report.primaryFile.modifiedAt)} · {fmtSize(report.primaryFile.size)}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 mb-3">
            <AlertCircle className="h-3 w-3 shrink-0" />
            Not yet generated
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => onRun(report.id)}
            disabled={report.running}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              report.running
                ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20'
            }`}
          >
            {report.running
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <Play className="h-3 w-3" />}
            {report.running ? 'Running' : 'Run'}
          </button>

          {report.files.map(f => (
            <a
              key={f.path}
              href={`/api/reports/download?file=${encodeURIComponent(f.path)}`}
              download
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 ${
                !report.primaryFile ? 'pointer-events-none opacity-30' : ''
              }`}
            >
              <FileIcon name={f.name} />
              <Download className="h-3 w-3" />
              {f.name.split('.').pop()?.toUpperCase()}
            </a>
          ))}

          {report.csvPreview && (
            <button
              onClick={() => onPreview(report.id)}
              disabled={!report.primaryFile}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                isPreviewing
                  ? 'bg-sky-500/10 text-sky-400 border-sky-500/20'
                  : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
              } ${!report.primaryFile ? 'pointer-events-none opacity-30' : ''}`}
            >
              {isPreviewing ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              Preview
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Stock Table ──────────────────────────────────────────────────────────────

const PRIORITY_COLS = ['Stock', 'Price', 'Daily %', '1W %', '1M %', 'YTD %', '1Y %', 'RSI (14)', '% from 52W High', '% from 52W Low', '% from 200 DMA'];
const PCT_COLS = new Set(['Daily %', '1W %', '1M %', 'YTD %', '1Y %', '% from 52W High', '% from 52W Low', '% from 50 DMA', '% from 200 DMA']);

function StockTable({ csvFile }: { csvFile: string }) {
  const [data, setData] = useState<{ columns: string[]; rows: Record<string, any>[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<string>('');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/reports/csv?file=${encodeURIComponent(csvFile)}`)
      .then(r => r.json())
      .then(j => {
        if (j.success) setData(j);
        else setError(j.error || 'Failed to load');
      })
      .catch(() => setError('Network error'))
      .finally(() => setLoading(false));
  }, [csvFile]);

  const columns = useMemo(() => {
    if (!data) return [];
    const priority = PRIORITY_COLS.filter(c => data.columns.includes(c));
    const rest = data.columns.filter(c => !PRIORITY_COLS.includes(c));
    return [...priority, ...rest];
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.toLowerCase();
    return data.rows.filter(r =>
      !q || String(r['Stock'] || r['Symbol'] || '').toLowerCase().includes(q)
    );
  }, [data, search]);

  const sorted = useMemo(() => {
    if (!sortCol) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortCol, sortDir]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
    setPage(0);
  };

  useEffect(() => { setPage(0); }, [search]);

  if (loading) return (
    <div className="flex items-center justify-center py-12 text-zinc-500 gap-2">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading data…
    </div>
  );
  if (error) return (
    <div className="flex items-center justify-center py-12 text-red-400 gap-2">
      <AlertCircle className="h-4 w-4" /> {error}
    </div>
  );
  if (!data) return null;

  return (
    <div className="mt-1">
      {/* Search + pagination */}
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by symbol…"
            className="pl-8 pr-3 py-1.5 text-xs bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 w-48"
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>{sorted.length} stocks</span>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-2 py-1 rounded border border-zinc-800 bg-zinc-900 disabled:opacity-30 hover:border-zinc-700 text-zinc-400"
          >
            ‹
          </button>
          <span>{page + 1}/{pages}</span>
          <button
            onClick={() => setPage(p => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1}
            className="px-2 py-1 rounded border border-zinc-800 bg-zinc-900 disabled:opacity-30 hover:border-zinc-700 text-zinc-400"
          >
            ›
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/60">
              {columns.map(col => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  className="px-3 py-2 text-right first:text-left font-semibold text-zinc-400 whitespace-nowrap cursor-pointer hover:text-zinc-200 select-none"
                >
                  <span className="inline-flex items-center gap-1">
                    {col}
                    {sortCol === col && (
                      sortDir === 'asc'
                        ? <ChevronUp className="h-3 w-3" />
                        : <ChevronDown className="h-3 w-3" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, i) => (
              <tr
                key={i}
                className="border-b border-zinc-900 hover:bg-zinc-900/40 transition-colors"
              >
                {columns.map(col => {
                  const val = row[col];
                  const isFirst = col === columns[0];
                  const isPct = PCT_COLS.has(col);

                  if (isFirst) {
                    return (
                      <td key={col} className="px-3 py-2 text-left font-semibold text-zinc-200 whitespace-nowrap">
                        {val ?? '—'}
                      </td>
                    );
                  }
                  if (isPct && typeof val === 'number') {
                    return (
                      <td key={col} className={`px-3 py-2 text-right font-medium whitespace-nowrap ${pctColor(val)}`}>
                        {pctFmt(val)}
                      </td>
                    );
                  }
                  if (typeof val === 'number') {
                    return (
                      <td key={col} className="px-3 py-2 text-right text-zinc-300 whitespace-nowrap">
                        {val.toFixed(2)}
                      </td>
                    );
                  }
                  return (
                    <td key={col} className="px-3 py-2 text-right text-zinc-500 whitespace-nowrap">
                      {val ?? '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const CATEGORIES: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'analysis', label: 'Analysis' },
  { key: 'screener', label: 'Screeners' },
  { key: 'portfolio', label: 'Portfolio' },
  { key: 'tools', label: 'Tools' },
];

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState('all');
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  const fetchReports = useCallback(async () => {
    try {
      const res = await fetch('/api/reports');
      const json = await res.json();
      if (json.success) setReports(json.reports);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchReports();
    const interval = setInterval(fetchReports, 5000);
    return () => clearInterval(interval);
  }, [fetchReports]);

  const handleRun = async (id: string) => {
    setRunningIds(prev => new Set([...prev, id]));
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scriptId: id }),
      });
      const json = await res.json();
      if (!res.ok) alert(json.error || 'Failed to start script');
    } catch {
      alert('Network error');
    } finally {
      setTimeout(() => {
        setRunningIds(prev => { const s = new Set(prev); s.delete(id); return s; });
        fetchReports();
      }, 3000);
    }
  };

  const handlePreview = (id: string) => {
    setActivePreviewId(prev => prev === id ? null : id);
  };

  const filteredReports = activeCategory === 'all'
    ? reports
    : reports.filter(r => r.category === activeCategory);

  const activePreviewReport = reports.find(r => r.id === activePreviewId);

  // Merge client-side running state with server state
  const mergedReports = reports.map(r => ({
    ...r,
    running: r.running || runningIds.has(r.id),
  }));
  const filteredMerged = activeCategory === 'all'
    ? mergedReports
    : mergedReports.filter(r => r.category === activeCategory);

  const totalReports = reports.length;
  const generatedCount = reports.filter(r => r.primaryFile).length;

  return (
    <div className="flex flex-col min-h-screen bg-black text-zinc-100">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-5 py-3 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-3 shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/10">
            <Layers className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent leading-none">
              Analysis Reports
            </h1>
            <p className="text-[10px] text-zinc-600 font-medium mt-0.5">Nifty 500 · Screeners · Portfolio</p>
          </div>
        </div>

        <NavBar />

        <button
          onClick={fetchReports}
          className="p-1.5 border border-zinc-800 rounded-lg bg-zinc-900/40 text-zinc-400 hover:text-white transition-all hover:border-zinc-700 ml-auto"
          title="Refresh report list"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </header>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <main className="flex-1 px-5 py-6 max-w-7xl mx-auto w-full">

        {/* Summary bar */}
        <div className="flex items-center gap-4 mb-6">
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <span className="text-zinc-200 font-semibold">{generatedCount}</span>
            <span>/ {totalReports} reports generated</span>
          </div>
          <div className="h-1.5 flex-1 max-w-xs bg-zinc-900 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-600 to-teal-400 rounded-full transition-all duration-500"
              style={{ width: `${totalReports ? (generatedCount / totalReports) * 100 : 0}%` }}
            />
          </div>
        </div>

        {/* Category filter tabs */}
        <div className="flex items-center gap-1 mb-6 p-1 bg-zinc-900/60 border border-zinc-800 rounded-xl w-fit">
          {CATEGORIES.map(cat => (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                activeCategory === cat.key
                  ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {cat.label}
              {cat.key !== 'all' && (
                <span className="ml-1.5 text-[10px] opacity-60">
                  {reports.filter(r => r.category === cat.key).length}
                </span>
              )}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20 text-zinc-500 gap-2">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading reports…
          </div>
        ) : (
          <>
            {/* Report cards grid */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredMerged.map(report => (
                <ReportCard
                  key={report.id}
                  report={report}
                  onRun={handleRun}
                  onPreview={handlePreview}
                  activePreviewId={activePreviewId}
                />
              ))}
            </div>

            {filteredMerged.length === 0 && (
              <div className="text-center py-20 text-zinc-600">No reports in this category</div>
            )}
          </>
        )}

        {/* ── Preview Panel ──────────────────────────────────────────────── */}
        {activePreviewId && activePreviewReport?.csvPreview && (
          <div className="mt-8 rounded-xl border border-sky-500/20 bg-zinc-950/60 backdrop-blur">
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">
                  {activePreviewReport.name} — Data Preview
                </h2>
                <p className="text-[11px] text-zinc-500 mt-0.5">{activePreviewReport.csvPreview}</p>
              </div>
              <button
                onClick={() => setActivePreviewId(null)}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-all"
              >
                Close ✕
              </button>
            </div>
            <div className="px-5 py-4">
              <StockTable csvFile={activePreviewReport.csvPreview} />
            </div>
          </div>
        )}

        {/* ── How to Use ─────────────────────────────────────────────────── */}
        <div className="mt-10 rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-5">
          <h2 className="text-sm font-semibold text-zinc-300 mb-3">How to use</h2>
          <div className="grid sm:grid-cols-2 gap-4 text-xs text-zinc-500 leading-relaxed">
            <div>
              <p className="text-zinc-300 font-medium mb-1">Running a report</p>
              <p>Click <strong className="text-zinc-400">Run</strong> to execute the Python analysis script in the background. The script reads from <code className="text-zinc-400 bg-zinc-900 px-1 rounded">Daily_Historical_Data_Fresh/</code> and writes the output to <code className="text-zinc-400 bg-zinc-900 px-1 rounded">reports/</code> or <code className="text-zinc-400 bg-zinc-900 px-1 rounded">portfolio/</code>. Estimated run time is shown on each card.</p>
            </div>
            <div>
              <p className="text-zinc-300 font-medium mb-1">Data freshness</p>
              <p>All reports use the historical CSV data synced via <strong className="text-zinc-400">Sync Data</strong> on the RS Scanner page. Run a sync first to ensure the latest market data is loaded, then regenerate reports.</p>
            </div>
            <div>
              <p className="text-zinc-300 font-medium mb-1">Download formats</p>
              <p><strong className="text-zinc-400">XLSX</strong> files open in Excel with conditional formatting, charts, and multiple sheets. <strong className="text-zinc-400">CSV</strong> files are raw data suitable for import into any tool. Use <strong className="text-zinc-400">Preview</strong> to explore CSV data inline.</p>
            </div>
            <div>
              <p className="text-zinc-300 font-medium mb-1">Portfolio reports</p>
              <p>Portfolio Risk and SIP Plan reports fetch live holdings from Dhan via the authenticated session. Ensure <code className="text-zinc-400 bg-zinc-900 px-1 rounded">login.py</code> has been run to refresh the access token before running these.</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn, execSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');

type Category = 'analysis' | 'screener' | 'portfolio' | 'tools';

type ReportDef = {
  id: string;
  name: string;
  description: string;
  category: Category;
  script: string;
  primaryFile: string;
  allFiles: string[];
  csvPreview?: string;
  estimatedMinutes: number;
};

const REPORT_DEFS: ReportDef[] = [
  {
    id: 'stock_analysis_v8',
    name: 'Nifty 500 Stock Analysis',
    description: 'Price returns, RSI (14), 50/200 DMA, 52W high/low, and volume across all Nifty 500 stocks',
    category: 'analysis',
    script: 'scripts/analysis/nifty500_stock_analysis_report.py',
    primaryFile: 'reports/nifty500_stock_analysis_report_v8.xlsx',
    allFiles: ['reports/nifty500_stock_analysis_report_v8.xlsx', 'reports/nifty500_stock_analysis_report_v8.csv'],
    csvPreview: 'reports/nifty500_stock_analysis_report_v8.csv',
    estimatedMinutes: 1,
  },
  {
    id: 'nifty50_analysis',
    name: 'Nifty 50 Stock Analysis',
    description: 'Same as Nifty 500 analysis but scoped to the 50 index constituents only',
    category: 'analysis',
    script: 'scripts/analysis/nifty50_stock_analysis_report.py',
    primaryFile: 'reports/nifty50_stock_analysis_report_v8.xlsx',
    allFiles: ['reports/nifty50_stock_analysis_report_v8.xlsx', 'reports/nifty50_stock_analysis_report_v8.csv'],
    csvPreview: 'reports/nifty50_stock_analysis_report_v8.csv',
    estimatedMinutes: 1,
  },
  {
    id: 'nifty500_returns',
    name: 'Nifty 500 Returns Report',
    description: 'Daily, weekly, monthly, YTD, and yearly returns with 52W high/low using calendar-day lookbacks',
    category: 'analysis',
    script: 'scripts/analysis/generate_nifty500_report.py',
    primaryFile: 'reports/Nifty500_Report_v2.csv',
    allFiles: ['reports/Nifty500_Report_v2.csv'],
    csvPreview: 'reports/Nifty500_Report_v2.csv',
    estimatedMinutes: 1,
  },
  {
    id: 'breakout_screener',
    name: 'Breakout & Momentum Screener',
    description: 'Volume-backed breakouts, Bollinger Band squeezes, dual momentum rankings, and pullback watchlist',
    category: 'screener',
    script: 'scripts/analysis/breakout_momentum_screener.py',
    primaryFile: 'reports/breakout_momentum_screener.xlsx',
    allFiles: ['reports/breakout_momentum_screener.xlsx'],
    estimatedMinutes: 2,
  },
  {
    id: 'market_regime',
    name: 'Market Regime & Breadth',
    description: 'EMA breadth indicators, sector rotation heatmap, ADX/choppiness per stock, 60-day regime history',
    category: 'screener',
    script: 'scripts/analysis/generate_market_regime_report.py',
    primaryFile: 'reports/market_regime_report.xlsx',
    allFiles: ['reports/market_regime_report.xlsx'],
    estimatedMinutes: 3,
  },
  {
    id: 'portfolio_risk',
    name: 'Portfolio Risk Report',
    description: 'Beta, VaR (95%), correlation matrix, Sharpe/Sortino/Treynor ratios, and marginal contribution to risk',
    category: 'portfolio',
    script: 'scripts/analysis/portfolio_risk_screener.py',
    primaryFile: 'portfolio/portfolio_risk_report.xlsx',
    allFiles: ['portfolio/portfolio_risk_report.xlsx'],
    estimatedMinutes: 3,
  },
  {
    id: 'portfolio_sip',
    name: 'Portfolio & SIP Plan',
    description: 'Holdings P&L, lump-sum investment plan, and daily SIP deployment schedule (â‚¹8,000/day)',
    category: 'portfolio',
    script: 'scripts/analysis/generate_portfolio_report.py',
    primaryFile: '',
    allFiles: [],
    estimatedMinutes: 1,
  },
  {
    id: 'portfolio_value_history',
    name: 'Portfolio Value History (Trade-Accurate)',
    description: 'Reconstructs historical portfolio value from Apr 1 using your actual buy/sell trade history, not just today\'s holdings',
    category: 'portfolio',
    script: 'scripts/tools/build_portfolio_value_history.py',
    primaryFile: 'debug/portfolio_value_history_reconstructed.json',
    allFiles: ['debug/portfolio_value_history_reconstructed.json'],
    estimatedMinutes: 2,
  },
  {
    id: 'portfolio_trade_pnl',
    name: 'Trade P&L by Segment (Equity/F&O/Commodity)',
    description: 'FIFO-matched realized P&L, charges, and trade log — Equity over ~2 years for accurate cost basis, F&O/Commodity since Apr 1',
    category: 'portfolio',
    script: 'scripts/tools/get_trade_pnl_by_segment.py',
    primaryFile: 'debug/portfolio_trade_history.json',
    allFiles: ['debug/portfolio_trade_history.json'],
    estimatedMinutes: 10,
  },
  {
    id: 'nifty_heatmap',
    name: 'Nifty Daily Returns Heatmap',
    description: 'Calendar heatmap of daily percentage changes for Nifty 50 over the past 5 years',
    category: 'tools',
    script: 'scripts/analysis/generate_nifty_heatmap.py',
    primaryFile: 'reports/nifty_daily_returns_heatmap.xlsx',
    allFiles: ['reports/nifty_daily_returns_heatmap.xlsx'],
    estimatedMinutes: 1,
  },
  {
    id: 'nifty_distribution',
    name: 'Nifty Distribution Analysis',
    description: 'Statistical distribution of 5Y daily returns: mean, std dev, skewness, kurtosis, and normal distribution chart',
    category: 'tools',
    script: 'scripts/analysis/nifty_distribution_analysis.py',
    primaryFile: 'reports/nifty_distribution_report.md',
    allFiles: ['reports/nifty_distribution_report.md', 'reports/nifty_normal_distribution.png'],
    estimatedMinutes: 1,
  },
];

function getFileInfo(relPath: string) {
  if (!relPath) return null;
  const absPath = path.join(PROJECT_ROOT, relPath);
  if (!fs.existsSync(absPath)) return null;
  const stat = fs.statSync(absPath);
  return {
    path: relPath,
    name: path.basename(relPath),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function findLatestPortfolioReport() {
  const dir = path.join(PROJECT_ROOT, 'portfolio');
  if (!fs.existsSync(dir)) return '';
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('Portfolio_Report_') && f.endsWith('.xlsx'))
    .sort()
    .reverse();
  return files.length > 0 ? `portfolio/${files[0]}` : '';
}

function isPidRunning(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      return out.includes(pid.toString());
    }
    execSync(`ps -p ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const RUN_STATUS_DIR = path.join(PROJECT_ROOT, 'debug');
function runStatusFile(scriptId: string) {
  return path.join(RUN_STATUS_DIR, `report_run_${scriptId}.json`);
}

function readRunStatus(scriptId: string) {
  const file = runStatusFile(scriptId);
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export async function GET() {
  const reports = REPORT_DEFS.map(def => {
    let primaryFile = def.primaryFile;
    let allFiles = def.allFiles;

    if (def.id === 'portfolio_sip') {
      primaryFile = findLatestPortfolioReport();
      allFiles = primaryFile ? [primaryFile] : [];
    }

    // Check if currently running
    const runStatus = readRunStatus(def.id);
    let running = false;
    if (runStatus && !runStatus.done && runStatus.pid) {
      running = isPidRunning(runStatus.pid);
      if (!running) {
        runStatus.done = true;
        try { fs.writeFileSync(runStatusFile(def.id), JSON.stringify(runStatus)); } catch { /* ignore */ }
      }
    }

    return {
      id: def.id,
      name: def.name,
      description: def.description,
      category: def.category,
      estimatedMinutes: def.estimatedMinutes,
      csvPreview: def.csvPreview || null,
      primaryFile: getFileInfo(primaryFile),
      files: allFiles.map(f => getFileInfo(f)).filter(Boolean),
      running,
      runError: runStatus?.error || null,
    };
  });

  return NextResponse.json({ success: true, reports });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { scriptId } = body;

  if (!scriptId) {
    return NextResponse.json({ error: 'scriptId required' }, { status: 400 });
  }

  const def = REPORT_DEFS.find(d => d.id === scriptId);
  if (!def) {
    return NextResponse.json({ error: 'Unknown script' }, { status: 404 });
  }

  // Check if already running
  const existing = readRunStatus(scriptId);
  if (existing && !existing.done && existing.pid && isPidRunning(existing.pid)) {
    return NextResponse.json({ error: 'Script already running', pid: existing.pid }, { status: 409 });
  }

  const scriptPath = path.join(PROJECT_ROOT, def.script);
  if (!fs.existsSync(scriptPath)) {
    return NextResponse.json({ error: `Script not found: ${def.script}` }, { status: 404 });
  }

  if (!fs.existsSync(RUN_STATUS_DIR)) fs.mkdirSync(RUN_STATUS_DIR, { recursive: true });

  const child = spawn(PYTHON_EXE, [scriptPath], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  child.unref();

  const status = { scriptId, pid: child.pid, started: new Date().toISOString(), done: false, error: null };
  try { fs.writeFileSync(runStatusFile(scriptId), JSON.stringify(status)); } catch { /* ignore */ }

  return NextResponse.json({ started: true, pid: child.pid, scriptId });
}

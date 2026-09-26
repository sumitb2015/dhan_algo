import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const BACKTESTS_OPTIONS_DIR = path.join(DEBUG_DIR, 'backtests', 'options');

export interface BacktestMetadata {
  id: string;
  name: string;
  timestamp: string;
  strategy_type?: string;
  start_date?: string;
  end_date?: string;
  trades?: number;
  win_rate?: number;
  total_pnl?: number;
  max_drawdown?: number;
  has_tearsheet?: boolean;
  has_trades_csv?: boolean;
  has_scans_summary?: boolean;
  tags?: string[];
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const file = searchParams.get('file');

    if (!fs.existsSync(BACKTESTS_OPTIONS_DIR)) {
      return NextResponse.json({ backtests: [] });
    }

    // ── Single Backtest Request ──
    if (id) {
      // Prevent directory traversal
      const safeId = path.basename(id);
      const targetDir = path.join(BACKTESTS_OPTIONS_DIR, safeId);

      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return NextResponse.json({ error: `Backtest '${safeId}' not found` }, { status: 404 });
      }

      // Serve Tearsheet HTML directly
      if (file === 'tearsheet') {
        const tsPath = path.join(targetDir, 'tearsheet.html');
        if (!fs.existsSync(tsPath)) {
          return new NextResponse('Tearsheet not found for this backtest', { status: 404 });
        }
        const html = fs.readFileSync(tsPath, 'utf-8');
        return new NextResponse(html, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
          },
        });
      }

      // Serve Trades CSV directly
      if (file === 'csv') {
        const csvPath = path.join(targetDir, 'trades.csv');
        if (!fs.existsSync(csvPath)) {
          return new NextResponse('Trades CSV not found for this backtest', { status: 404 });
        }
        const csv = fs.readFileSync(csvPath, 'utf-8');
        return new NextResponse(csv, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${safeId}_trades.csv"`,
          },
        });
      }

      // Serve Scans Summary JSON directly
      if (file === 'scans') {
        const scansPath = path.join(targetDir, 'scans_summary.json');
        if (!fs.existsSync(scansPath)) {
          return new NextResponse('Scans summary not found for this backtest', { status: 404 });
        }
        const scans = JSON.parse(fs.readFileSync(scansPath, 'utf-8'));
        return NextResponse.json(scans);
      }

      // Return metadata + full result.json
      let metadata: BacktestMetadata | null = null;
      const metaPath = path.join(targetDir, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        try {
          metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        } catch { /* ignore */ }
      }

      const resPath = path.join(targetDir, 'result.json');
      let result = null;
      if (fs.existsSync(resPath)) {
        try {
          result = JSON.parse(fs.readFileSync(resPath, 'utf-8'));
        } catch (e) {
          return NextResponse.json({ error: `Failed to parse result.json: ${e}` }, { status: 500 });
        }
      }

      const hasTearsheet = fs.existsSync(path.join(targetDir, 'tearsheet.html'));
      const hasTradesCsv = fs.existsSync(path.join(targetDir, 'trades.csv'));
      const hasScansSummary = fs.existsSync(path.join(targetDir, 'scans_summary.json'));

      if (!metadata && result) {
        const s = result.summary ?? {};
        const p = result.params ?? {};
        metadata = {
          id: safeId,
          name: p.strategy_name ?? safeId,
          timestamp: new Date().toISOString(),
          strategy_type: p.strategy_type ?? 'intraday',
          start_date: p.start_date,
          end_date: p.end_date,
          trades: s.traded_cycles ?? s.total_cycles,
          win_rate: s.win_rate,
          total_pnl: s.total_pnl,
          max_drawdown: s.max_drawdown,
          has_tearsheet: hasTearsheet,
          has_trades_csv: hasTradesCsv,
          has_scans_summary: hasScansSummary,
        };
      } else if (metadata) {
        metadata.has_tearsheet = hasTearsheet;
        metadata.has_trades_csv = hasTradesCsv;
        metadata.has_scans_summary = hasScansSummary;
      }

      return NextResponse.json({
        metadata,
        result,
      });
    }

    // ── List All Backtests ──
    const entries = fs.readdirSync(BACKTESTS_OPTIONS_DIR, { withFileTypes: true });
    const backtests: BacktestMetadata[] = [];

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dirPath = path.join(BACKTESTS_OPTIONS_DIR, ent.name);
      const metaPath = path.join(dirPath, 'metadata.json');
      const resPath = path.join(dirPath, 'result.json');
      const hasTearsheet = fs.existsSync(path.join(dirPath, 'tearsheet.html'));
      const hasTradesCsv = fs.existsSync(path.join(dirPath, 'trades.csv'));
      const hasScansSummary = fs.existsSync(path.join(dirPath, 'scans_summary.json'));

      if (fs.existsSync(metaPath)) {
        try {
          const meta: BacktestMetadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          meta.id = meta.id || ent.name;
          meta.has_tearsheet = hasTearsheet;
          meta.has_trades_csv = hasTradesCsv;
          meta.has_scans_summary = hasScansSummary;
          backtests.push(meta);
          continue;
        } catch { /* fallback to result.json */ }
      }

      if (fs.existsSync(resPath)) {
        try {
          const res = JSON.parse(fs.readFileSync(resPath, 'utf-8'));
          const s = res.summary ?? {};
          const p = res.params ?? {};
          backtests.push({
            id: ent.name,
            name: p.strategy_name ?? ent.name,
            timestamp: new Date().toISOString(),
            strategy_type: p.strategy_type ?? 'intraday',
            start_date: p.start_date,
            end_date: p.end_date,
            trades: s.traded_cycles ?? s.total_cycles ?? 0,
            win_rate: s.win_rate ?? 0,
            total_pnl: s.total_pnl ?? 0,
            max_drawdown: s.max_drawdown ?? 0,
            has_tearsheet: hasTearsheet,
            has_trades_csv: hasTradesCsv,
            has_scans_summary: hasScansSummary,
          });
        } catch { /* skip unparseable */ }
      }
    }

    // Sort newest timestamp first
    backtests.sort((a, b) => {
      const timeA = new Date(a.timestamp || 0).getTime();
      const timeB = new Date(b.timestamp || 0).getTime();
      return timeB - timeA;
    });

    return NextResponse.json({ backtests });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to fetch backtest history: ${msg}` }, { status: 500 });
  }
}

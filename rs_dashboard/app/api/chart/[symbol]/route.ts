import { NextRequest, NextResponse } from 'next/server';
import { readStockCSV, readNifty50Index, readNifty500Index, readNifty500List } from '@/lib/dataLoader';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { alignByDate, computeRSLine, ChartPoint } from '@/lib/rs';

const PERIODS: Record<string, number> = {
  '1w': 5,
  '1m': 21,
  '3m': 63,
  '6m': 126,
  '1y': 252,
  '2y': 504,
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ symbol: string }> }
) {
  const { symbol } = await params;
  const { searchParams } = new URL(request.url);
  const indexType = (searchParams.get('index') ?? 'nifty50') as 'nifty50' | 'nifty500';
  const periodKey = searchParams.get('period') ?? '1y';
  const period = PERIODS[periodKey] ?? 252;
  const lookbackStr = searchParams.get('lookback') ?? '252';
  let lookback = parseInt(lookbackStr, 10);
  if (isNaN(lookback) || ![50, 100, 252].includes(lookback)) {
    lookback = 252;
  }

  if (!symbol) {
    return NextResponse.json({ success: false, error: 'No symbol provided' }, { status: 400 });
  }

  try {
    // Load stock data
    const stockRows = readStockCSV(symbol);
    if (stockRows.length === 0) {
      return NextResponse.json({ success: false, error: `No data for symbol: ${symbol}` }, { status: 404 });
    }

    // Load benchmark index
    const benchmarkRows =
      indexType === 'nifty50'
        ? readNifty50Index()
        : await readNifty500Index(readNifty500List());

    if (benchmarkRows.length === 0) {
      return NextResponse.json({ success: false, error: 'Benchmark index data unavailable' }, { status: 503 });
    }

    // Align and compute RS line
    const aligned = alignByDate(stockRows, benchmarkRows);
    const chartData: ChartPoint[] = computeRSLine(aligned, period, lookback);

    if (chartData.length === 0) {
      return NextResponse.json({ success: false, error: 'Insufficient aligned data' }, { status: 404 });
    }

    // Summary stats
    const first = chartData[0];
    const last = chartData[chartData.length - 1];
    const currentRS = last.rsLine;
    const priceChange = first.stockClose > 0
      ? ((last.stockClose - first.stockClose) / first.stockClose) * 100
      : 0;

    return NextResponse.json({
      success: true,
      symbol,
      period: periodKey,
      indexType,
      currentRS: +currentRS.toFixed(2),
      latestClose: last.stockClose,
      latestDate: last.date,
      priceChangePct: +priceChange.toFixed(2),
      data: chartData.map((p) => ({
        date: p.date,
        stockClose: +p.stockClose.toFixed(2),
        indexClose: +p.indexClose.toFixed(2),
        rsLine: +p.rsLine.toFixed(3),
      })),
    });
  } catch (err) {
    console.error(`[/api/chart/${symbol}] Error:`, err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

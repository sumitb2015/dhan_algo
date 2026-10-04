import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT, dedupe } from '@/lib/pyExec';
import { dhanGet, dhanPost } from '@/lib/dhanToken';
import { findEquity, findEquityById } from '@/lib/equityMaster';
import { pacedQuoteCall } from '@/lib/dhanQuotePacer';
import { fetchHoldingsLive, sellableQty } from '@/lib/dhanEquityPortfolio';

const WATCHLIST_FILE = path.join(PROJECT_ROOT, 'debug', 'equity_watchlist.json');

interface ForeverOrderRow {
  orderId: string;
  orderFlag: string;
  transactionType: string;
  quantity: number;
  price: number;
  triggerPrice: number;
  status: string;
  legName: string | null;
  createTime: string;
  updateTime: string;
}

interface WatchlistRow {
  symbol: string;
  name: string;
  tick: number;
  ltp: number;
  prevClose: number;
  dayChangePct: number;
  dayChangeRs: number;
  open: number;
  high: number;
  low: number;
  portfolioQty: number;
  avgCostPrice: number;
  unrealizedPnl: number;
  foreverOrders: ForeverOrderRow[];
}

function readWatchlist(): string[] {
  try {
    if (!fs.existsSync(WATCHLIST_FILE)) return [];
    const raw = fs.readFileSync(WATCHLIST_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeWatchlist(symbols: string[]) {
  const debugDir = path.join(PROJECT_ROOT, 'debug');
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(symbols, null, 2), 'utf-8');
}

// Persistent in-memory cache for quotes so quotes are never blanked to 0 if quote lane is busy
const lastKnownQuotes = new Map<string, { last_price: number; open: number; high: number; low: number; close: number }>();

function readTodayQuotesFallback(): Record<string, { open?: number; high?: number; low?: number; close?: number }> {
  try {
    const todayQuotesPath = path.join(PROJECT_ROOT, 'debug', 'today_quotes.json');
    if (fs.existsSync(todayQuotesPath)) {
      return JSON.parse(fs.readFileSync(todayQuotesPath, 'utf8'));
    }
  } catch {}
  return {};
}

// Dhan's ohlc.close flips to *today's* close at 15:30 (and stays that way all weekend), so
// close === ltp and every row reads 0.00%. Recover the true previous close from the daily
// CSV: if its last row is the session ltp belongs to, the previous close is the row before it.
function prevCloseFromCsv(sym: string, ltp: number): number {
  try {
    const f = path.join(PROJECT_ROOT, 'Daily_Historical_Data_Fresh', `${sym}_Daily_2Y.csv`);
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    const close = (l?: string) => Number(l?.split(',')[4]);
    const last = close(lines[lines.length - 1]);
    const prev = Math.abs(last - ltp) < 0.005 ? close(lines[lines.length - 2]) : last;
    return prev > 0 ? prev : 0;
  } catch {
    return 0;
  }
}

const TERMINAL_ORDER_STATUSES = new Set(['CANCELLED', 'EXPIRED', 'TRADED', 'REJECTED']);

export async function GET() {
  try {
    const resData = await dedupe('equity-watchlist-list', async () => {
      // Holdings/funds don't depend on the symbol list, so start them while we read orders.
      const holdingsP = fetchHoldingsLive().catch((err) => {
        console.warn('[equity-watchlist] holdings error:', (err as Error).message);
        return [];
      });
      const fundsP = dhanGet('/fundlimit').catch(() => null);

      // Forever orders first: any symbol with a resting order must be on the watchlist, otherwise
      // the page hides a live order (and its committed cash) from the user.
      const foreverOrdersRaw = await dhanGet('/forever/orders').catch((err) => {
        console.warn('[equity-watchlist] forever/orders error:', (err as Error).message);
        return [];
      });

      let symbols = readWatchlist();
      const orderSymbols = new Set<string>();
      for (const o of Array.isArray(foreverOrdersRaw) ? (foreverOrdersRaw as Record<string, unknown>[]) : []) {
        if (TERMINAL_ORDER_STATUSES.has(String(o.orderStatus || '').toUpperCase())) continue;
        const sym = String(o.tradingSymbol || '').replace(/-EQ$/, '').toUpperCase()
          || findEquityById(String(o.securityId))?.symbol
          || '';
        if (sym) orderSymbols.add(sym);
      }
      const missing = [...orderSymbols].filter((sym) => !symbols.includes(sym));
      if (missing.length > 0) {
        // Re-read right before writing so a concurrent add/remove isn't overwritten.
        symbols = [...new Set([...readWatchlist(), ...missing])];
        writeWatchlist(symbols);
        console.log('[equity-watchlist] auto-added symbols with active GTT orders:', missing.join(','));
      }

      if (symbols.length === 0) {
        return { rows: [], availableFunds: null, asOf: new Date().toISOString() };
      }

      const secMap = new Map();
      const secIds: number[] = [];
      for (const sym of symbols) {
        const eq = findEquity(sym);
        if (eq) {
          secMap.set(sym, eq);
          secIds.push(Number(eq.securityId));
        }
      }

      const [ohlcRes, holdingsRaw, fundsRaw] = await Promise.all([
        secIds.length > 0
          ? pacedQuoteCall(() => dhanPost('/marketfeed/ohlc', { NSE_EQ: secIds })).catch((err) => {
              console.warn('[equity-watchlist] marketfeed/ohlc warning:', (err as Error).message);
              return null;
            })
          : null,
        holdingsP,
        fundsP,
      ]);

      const ohlcData = ((ohlcRes as Record<string, unknown>)?.data as Record<string, unknown>)?.NSE_EQ as
        | Record<string, { last_price?: number; ohlc?: { open?: number; high?: number; low?: number; close?: number } }>
        | undefined
        || {};

      // Update in-memory quote cache
      for (const [secId, quote] of Object.entries(ohlcData)) {
        if (quote && (Number(quote.last_price) > 0 || Number(quote.ohlc?.close) > 0)) {
          lastKnownQuotes.set(secId, {
            last_price: Number(quote.last_price || 0),
            open: Number(quote.ohlc?.open || 0),
            high: Number(quote.ohlc?.high || 0),
            low: Number(quote.ohlc?.low || 0),
            close: Number(quote.ohlc?.close || 0),
          });
        }
      }

      const todayQuotes = readTodayQuotesFallback();
      const foreverList = Array.isArray(foreverOrdersRaw) ? foreverOrdersRaw : [];
      const holdingsList = Array.isArray(holdingsRaw) ? holdingsRaw : [];
      const f = fundsRaw as Record<string, unknown> | null;
      const availableFunds = f ? Number(f.availabelBalance ?? f.availableBalance ?? NaN) : null;

      const rows: WatchlistRow[] = symbols.map((sym) => {
        const eq = secMap.get(sym);
        const liveQ = eq && ohlcData[eq.securityId] ? ohlcData[eq.securityId] : undefined;
        const cachedQ = eq ? lastKnownQuotes.get(eq.securityId) : undefined;
        const fileQ = todayQuotes[sym] || todayQuotes[sym.toUpperCase()];

        const ltp = Number(liveQ?.last_price || cachedQ?.last_price || fileQ?.close || 0);
        let prevClose = Number(liveQ?.ohlc?.close || cachedQ?.close || 0);
        if (ltp > 0 && (prevClose <= 0 || Math.abs(prevClose - ltp) < 0.005)) {
          prevClose = prevCloseFromCsv(sym, ltp) || prevClose;
        }
        const dayChangeRs = prevClose > 0 && ltp > 0 ? ltp - prevClose : 0;
        const dayChangePct = prevClose > 0 && ltp > 0 ? (dayChangeRs / prevClose) * 100 : 0;
        const open = Number(liveQ?.ohlc?.open || cachedQ?.open || fileQ?.open || 0);
        const high = Number(liveQ?.ohlc?.high || cachedQ?.high || fileQ?.high || 0);
        const low = Number(liveQ?.ohlc?.low || cachedQ?.low || fileQ?.low || 0);

        const sellable = eq ? sellableQty(holdingsList, eq.securityId) : { totalQty: 0, availableQty: 0, avgCost: 0 };
        const pnl = sellable.totalQty > 0 && sellable.avgCost > 0 && ltp > 0
          ? (ltp - sellable.avgCost) * sellable.totalQty
          : 0;

        const symOrders: ForeverOrderRow[] = foreverList
          .filter((o: Record<string, unknown>) => {
            const oSym = String(o.tradingSymbol || '').replace(/-EQ$/, '').toUpperCase();
            return oSym === sym || (eq && String(o.securityId) === String(eq.securityId));
          })
          .map((o: Record<string, unknown>) => ({
            orderId: String(o.orderId || ''),
            orderFlag: String(o.orderType || o.orderFlag || 'SINGLE'),
            transactionType: String(o.transactionType || ''),
            quantity: Number(o.quantity || 0),
            price: Number(o.price || 0),
            triggerPrice: Number(o.triggerPrice || 0),
            status: String(o.orderStatus || ''),
            legName: (o.legName as string) || null,
            createTime: String(o.createTime || ''),
            updateTime: String(o.updateTime || ''),
          }));

        return {
          symbol: sym,
          name: eq?.name || sym,
          tick: eq?.tick || 0.05,
          ltp,
          prevClose,
          dayChangePct: Number(dayChangePct.toFixed(2)),
          dayChangeRs: Number(dayChangeRs.toFixed(2)),
          open,
          high,
          low,
          portfolioQty: sellable.totalQty,
          avgCostPrice: sellable.avgCost,
          unrealizedPnl: Number(pnl.toFixed(2)),
          foreverOrders: symOrders,
        };
      });

      return {
        rows,
        availableFunds: Number.isFinite(availableFunds) ? availableFunds : null,
        asOf: new Date().toISOString(),
      };
    });

    return NextResponse.json({ success: true, ...resData });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const symbol = String(body?.symbol ?? '').trim().toUpperCase();
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'symbol is required' }, { status: 400 });
    }
    const symbols = readWatchlist();
    if (!symbols.includes(symbol)) {
      symbols.push(symbol);
      writeWatchlist(symbols);
    }
    return NextResponse.json({ success: true, symbols });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const symbol = String(body?.symbol ?? '').trim().toUpperCase();
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'symbol is required' }, { status: 400 });
    }
    // Removing a symbol hides its orders from this page but leaves them live on Dhan, so refuse
    // while any Forever order is still resting. Fail closed if Dhan can't be asked.
    const eq = findEquity(symbol);
    let forever: unknown;
    try {
      forever = await dhanGet('/forever/orders');
    } catch (e) {
      return NextResponse.json(
        { success: false, error: `Could not verify ${symbol} has no active orders (${(e as Error).message}). Try again.` },
        { status: 503 },
      );
    }
    const active = (Array.isArray(forever) ? forever : []).filter((o: Record<string, unknown>) => {
      const oSym = String(o.tradingSymbol || '').replace(/-EQ$/, '').toUpperCase();
      const mine = oSym === symbol || (eq && String(o.securityId) === String(eq.securityId));
      return mine && !['CANCELLED', 'EXPIRED', 'TRADED', 'REJECTED'].includes(String(o.orderStatus || '').toUpperCase());
    });
    if (active.length > 0) {
      return NextResponse.json(
        { success: false, error: `${symbol} has ${active.length} active order(s). Cancel them before removing it.` },
        { status: 409 },
      );
    }
    const symbols = readWatchlist().filter((s) => s !== symbol);
    writeWatchlist(symbols);
    return NextResponse.json({ success: true, symbols });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

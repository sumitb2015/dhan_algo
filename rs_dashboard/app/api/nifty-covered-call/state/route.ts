import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';

// Trade-log persistence for the Nifty Futures Covered Call desk. GET reads
// the whole log; POST appends one row. This is the terminal's own fill
// ledger (dhan-terminal-position-ownership) — never inferred from a raw
// broker position query.

const STATE_FILE = path.join(PROJECT_ROOT, 'debug', 'nifty_covered_call_trades.json');

export interface CoveredCallTradeRow {
  id: string;
  ts: number;
  leg: 'FUTURE' | 'CALL';
  action: 'ENTRY' | 'EXIT' | 'ROLL_CLOSE' | 'ROLL_OPEN';
  side: 'BUY' | 'SELL';
  strike?: number;
  expiry?: string;
  quantity: number;
  price: number;
  target?: number | null;
  stopLoss?: number | null;
  trailingSlFloor?: number | null;
  orderId?: string;
  securityId?: string;
  tradingSymbol?: string;
  realizedPnl?: number | null;
  note?: string;
  // For EXIT/ROLL_CLOSE call rows: the `id` of the ENTRY/ROLL_OPEN row that
  // opened the specific leg being closed. Lets reconstructLedger match the
  // exact leg instead of falling back to strike+side, which is ambiguous
  // when two call legs share the same strike and side.
  openLegId?: string;
}

interface StateFile {
  trades: CoveredCallTradeRow[];
}

function readState(): StateFile {
  try {
    if (!fs.existsSync(STATE_FILE)) return { trades: [] };
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StateFile>;
    return { trades: Array.isArray(parsed.trades) ? parsed.trades : [] };
  } catch {
    return { trades: [] };
  }
}

function writeState(state: StateFile): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// Read-modify-write on this JSON file needs a queue — two concurrent POSTs
// (two tabs logging a fill around the same time) would otherwise both read
// the same pre-write snapshot and the later write clobbers the earlier one.
// Same pattern as app/api/portfolio-weekly-target/route.ts (dhan-polling-guards).
let writeQueue: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => T): Promise<T> {
  const result = writeQueue.then(fn, fn); // run even if the previous cycle threw
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function GET() {
  const state = readState();
  return NextResponse.json({ success: true, trades: state.trades });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { trade?: Partial<CoveredCallTradeRow> };
  const trade = body.trade;

  if (!trade || !trade.leg || !trade.action || !trade.side || !trade.quantity || !trade.price) {
    return NextResponse.json({ success: false, error: 'Invalid trade row' }, { status: 400 });
  }

  const row: CoveredCallTradeRow = {
    id: trade.id || `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: trade.ts || Date.now(),
    leg: trade.leg,
    action: trade.action,
    side: trade.side,
    strike: trade.strike,
    expiry: trade.expiry,
    quantity: trade.quantity,
    price: trade.price,
    target: trade.target ?? null,
    stopLoss: trade.stopLoss ?? null,
    trailingSlFloor: trade.trailingSlFloor ?? null,
    orderId: trade.orderId,
    securityId: trade.securityId,
    tradingSymbol: trade.tradingSymbol,
    realizedPnl: trade.realizedPnl ?? null,
    note: trade.note,
    openLegId: trade.openLegId,
  };

  const trades = await withWriteLock(() => {
    const state = readState();
    state.trades.push(row);
    writeState(state);
    return state.trades;
  });

  return NextResponse.json({ success: true, trade: row, trades });
}

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import type { CallTrade, CallTradeAction } from '@/lib/coveredCallEngine';

// Short-call fill ledger for the NIFTYBEES Covered Call desk. GET reads the
// whole log; POST appends one row. This ledger — not the broker's net
// position — is what makes a NIFTY CE short "a covered call of this desk"
// (dhan-terminal-position-ownership): the same Dhan account carries CE shorts
// from other strategies.
//
// The pre-2026-10-01 futures + call desk wrote debug/nifty_covered_call_trades.json
// (lots, FUTURE rows). It is left untouched; this desk starts a fresh file in units.

const STATE_FILE = path.join(PROJECT_ROOT, 'debug', 'nifty_covered_call_ledger.json');
const ACTIONS: CallTradeAction[] = ['SELL_OPEN', 'BUY_CLOSE', 'ADOPT'];

interface StateFile {
  trades: CallTrade[];
}

function readState(): StateFile {
  try {
    if (!fs.existsSync(STATE_FILE)) return { trades: [] };
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<StateFile>;
    return { trades: Array.isArray(parsed.trades) ? parsed.trades : [] };
  } catch {
    return { trades: [] };
  }
}

function writeState(state: StateFile): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

// Serialise read-modify-write so two tabs logging fills together can't
// clobber each other (dhan-polling-guards).
let writeQueue: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => T): Promise<T> {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function GET() {
  return NextResponse.json({ success: true, trades: readState().trades });
}

export async function POST(req: NextRequest) {
  let body: { trade?: Partial<CallTrade> };
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  const t = body.trade;

  if (
    !t || !t.action || !ACTIONS.includes(t.action) ||
    !(Number(t.units) > 0) || !(Number(t.price) >= 0) || !(Number(t.strike) > 0) || !t.expiry || !t.securityId ||
    (t.action === 'BUY_CLOSE' && !t.openLegId)
  ) {
    return NextResponse.json({ success: false, error: 'Invalid trade row' }, { status: 400 });
  }

  const row: CallTrade = {
    id: `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    action: t.action,
    strike: Number(t.strike),
    expiry: String(t.expiry),
    units: Number(t.units),
    price: Number(t.price),
    securityId: String(t.securityId),
    tradingSymbol: t.tradingSymbol,
    orderId: t.orderId,
    openLegId: t.openLegId,
    realizedPnl: t.realizedPnl ?? null,
    note: t.note,
  };

  const trades = await withWriteLock(() => {
    const state = readState();
    state.trades.push(row);
    writeState(state);
    return state.trades;
  });

  return NextResponse.json({ success: true, trade: row, trades });
}

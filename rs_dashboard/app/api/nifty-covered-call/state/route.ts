import { NextRequest, NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';
import { normalizeTradeRow, matchOutsideTrades, type NormalizedTrade } from '@/lib/multiLegFocus';
import {
  reconstructCallLedger, reconcileCallsDown, deskOrderIds, usedTradeKeys,
  type CallTrade,
} from '@/lib/coveredCallEngine';
import { readLedger, mutateLedger, newId, sweepPending, liveBrokerCallShorts, deskBrokerOf, type DeskBroker } from '@/lib/coveredCallLedgerStore';
import { kotakGet, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakTrade } from '@/lib/kotakShape';

// Short-call ledger for the NIFTYBEES Covered Call desk. This ledger — not the
// broker's net position — is what makes a NIFTY CE short "a covered call of
// this desk" (dhan-terminal-position-ownership): the same Dhan account carries
// CE shorts from other strategies.
//
//   GET                       → { trades, pending }
//   GET ?candidates=<sid>     → today's SELL orders on that contract this desk
//                               doesn't own (for ADOPT), each with its own fill
//   POST {action:'sweep'}     → book late fills of pending orders
//   POST {action:'sync', legId, manualPrice?}
//        The broker shows less short than the leg: close the gap at the actual
//        outside BUY trade(s) from today's trade book (exact-qty match, not the
//        desk's own orders, not a fill already used). No match → 409
//        needsPrice; the user may then send a manualPrice (0 allowed, e.g. an
//        expired-worthless call), recorded as priceSource 'manual'.
//   POST {action:'adopt', securityId, orderId? | manualPrice + units}
//        Ledger-only: claim an existing broker short. With orderId the price is
//        THAT order's own trades, never the position's pooled sellAvg.
//
// Order fills (SELL_OPEN / BUY_CLOSE) are booked by the order route and the
// sweep only; there is no generic "append a row" endpoint.

type Row = Record<string, unknown>;

/** Every route below acts on ONE broker's ledger: `?broker=kotak` (GET) / `broker: 'kotak'` (POST); default Dhan. */
async function todayTrades(broker: DeskBroker): Promise<NormalizedTrade[]> {
  if (broker === 'kotak') {
    // Kotak trade rows carry no numeric id, so normalizeTradeRow keys them by trading symbol - the Kotak leg handle.
    return kotakRows(await kotakGet(KOTAK_PATHS.tradeBook)).map(shapeKotakTrade)
      .map((t) => normalizeTradeRow(t as unknown as Row)).filter((t): t is NormalizedTrade => t != null);
  }
  const raw = await dhanGet('/trades');
  if (!Array.isArray(raw)) throw new Error('Unexpected /trades payload');
  return (raw as Row[]).map(normalizeTradeRow).filter((t): t is NormalizedTrade => t != null);
}

const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status });

export async function GET(req: NextRequest) {
  const sid = req.nextUrl.searchParams.get('candidates');
  const broker = deskBrokerOf(req.nextUrl.searchParams.get('broker'));
  const state = readLedger(broker);
  if (!sid) return NextResponse.json({ success: true, trades: state.trades, pending: state.pending });

  try {
    const own = deskOrderIds(state.trades, state.pending);
    const used = usedTradeKeys(state.trades);
    const byOrder = new Map<string, { orderId: string; units: number; value: number; at: number }>();
    for (const t of await todayTrades(broker)) {
      if (t.ident !== sid || t.side !== 'S' || own.has(t.orderId) || used.has(t.key)) continue;
      const o = byOrder.get(t.orderId) ?? { orderId: t.orderId, units: 0, value: 0, at: t.at };
      o.units += t.qty;
      o.value += t.qty * t.price;
      o.at = Math.max(o.at, t.at);
      byOrder.set(t.orderId, o);
    }
    const candidates = [...byOrder.values()]
      .map((o) => ({ orderId: o.orderId, units: o.units, price: o.value / o.units, at: o.at }))
      .sort((a, b) => b.at - a.at);
    return NextResponse.json({ success: true, candidates });
  } catch (err) {
    return fail(`Trade book unavailable: ${(err as Error).message}`, 503);
  }
}

export async function POST(req: NextRequest) {
  let body: { action?: string; legId?: string; securityId?: string; orderId?: string; manualPrice?: number; units?: number; broker?: string };
  try { body = await req.json(); } catch { return fail('Invalid JSON'); }
  const broker = deskBrokerOf(body.broker);

  if (body.action === 'sweep') {
    await sweepPending(broker);
    const s = readLedger(broker);
    return NextResponse.json({ success: true, trades: s.trades, pending: s.pending });
  }

  if (body.action === 'sync') return sync(body.legId, body.manualPrice, broker);
  if (body.action === 'adopt') return adopt(body, broker);
  return fail('Unknown action');
}

type LedgerOutcome = { status: number; error?: string; needsPrice?: boolean; gap?: number; row?: CallTrade };

async function sync(legId: string | undefined, manualPrice: number | undefined, broker: DeskBroker) {
  if (!legId) return fail('legId required');
  const manual = manualPrice !== undefined && manualPrice !== null;
  if (manual && !(Number(manualPrice) >= 0)) return fail('manualPrice must be ≥ 0');

  let shorts: Awaited<ReturnType<typeof liveBrokerCallShorts>>;
  let trades: NormalizedTrade[] = [];
  try {
    shorts = await liveBrokerCallShorts(broker);
    if (!manual) trades = await todayTrades(broker);
  } catch (err) {
    return fail(`Broker unavailable, nothing synced: ${(err as Error).message}`, 503);
  }
  const brokerShortUnits = Object.fromEntries([...shorts].map(([sid, v]) => [sid, v.units]));

  // Gap and match are recomputed from the fresh file under the lock, so two
  // tabs pressing SYNC book the gap once.
  const out = await mutateLedger<LedgerOutcome>((state) => {
    const ledger = reconstructCallLedger(state.trades);
    const leg = reconcileCallsDown(ledger.open, brokerShortUnits, Date.now()).legs.find((l) => l.id === legId);
    if (!leg) return { result: { status: 404, error: 'Leg is not open in the ledger' }, write: false };
    const gap = leg.ledgerUnits - leg.units;
    if (gap <= 0) return { result: { status: 409, error: 'Broker still shows this leg short — nothing to sync' }, write: false };

    let price: number;
    let tradeKeys: string[] | undefined;
    if (manual) {
      price = Number(manualPrice);
    } else {
      const m = matchOutsideTrades(
        trades, leg.securityId, 'B', gap, Date.now(),
        deskOrderIds(state.trades, state.pending), usedTradeKeys(state.trades), leg.ts,
      );
      if (!m) {
        return {
          result: {
            status: 409, needsPrice: true, gap,
            error: `No outside BUY of exactly ${gap} units of ${leg.strike} CE in today's trade book (closed on an earlier day, expired, or split across other trades).`,
          },
          write: false,
        };
      }
      price = m.exitPrice;
      tradeKeys = m.keys;
    }
    const row: CallTrade = {
      id: newId('cc'), ts: Date.now(), action: 'BUY_CLOSE', strike: leg.strike, expiry: leg.expiry, units: gap, price,
      securityId: leg.securityId, tradingSymbol: leg.tradingSymbol, openLegId: leg.id,
      realizedPnl: (leg.entryPrice - price) * gap,
      priceSource: manual ? 'manual' : 'tradebook', tradeKeys,
      note: manual ? 'Closed outside desk — price entered manually' : 'Closed outside desk — priced from trade book',
    };
    state.trades.push(row);
    return { result: { status: 200, row }, write: true };
  }, broker);

  if (out.status !== 200) return fail(out.error!, out.status, out.needsPrice ? { needsPrice: true, gap: out.gap } : {});
  return NextResponse.json({ success: true, trade: out.row, trades: readLedger(broker).trades });
}

async function adopt(body: { securityId?: string; orderId?: string; manualPrice?: number; units?: number }, broker: DeskBroker) {
  const securityId = String(body.securityId ?? '');
  if (broker === 'kotak' ? !/^NIFTY[0-9A-Z]+CE$/.test(securityId) : !/^\d+$/.test(securityId)) return fail('Invalid contract');
  if (!body.orderId && !(Number(body.manualPrice) > 0 && Number(body.units) > 0)) {
    return fail('Adopt needs the orderId of the sell, or a manualPrice > 0 and units');
  }

  let shorts: Awaited<ReturnType<typeof liveBrokerCallShorts>>;
  let trades: NormalizedTrade[] = [];
  try {
    shorts = await liveBrokerCallShorts(broker);
    if (body.orderId) trades = await todayTrades(broker);
  } catch (err) {
    return fail(`Broker unavailable, nothing adopted: ${(err as Error).message}`, 503);
  }
  const contract = shorts.get(securityId);
  if (!contract) return fail('Broker shows no NIFTY CE short at this contract', 409);

  const out = await mutateLedger<LedgerOutcome>((state) => {
    const owned = reconstructCallLedger(state.trades).open
      .filter((o) => o.securityId === securityId).reduce((s, o) => s + o.units, 0);
    const inFlight = state.pending
      .filter((p) => p.side === 'SELL' && p.securityId === securityId).reduce((s, p) => s + p.units - p.bookedUnits, 0);
    const unowned = contract.units - owned - inFlight;
    if (unowned <= 0) return { result: { status: 409, error: 'Every unit short at this contract is already in this desk' }, write: false };

    let units: number;
    let price: number;
    let tradeKeys: string[] | undefined;
    if (body.orderId) {
      const orderId = String(body.orderId);
      if (deskOrderIds(state.trades, state.pending).has(orderId)) {
        return { result: { status: 409, error: `Order ${orderId} is already in this desk's ledger` }, write: false };
      }
      const used = usedTradeKeys(state.trades);
      const fills = trades.filter((t) => t.orderId === orderId && t.ident === securityId && t.side === 'S' && !used.has(t.key));
      const qty = fills.reduce((s, t) => s + t.qty, 0);
      if (!(qty > 0)) return { result: { status: 404, error: `No unclaimed SELL fills for order ${orderId} on this contract today` }, write: false };
      price = fills.reduce((s, t) => s + t.qty * t.price, 0) / qty;
      units = Math.min(qty, unowned);
      tradeKeys = fills.map((t) => t.key);
    } else {
      price = Number(body.manualPrice);
      units = Math.min(Math.floor(Number(body.units)), unowned);
    }
    const row: CallTrade = {
      id: newId('cc'), ts: Date.now(), action: 'ADOPT', strike: contract.strike, expiry: contract.expiry, units, price,
      securityId, tradingSymbol: contract.tradingSymbol, orderId: body.orderId ? String(body.orderId) : undefined,
      priceSource: body.orderId ? 'tradebook' : 'manual', tradeKeys,
      note: body.orderId ? `Adopted order ${body.orderId}` : 'Adopted — sell price entered manually',
    };
    state.trades.push(row);
    return { result: { status: 200, row }, write: true };
  }, broker);

  if (out.status !== 200) return fail(out.error!, out.status);
  return NextResponse.json({ success: true, trade: out.row, trades: readLedger(broker).trades });
}

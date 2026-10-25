import { NextRequest, NextResponse } from 'next/server';
import { placeDhanOrder } from '@/lib/dhanPlaceOrder';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { buildKotakOrderPayload } from '@/lib/kotakOrderPayload';
import { kotakDerivativeBySymbol } from '@/lib/kotakContracts';
import { kotakUnderlyingOf } from '@/lib/kotakPositionContracts';
import { placeZerodhaOrder } from '@/lib/zerodhaPlaceOrder';
import { cachedZerodhaContract, slicesFor } from '@/lib/zerodhaContracts';
import { resolveLotSize } from '@/lib/lotSize';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { brokerPositionRows, brokerSessionOk, updateLadderState, startPriceLadderLoop } from '@/lib/priceLadderServer';
import { zerodhaLadderParams, pushEvent, ev, type LadderBroker } from '@/lib/priceLadder';
import { planClose, isClosePct, CloseGuard } from '@/lib/priceLadderClose';

// Close all or part of a broker position from the Price Ladder's positions window. Real money, so the browser only names
// the position (broker + contract key + product) and a share; the side, quantity and segment come from the broker's own
// book read now, and the order is a MARKET order on the opposite side that can only reduce that position. Exits need no
// REAL arm (the same rule as the MTM guard). A ladder slice on the same contract is trimmed by the watcher's down-only
// reconcile once the book shows the change.

const NAME: Record<LadderBroker, string> = { dhan: 'Dhan', kotak: 'Kotak', zerodha: 'Zerodha' };
const bad = (error: string, status = 400) => NextResponse.json({ success: false, error }, { status });
const guard: CloseGuard = ((globalThis as { __priceLadderCloseGuard?: CloseGuard }).__priceLadderCloseGuard ??= new CloseGuard());

export async function POST(req: NextRequest): Promise<NextResponse> {
  startPriceLadderLoop();
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch { return bad('Invalid JSON'); }
  const broker = body.broker === 'dhan' || body.broker === 'kotak' || body.broker === 'zerodha' ? body.broker : null;
  const key = typeof body.key === 'string' ? body.key : '';
  const product = String(body.product ?? '').toUpperCase();
  if (!broker) return bad('broker must be dhan, kotak or zerodha');
  if (!key || !product) return bad('key and product are required');
  if (!isClosePct(body.pct)) return bad('pct must be 25, 50, 75 or 100');
  const pct = Number(body.pct);
  if (!brokerSessionOk(broker)) return bad(`${NAME[broker]} session is not logged in`, 403);

  const gkey = `${broker}|${key}|${product}`;
  if (!guard.tryStart(gkey, Date.now())) return bad('A close for this position was just sent — wait a few seconds for the broker book to update', 409);
  let sent = false;
  try {
    const rows = await brokerPositionRows(broker);
    if (!rows) return bad(`Could not read the ${NAME[broker]} positions — nothing was sent`, 502);
    const row = rows.find(r => r.key === key && r.product === product);
    if (!row || row.net === 0) return bad('That position is flat at the broker — refresh');

    const symbol = row.symbol;
    const mcx = row.exchange === 'MCX_COMM' || /^mcx/i.test(row.exchange) || row.exchange === 'MCX';
    // Kotak / Zerodha MCX quantity units are not confirmed against live fills (docs/PRICE_LADDER_GUIDE.md): not from here.
    if (mcx && broker !== 'dhan') return bad(`Closing ${NAME[broker]} MCX positions from here is not supported — use the broker`);

    let lotSize = row.lotSize;
    if (pct !== 100) {
      if (broker === 'dhan') {
        // Dhan MCX quantity is in lots (lot size 1); NSE / BSE F&O is in units.
        lotSize = mcx ? 1 : await resolveLotSize(symbol.split('-')[0]).catch(() => null);
      } else if (broker === 'zerodha') lotSize = cachedZerodhaContract(symbol)?.lotSize ?? null;
    }
    const plan = planClose(row.net, lotSize, pct);
    if (typeof plan === 'string') return bad(plan);
    const { side, qty } = plan;
    const what = `${NAME[broker]} ${symbol} ${product} ${pct}% — ${side} ${qty}`;

    let outcome: { status: 'placed'; orderId: string } | { status: 'rejected' | 'unknown'; error: string };
    sent = true;                       // from here an order may be out: start the cooldown whatever the answer
    if (broker === 'dhan') {
      if (!['NSE_FNO', 'BSE_FNO', 'MCX_COMM'].includes(row.exchange)) { sent = false; return bad(`Only F&O positions can be closed from here (${row.exchange || 'unknown segment'})`); }
      if (product !== 'INTRADAY' && product !== 'MARGIN') { sent = false; return bad(`Unsupported product ${product}`); }
      const r = await placeDhanOrder({ securityId: key, quantity: qty, side, exchangeSegment: row.exchange, productType: product });
      outcome = r.status === 'invalid' ? { status: 'rejected', error: r.error } : r;
    } else if (broker === 'zerodha') {
      if (product !== 'MIS' && product !== 'NRML') { sent = false; return bad(`Unsupported product ${product}`); }
      if (row.exchange !== 'NFO' && row.exchange !== 'BFO') { sent = false; return bad(`Only index F&O positions can be closed from here (${row.exchange})`); }
      // One order per close: an order Kite would need cut at the freeze quantity is refused, never sliced.
      if (slicesFor(symbol, qty).length > 1) { sent = false; return bad(`${qty} is above the exchange freeze quantity for one Zerodha order — close in parts`); }
      const params = zerodhaLadderParams(symbol, row.exchange, side, qty, product, { type: 'MARKET' }, cachedZerodhaContract(symbol));
      const r = await placeZerodhaOrder(params);
      outcome = r.status === 'placed' ? { status: 'placed', orderId: r.orderId } : r;
    } else {
      if (product !== 'MIS' && product !== 'NRML') { sent = false; return bad(`Unsupported product ${product}`); }
      if (row.exchange !== 'nse_fo' && row.exchange !== 'bse_fo') { sent = false; return bad(`Only index F&O positions can be closed from here (${row.exchange})`); }
      const underlying = kotakUnderlyingOf(symbol) ?? '';
      const built = buildKotakOrderPayload({ tradingsymbol: symbol, quantity: qty, side, exchange: row.exchange, product, orderType: 'MARKET' }, kotakDerivativeBySymbol(symbol, underlying));
      if ('error' in built) { sent = false; return bad(built.error); }
      const r = await placeKotakOrder(built.payload);
      outcome = r.status === 'placed' ? { status: 'placed', orderId: r.orderId } : r;
    }

    invalidateBrokerCache(broker);
    await updateLadderState(st => pushEvent(st, ev(outcome.status === 'placed' ? 'info' : 'error',
      `Positions window: close ${what} — ${outcome.status}${outcome.status === 'placed' ? ` (order ${outcome.orderId})` : `: ${outcome.error}`}`))).catch(() => undefined);
    if (outcome.status === 'placed') return NextResponse.json({ success: true, data: { orderId: outcome.orderId, side, qty, message: `Close sent: ${what}` } });
    if (outcome.status === 'unknown') return NextResponse.json({ success: false, unknown: true, error: outcome.error }, { status: 504 });
    return NextResponse.json({ success: false, error: outcome.error });
  } catch (err) {
    console.error('[price-ladder] close-position failed:', err);
    return bad(String((err as Error).message ?? err), 500);
  } finally {
    guard.finish(gkey, Date.now(), sent);
  }
}

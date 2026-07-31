import { NextResponse } from 'next/server';
import { kotakGet, kotakPost, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakPosition } from '@/lib/kotakShape';

export async function POST(): Promise<NextResponse> {
  const closed: string[] = [];
  const errors: string[] = [];

  try {
    const json = await kotakGet(KOTAK_PATHS.positions);
    // Net quantity is computed, not reported — shapeKotakPosition owns that
    // arithmetic so this route cannot drift from what the UI displays.
    const open = kotakRows(json).map(shapeKotakPosition).filter(p => p.netQty !== 0);

    for (const pos of open) {
      const qty = Math.abs(pos.netQty);
      const side = pos.netQty > 0 ? 'S' : 'B';
      try {
        await kotakPost(KOTAK_PATHS.placeOrder, {
          es: pos.exchange || 'nse_fo',
          pc: pos.productType || 'MIS',
          pr: '0',
          pt: 'MKT',
          qt: String(qty),
          rt: 'DAY',
          ts: pos.tradingSymbol,
          tt: side,
          am: 'NO',
          dq: '0',
          mp: '0',
          pf: 'N',
          tp: '0',
          os: 'NEOTRADEAPI',
        });
        closed.push(pos.tradingSymbol);
      } catch (err) {
        errors.push(`${pos.tradingSymbol}: ${String((err as Error).message ?? err)}`);
      }
    }

    return NextResponse.json({ success: errors.length === 0, closed, errors });
  } catch (err) {
    console.error('[scalper/kotak/exit-all] error:', err);
    return NextResponse.json({ success: false, closed, errors: [String((err as Error).message ?? err)] }, { status: 500 });
  }
}

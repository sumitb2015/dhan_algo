import { NextResponse } from 'next/server';
import { kiteGet, kitePost } from '@/lib/zerodhaToken';

export async function POST(): Promise<NextResponse> {
  const closed: string[] = [];
  const errors: string[] = [];

  try {
    const positions = await kiteGet('/portfolio/positions') as { net: any[] };
    const open = (positions.net ?? []).filter(p => Number(p.quantity) !== 0);

    for (const pos of open) {
      const qty = Math.abs(Number(pos.quantity));
      const side = Number(pos.quantity) > 0 ? 'SELL' : 'BUY';
      try {
        await kitePost('/orders/regular', {
          tradingsymbol: pos.tradingsymbol,
          exchange: pos.exchange ?? 'NFO',
          transaction_type: side,
          order_type: 'MARKET',
          quantity: qty,
          product: pos.product ?? 'MIS',
          validity: 'DAY',
          // Required for API market orders on options (-1 = automatic band).
          market_protection: -1,
        });
        closed.push(pos.tradingsymbol);
      } catch (err) {
        errors.push(`${pos.tradingsymbol}: ${String((err as Error).message ?? err)}`);
      }
    }

    return NextResponse.json({ success: errors.length === 0, closed, errors });
  } catch (err) {
    console.error('[scalper/zerodha/exit-all] error:', err);
    return NextResponse.json({ success: false, closed, errors: [String((err as Error).message ?? err)] }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { kotakGet, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { shapeKotakPosition, isKotakFnoPosition } from '@/lib/kotakShape';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';

/**
 * Square off Kotak positions. Default scope is F&O only (`nse_fo` / `bse_fo` / `mcx_fo` / `cde_fo`), the same as the Dhan
 * scalper terminals' `scope: 'fno'`: the terminals that call this (Focus Tool, Advanced Scalper) are F&O tools and must
 * not sell a cash-equity position bought today. `{ scope: 'all' }` opts into everything.
 * Shorts are bought back before longs are sold, so a hedge is never sold first.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const closed: string[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];
  const body = await req.json().catch(() => ({})) as { scope?: string };
  const all = body?.scope === 'all';

  try {
    const json = await kotakGet(KOTAK_PATHS.positions);
    // Net quantity is computed, not reported — shapeKotakPosition owns that
    // arithmetic so this route cannot drift from what the UI displays.
    const nonFlat = kotakRows(json).map(shapeKotakPosition).filter(p => p.netQty !== 0);
    const open = nonFlat
      .filter(p => {
        if (all || isKotakFnoPosition(p)) return true;
        skipped.push(p.tradingSymbol);
        return false;
      })
      .sort((a, b) => a.netQty - b.netQty);   // most-short first

    for (const pos of open) {
      const qty = Math.abs(pos.netQty);
      const side = pos.netQty > 0 ? 'S' : 'B';
      const r = await placeKotakOrder({
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
      if (r.status === 'placed') closed.push(pos.tradingSymbol);
      else errors.push(`${pos.tradingSymbol}: ${r.status === 'unknown' ? 'STATUS UNKNOWN (may have closed) - ' : ''}${r.error}`);
    }

    // Invalidate even on a partial failure — some legs can close while others
    // error out, and `closed` being non-empty still means positions moved.
    if (closed.length > 0) invalidateBrokerCache('kotak');
    return NextResponse.json({ success: errors.length === 0, closed, errors, skipped });
  } catch (err) {
    console.error('[scalper/kotak/exit-all] error:', err);
    return NextResponse.json({ success: false, closed, errors: [String((err as Error).message ?? err)], skipped }, { status: 500 });
  }
}

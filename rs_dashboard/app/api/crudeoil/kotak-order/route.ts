import { NextRequest, NextResponse } from 'next/server';
import { kotakPost, KOTAK_PATHS } from '@/lib/kotakToken';

/**
 * Multi-leg MARKET order placement on Kotak Neo for MCX crude options, used by
 * the Crude Oil options page when the broker selector is set to Kotak.
 *
 * Deliberately NOT reusing /api/scalper/kotak/exit-all or the single-leg
 * scalper order route:
 *
 *  - exit-all squares off EVERY open Kotak position, including NSE ones. This
 *    page's Exit All means "all crude legs", so it sends explicit per-leg
 *    orders instead.
 *  - Every symbol is checked against the crude pattern below before anything is
 *    sent. A bad strike->symbol lookup then fails loudly here rather than
 *    placing a real order in some other contract.
 *
 * Quantity is ABSOLUTE (barrels), not lots — Kotak's `qt` field is the raw
 * quantity, and one CRUDEOIL lot is 100 (CRUDEOILM 10). The caller resolves
 * lots -> quantity; this route only sanity-checks the result.
 */

/**
 * CRUDEOIL / CRUDEOILM contracts only — options (CRUDEOIL17AUG267300CE) and
 * futures (CRUDEOILM19AUG26FUT). Futures are included deliberately: the crude
 * position book shows them, so Exit All has to be able to close them. Nothing
 * outside these two underlyings can pass.
 */
const CRUDE_SYMBOL = /^CRUDEOILM?\d{2}[A-Z]{3}\d{2}(FUT|\d+(CE|PE))$/;

interface Leg {
  tradingsymbol: string;
  quantity: number;
  side: 'BUY' | 'SELL';
  product?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null) as { legs?: Leg[]; mode?: 'intraday' | 'positional' } | null;

  if (!body?.legs?.length) {
    return NextResponse.json({ success: false, error: 'legs array is required' }, { status: 400 });
  }

  const { legs, mode = 'intraday' } = body;
  const product = mode === 'positional' ? 'NRML' : 'MIS';

  // Validate every leg before touching the broker — a partially-placed basket
  // is far worse than a rejected one.
  const invalid: string[] = [];
  for (const leg of legs) {
    const sym = String(leg.tradingsymbol ?? '').toUpperCase().trim();
    if (!CRUDE_SYMBOL.test(sym)) {
      invalid.push(`"${leg.tradingsymbol}" is not a CRUDEOIL/CRUDEOILM option symbol`);
    }
    if (!Number.isInteger(Number(leg.quantity)) || Number(leg.quantity) <= 0) {
      invalid.push(`${sym}: invalid quantity=${leg.quantity}`);
    }
    if (leg.side !== 'BUY' && leg.side !== 'SELL') {
      invalid.push(`${sym}: invalid side=${leg.side}`);
    }
  }
  if (invalid.length) {
    return NextResponse.json(
      { success: false, error: `Cannot place order — invalid leg(s): ${invalid.join('; ')}` },
      { status: 400 },
    );
  }

  // Sequential, not Promise.all: Kotak rate-limits order placement, and a
  // rejected basket leg should not race the others.
  const results: { success: boolean; orderId?: string; error?: string; symbol: string }[] = [];
  for (const leg of legs) {
    const symbol = String(leg.tradingsymbol).toUpperCase().trim();
    try {
      const json = await kotakPost(KOTAK_PATHS.placeOrder, {
        es: 'mcx_fo',
        pc: product,
        pr: '0',
        pt: 'MKT',
        qt: String(Number(leg.quantity)),
        rt: 'DAY',
        ts: symbol,
        tt: leg.side === 'BUY' ? 'B' : 'S',
        am: 'NO',
        dq: '0',
        mp: '0',
        pf: 'N',
        tp: '0',
        os: 'NEOTRADEAPI',
      });
      const data = (typeof json.data === 'object' && json.data !== null ? json.data : {}) as Record<string, unknown>;
      const orderId = json.nOrdNo ?? data.nOrdNo;
      if (json.stat === 'Ok' && orderId) {
        results.push({ success: true, orderId: String(orderId), symbol });
      } else {
        results.push({ success: false, error: `Unexpected Kotak response: ${JSON.stringify(json)}`, symbol });
      }
    } catch (err) {
      results.push({ success: false, error: String((err as Error).message ?? err), symbol });
    }
  }

  const failures = results.filter(r => !r.success);
  if (failures.length) {
    return NextResponse.json({
      success: false,
      error: `Failed to place some orders: ${failures.map(f => `${f.symbol}: ${f.error}`).join(', ')}`,
      data: results,
    });
  }
  return NextResponse.json({ success: true, data: results });
}

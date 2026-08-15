import { NextResponse } from 'next/server';
import { resolveLotSize } from '@/lib/lotSize';

// Thin wrapper over lib/lotSize, which resolves through
// DhanHelper.get_lot_size(). See that module for why there is no literal default.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get('symbol') ?? 'NIFTY').toUpperCase();

  try {
    const lot = await resolveLotSize(symbol);
    return NextResponse.json({ symbol, lot_size: lot });
  } catch (err) {
    console.error('[/api/lotsize] error:', err);
    // Report the failure instead of substituting a number. A caller that sizes
    // an order off this must be able to tell "unknown" from a real lot size.
    return NextResponse.json(
      { symbol, lot_size: null, error: String((err as Error).message ?? err) },
      { status: 503 },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { fetchUnderlyingExpiries } from '@/lib/ultimateScannerDhan';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const underlying = searchParams.get('underlying');

    if (!underlying || !['NIFTY', 'SENSEX'].includes(underlying)) {
      return NextResponse.json({ success: false, error: 'underlying must be NIFTY or SENSEX' }, { status: 400 });
    }

    const expiries = await fetchUnderlyingExpiries(underlying);
    return NextResponse.json({ success: true, expiries });
  } catch (err) {
    console.error('[/api/ultimate-scanner/expiries GET]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

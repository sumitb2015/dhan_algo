import { NextResponse } from 'next/server';
import { isDhanTokenValid } from '@/lib/session';
import { isZerodhaTokenValid } from '@/lib/zerodhaToken';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    dhan: isDhanTokenValid(),
    zerodha: isZerodhaTokenValid(),
  });
}

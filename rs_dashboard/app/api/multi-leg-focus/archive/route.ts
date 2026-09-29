import { NextResponse } from 'next/server';
import { readArchive } from '@/lib/multiLegFocusStore';

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ success: true, data: readArchive() });
  } catch (err) {
    console.error('[/api/multi-leg-focus/archive GET]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

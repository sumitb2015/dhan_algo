import { NextResponse } from 'next/server';
import { getDhanHealth } from '@/lib/dhanHealthServer';

export async function GET() {
  try {
    return NextResponse.json(await getDhanHealth());
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

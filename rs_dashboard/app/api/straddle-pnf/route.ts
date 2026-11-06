import { NextRequest, NextResponse } from 'next/server';
import { loadPnfHistory } from '@/lib/pnfHistory';

// Read-only market-data route for the Point & Figure page (lib/pnfHistory.ts). No order code lives here.
export async function GET(request: NextRequest) {
  const r = await loadPnfHistory(new URL(request.url).searchParams);
  return NextResponse.json(r.body, { status: r.status });
}

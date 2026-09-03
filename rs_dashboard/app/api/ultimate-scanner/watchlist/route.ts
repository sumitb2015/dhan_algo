import { NextRequest, NextResponse } from 'next/server';
import {
  readWatchlist,
  addToWatchlist,
  updateWatchlistItem,
  deleteWatchlistItem,
} from '@/lib/ultimateScannerStore';
import type { ScannedStrategy, WatchlistItem } from '@/lib/ultimateScannerTypes';

export async function GET(): Promise<NextResponse> {
  try {
    const items = readWatchlist();
    return NextResponse.json({ success: true, data: items });
  } catch (err) {
    console.error('[/api/ultimate-scanner/watchlist GET]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json() as {
      candidate: ScannedStrategy;
      options?: Partial<Omit<WatchlistItem, keyof ScannedStrategy>>;
    };

    if (!body?.candidate) {
      return NextResponse.json({ success: false, error: 'candidate required' }, { status: 400 });
    }

    const items = addToWatchlist(body.candidate, body.options);
    return NextResponse.json({ success: true, data: items });
  } catch (err) {
    console.error('[/api/ultimate-scanner/watchlist POST]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json() as {
      id: string;
      patch: Partial<WatchlistItem>;
    };

    if (!body?.id || !body?.patch) {
      return NextResponse.json({ success: false, error: 'id and patch required' }, { status: 400 });
    }

    const items = updateWatchlistItem(body.id, body.patch);
    return NextResponse.json({ success: true, data: items });
  } catch (err) {
    console.error('[/api/ultimate-scanner/watchlist PATCH]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ success: false, error: 'id parameter required' }, { status: 400 });
    }

    const items = deleteWatchlistItem(id);
    return NextResponse.json({ success: true, data: items });
  } catch (err) {
    console.error('[/api/ultimate-scanner/watchlist DELETE]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

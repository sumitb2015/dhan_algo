import { NextRequest, NextResponse } from 'next/server';
import {
  readRsWatchlist,
  addToRsWatchlist,
  removeFromRsWatchlist,
  updateRsWatchlistItem,
  type RsWatchlistItem,
} from '@/lib/rsStrategyWatchlistStore';
import type { RsSignal } from '@/lib/rsStrategyCore';

export async function GET() {
  try {
    const items = readRsWatchlist();
    return NextResponse.json({ success: true, data: items });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[/api/rs-strategy/watchlist GET]', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    let itemsToAdd: RsWatchlistItem[] = [];

    if (Array.isArray(body?.items)) {
      itemsToAdd = body.items.map((it: Partial<RsWatchlistItem>) => ({
        symbol: String(it.symbol ?? '').trim().toUpperCase(),
        addedAt: it.addedAt || new Date().toISOString(),
        addedPrice: Number(it.addedPrice ?? 0),
        addedSignal: (it.addedSignal ?? 'WAIT') as RsSignal,
        addedRs: Number(it.addedRs ?? 0),
        notes: it.notes ?? '',
        highlighted: it.highlighted ?? true,
      })).filter((it: RsWatchlistItem) => it.symbol.length > 0);
    } else if (body?.symbol) {
      itemsToAdd = [{
        symbol: String(body.symbol).trim().toUpperCase(),
        addedAt: body.addedAt || new Date().toISOString(),
        addedPrice: Number(body.addedPrice ?? 0),
        addedSignal: (body.addedSignal ?? 'WAIT') as RsSignal,
        addedRs: Number(body.addedRs ?? 0),
        notes: body.notes ?? '',
        highlighted: body.highlighted ?? true,
      }];
    }

    if (itemsToAdd.length === 0) {
      return NextResponse.json({ success: false, error: 'At least one valid symbol is required' }, { status: 400 });
    }

    const updated = await addToRsWatchlist(itemsToAdd);
    return NextResponse.json({ success: true, data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[/api/rs-strategy/watchlist POST]', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const paramSymbol = url.searchParams.get('symbol');
    let symbolsToRemove: string[] = [];

    if (paramSymbol) {
      symbolsToRemove = [paramSymbol.trim().toUpperCase()];
    } else {
      const body = await req.json().catch(() => null);
      if (Array.isArray(body?.symbols)) {
        symbolsToRemove = body.symbols.map((s: unknown) => String(s).trim().toUpperCase());
      } else if (body?.symbol) {
        symbolsToRemove = [String(body.symbol).trim().toUpperCase()];
      }
    }

    symbolsToRemove = symbolsToRemove.filter((s) => s.length > 0);
    if (symbolsToRemove.length === 0) {
      return NextResponse.json({ success: false, error: 'symbol or symbols required' }, { status: 400 });
    }

    const updated = await removeFromRsWatchlist(symbolsToRemove);
    return NextResponse.json({ success: true, data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[/api/rs-strategy/watchlist DELETE]', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const symbol = String(body?.symbol ?? '').trim().toUpperCase();
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'symbol is required' }, { status: 400 });
    }
    const patch = body?.patch ?? {};
    const updated = await updateRsWatchlistItem(symbol, patch);
    return NextResponse.json({ success: true, data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[/api/rs-strategy/watchlist PATCH]', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

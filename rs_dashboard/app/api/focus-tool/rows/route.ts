import { NextRequest, NextResponse } from 'next/server';
import { readFocusConfig, writeFocusConfig, newFocusRowId, type FocusRow, type FocusToolConfig } from '@/lib/focusToolRows';

export async function GET(): Promise<NextResponse> {
  try {
    const config = readFocusConfig();
    return NextResponse.json({ success: true, data: config });
  } catch (err) {
    console.error('[/api/focus-tool/rows GET]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as Partial<FocusToolConfig> & { row?: Partial<FocusRow> };
    const config = readFocusConfig();

    // Plain last-write-wins — this is a single-user local tool, and an
    // optimistic-concurrency reject here caused more harm than it prevented:
    // this page saves from many independent places (Arm/Disarm, leg Exit
    // buttons, the scheduler, strike shifts), and even with those calls
    // serialized client-side, rejecting a save just discards a real user
    // action (e.g. Arm) in favour of a stale server snapshot. The actual risk
    // this guarded against — two browser tabs open at once, both saving — is
    // rare enough here that last-write-wins is the better trade.
    if (body.row) {
      // Upsert a single row
      const incoming = body.row;
      const now = new Date().toISOString();
      if (incoming.id) {
        const idx = config.rows.findIndex(r => r.id === incoming.id);
        if (idx >= 0) {
          config.rows[idx] = { ...config.rows[idx], ...incoming, updatedAt: now };
        } else {
          config.rows.push({ ...incoming, id: incoming.id, createdAt: now, updatedAt: now } as FocusRow);
        }
      } else {
        const id = newFocusRowId();
        config.rows.push({ ...incoming, id, createdAt: now, updatedAt: now } as FocusRow);
      }
    } else {
      // Full config update (groups, risk bar, liveRealMoney)
      const { row: _row, ...rest } = body;
      Object.assign(config, rest);
    }

    writeFocusConfig(config);
    return NextResponse.json({ success: true, data: config });
  } catch (err) {
    console.error('[/api/focus-tool/rows POST]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const { id } = await req.json() as { id: string };
    if (!id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
    const config = readFocusConfig();
    config.rows = config.rows.filter(r => r.id !== id);
    writeFocusConfig(config);
    return NextResponse.json({ success: true, data: config });
  } catch (err) {
    console.error('[/api/focus-tool/rows DELETE]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

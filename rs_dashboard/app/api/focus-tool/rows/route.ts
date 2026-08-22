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
    const body = await req.json() as Partial<FocusToolConfig> & {
      row?: Partial<FocusRow>;
      /** The `updatedAt` the client last read. A full-config write carries the
       *  client's whole rows/groups array, so without this check a second tab
       *  (or a stale one) silently overwrites everything the first one saved. */
      baseUpdatedAt?: string;
    };
    const config = readFocusConfig();

    // Only guards whole-config writes. A single-row upsert merges into the
    // stored row rather than replacing the array, so it cannot clobber edits
    // to other rows and doesn't need the check.
    if (!body.row && body.baseUpdatedAt && config.updatedAt && body.baseUpdatedAt !== config.updatedAt) {
      return NextResponse.json({
        success: false,
        conflict: true,
        error: 'This configuration was changed elsewhere since you loaded it. Reload to see the current version before saving again.',
        data: config,
      }, { status: 409 });
    }

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
      const { row: _row, baseUpdatedAt: _base, ...rest } = body;
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

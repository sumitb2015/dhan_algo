import { NextRequest, NextResponse } from 'next/server';
import { readLadderSettings, writeLadderSettings, timeStringToHhmm } from '@/lib/priceLadderSettings';
import { updateLadderState } from '@/lib/priceLadderServer';

export async function GET() {
  const settings = readLadderSettings();
  return NextResponse.json({ success: true, settings });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const mcxTime = typeof body.mcxAutoExitTime === 'string' ? body.mcxAutoExitTime.trim() : null;
  if (!mcxTime || timeStringToHhmm(mcxTime) == null) {
    return NextResponse.json({ success: false, error: 'Invalid time format. Expected HH:MM (e.g. 23:15)' }, { status: 400 });
  }

  const updated = writeLadderSettings({ mcxAutoExitTime: mcxTime });
  await updateLadderState(s => ({
    ...s,
    settings: { ...s.settings, mcxAutoExitTime: updated.mcxAutoExitTime },
  }));

  return NextResponse.json({ success: true, settings: updated });
}

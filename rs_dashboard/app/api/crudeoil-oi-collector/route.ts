import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { isPidRunning } from '@/lib/processCheck';
import { PYTHON_EXE } from '@/lib/pyExec';

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const DEBUG_DIR      = path.join(PROJECT_ROOT, 'debug');
const COLLECTOR      = path.join(PROJECT_ROOT, 'scripts', 'tools', 'crudeoil_oi_collector.py');
const STATUS_FILE    = path.join(DEBUG_DIR, 'crudeoil_oi_collector_status.json');
const STOP_TRIGGER   = path.join(DEBUG_DIR, 'crudeoil_oi_stop.trigger');

function readJson(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** GET — return collector status (PID cross-checked to detect crashes) */
export async function GET() {
  const status = readJson(STATUS_FILE);

  if (status && status.pid && status.status === 'RUNNING') {
    if (!isPidRunning(Number(status.pid))) {
      status.status = 'STOPPED';
      status.reason = 'crashed';
    }
  }

  return NextResponse.json({
    success: true,
    status: status ?? { status: 'STOPPED' },
  });
}

/** POST — start or stop the OI snapshot collector */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const action: string = body.action ?? '';

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (action === 'stop') {
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  if (action === 'start') {
    // Prevent a duplicate collector
    const status = readJson(STATUS_FILE);
    if (status && status.pid && status.status === 'RUNNING' && isPidRunning(Number(status.pid))) {
      return NextResponse.json({ success: true, message: 'Collector already running', pid: status.pid });
    }

    // Clear any stale stop trigger so the fresh process doesn't immediately exit
    if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);

    const child = spawn(PYTHON_EXE, [COLLECTOR], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    return NextResponse.json({ success: true, message: 'Collector started', pid: child.pid });
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}

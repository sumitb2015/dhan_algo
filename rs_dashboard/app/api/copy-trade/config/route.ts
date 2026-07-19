import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const CONFIG_FILE  = path.join(PROJECT_ROOT, 'debug', 'copy_trade_config.json');

type Broker = 'zerodha';

interface ChildConfig {
  broker: Broker;
  multiplier: number;
  enabled: boolean;
}

interface CopyTradeConfig {
  armed: boolean;
  children: ChildConfig[];
}

const DEFAULT_CONFIG: CopyTradeConfig = { armed: false, children: [] };

function readConfig(): CopyTradeConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      armed: !!raw.armed,
      children: Array.isArray(raw.children) ? raw.children : [],
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function writeConfig(config: CopyTradeConfig) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ success: true, config: readConfig() });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Partial<CopyTradeConfig>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  const current = readConfig();

  if (Array.isArray(body.children)) {
    for (const c of body.children) {
      if (c.broker !== 'zerodha') {
        return NextResponse.json({ success: false, error: `Unsupported broker: ${c.broker}` }, { status: 400 });
      }
      if (!Number.isInteger(c.multiplier) || c.multiplier <= 0) {
        return NextResponse.json({ success: false, error: `Invalid multiplier: ${c.multiplier} (must be a positive integer)` }, { status: 400 });
      }
      if (typeof c.enabled !== 'boolean') {
        return NextResponse.json({ success: false, error: 'enabled must be a boolean' }, { status: 400 });
      }
    }
    current.children = body.children;
  }

  if (typeof body.armed === 'boolean') {
    current.armed = body.armed;
  }

  writeConfig(current);
  return NextResponse.json({ success: true, config: current });
}

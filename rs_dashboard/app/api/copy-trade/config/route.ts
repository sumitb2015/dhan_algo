import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const CONFIG_FILE  = path.join(PROJECT_ROOT, 'debug', 'copy_trade_config.json');

// Child brokers the Python bridge can actually place orders through — see
// BROKER_CLASSES in scripts/tools/child_brokers.py. Accepting a name the bridge
// cannot construct would arm a child whose fills silently go nowhere.
const CHILD_BROKERS = ['zerodha', 'kotak'] as const;
type Broker = typeof CHILD_BROKERS[number];

interface ChildConfig {
  broker: Broker;
  multiplier: number;
  enabled: boolean;
}

interface CopyTradeConfig {
  armed: boolean;
  children: ChildConfig[];
  // The file also holds keys this UI does not manage — margin_check,
  // hedge_on_startup, hedge_product, hedge_premium_cap, hedge_premium_budget,
  // hedge_max_lots, hedge_respect_cash. They are read only by the Python bridge.
  [key: string]: unknown;
}

const DEFAULT_CONFIG: CopyTradeConfig = { armed: false, children: [] };

/**
 * Read the WHOLE config, not a projection of it.
 *
 * This used to return only { armed, children }, and POST wrote that projection
 * straight back — so every arm/disarm or multiplier change silently deleted the
 * bridge's hedge and margin-gate settings. The bridge then fell back to its
 * defaults (hedging OFF), which is a real behaviour change from a UI action that
 * never mentioned hedging. Unknown keys must survive a round-trip.
 */
function readConfig(): CopyTradeConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_CONFIG };
    return {
      ...raw,
      armed: !!raw.armed,
      children: Array.isArray(raw.children) ? raw.children : [],
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(config: CopyTradeConfig) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write: the Python bridge re-reads this file on every fill — a torn
  // read there would silently treat the fill as disarmed. On Windows the
  // rename can throw EPERM if the bridge has the file open at that instant
  // (Python's open() doesn't share delete access), so retry briefly; the
  // bridge's reads last only a few ms.
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, CONFIG_FILE);
      return;
    } catch (e) {
      if (attempt >= 4) throw e;
    }
  }
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
    const seen = new Set<string>();
    for (const c of body.children) {
      if (!CHILD_BROKERS.includes(c.broker)) {
        return NextResponse.json({ success: false, error: `Unsupported broker: ${c.broker}` }, { status: 400 });
      }
      // The bridge iterates this list per fill, so a duplicated broker would
      // replicate the same fill to the same account twice.
      if (seen.has(c.broker)) {
        return NextResponse.json({ success: false, error: `Duplicate broker in children: ${c.broker}` }, { status: 400 });
      }
      seen.add(c.broker);
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

import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const MASTER_CSV = path.join(PROJECT_ROOT, 'master_list.csv');

const DERIVATIVE_INSTRUMENTS = new Set(['OPTIDX', 'OPTSTK', 'OPTFUT', 'OPTCOM', 'FUTIDX', 'FUTSTK', 'FUTCOM']);
const DEFAULT_LOT = 75;
const MAP_TTL = 12 * 60 * 60 * 1000; // lot sizes are static intraday

// Whole-file parse cached as symbol → lot map; in-flight promise so
// concurrent first requests share one 15MB read instead of stacking.
let lotMap: Map<string, number> | null = null;
let lotMapTs = 0;
let building: Promise<Map<string, number>> | null = null;

async function buildLotMap(): Promise<Map<string, number>> {
  const content = await fs.promises.readFile(MASTER_CSV, 'utf-8');
  const lines = content.split(/\r?\n/);
  const headers = (lines[0] ?? '').split(',');
  const iSymbol = headers.indexOf('UNDERLYING_SYMBOL');
  const iInstr = headers.indexOf('INSTRUMENT');
  const iLot = headers.indexOf('LOT_SIZE');
  const map = new Map<string, number>();
  if (iSymbol < 0 || iInstr < 0 || iLot < 0) return map;
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    if (vals.length <= iLot) continue;
    if (!DERIVATIVE_INSTRUMENTS.has(vals[iInstr])) continue;
    const symbol = vals[iSymbol];
    if (!symbol || map.has(symbol)) continue;
    const lot = parseInt(vals[iLot], 10);
    if (!isNaN(lot) && lot > 0) map.set(symbol, lot);
  }
  return map;
}

async function getLotMap(): Promise<Map<string, number>> {
  if (lotMap && Date.now() - lotMapTs < MAP_TTL) return lotMap;
  if (!building) {
    building = buildLotMap()
      .then((map) => {
        lotMap = map;
        lotMapTs = Date.now();
        return map;
      })
      .finally(() => { building = null; });
  }
  return building;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get('symbol') ?? 'NIFTY').toUpperCase();

  try {
    const map = await getLotMap();
    return NextResponse.json({ symbol, lot_size: map.get(symbol) ?? DEFAULT_LOT });
  } catch {
    return NextResponse.json({ symbol, lot_size: DEFAULT_LOT });
  }
}

import { NextResponse } from 'next/server';
import path from 'path';
import { execFileSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get('symbol') ?? 'NIFTY').toUpperCase();

  const script = `
import csv, os, sys
csv_path = r'${PROJECT_ROOT.replace(/\\/g, '\\\\')}\\\\master_list.csv'
lot = 75
try:
    with open(csv_path, newline='') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get('UNDERLYING_SYMBOL') == '${symbol}' and row.get('INSTRUMENT') == 'OPTIDX':
                lot = int(float(row.get('LOT_SIZE', 75) or 75))
                break
except Exception as e:
    pass
print(lot)
`.trim();

  try {
    const out = execFileSync(PYTHON_EXE, ['-c', script], { timeout: 8000 })
      .toString()
      .trim();
    const lot_size = parseInt(out, 10);
    return NextResponse.json({ symbol, lot_size: isNaN(lot_size) ? 75 : lot_size });
  } catch {
    return NextResponse.json({ symbol, lot_size: 75 });
  }
}

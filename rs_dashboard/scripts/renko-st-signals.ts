// Renko bricks + Supertrend direction on NIFTY 1-minute bars, drawn with the /renko page's own code (lib/renko.ts buildRenko +
// renkoSupertrend, lib/renkoAutoBrick.ts calculateAutoBlockSize), so the backtest sees the bricks and line the page shows.
// Driven by scripts/analysis/backtest_renko_st_options.py, which applies the page AUTO's entry / exit rules to these bricks.
//
// Usage: node scripts/renko-st-signals.ts <bars.json> <from YYYY-MM-DD> <out.json> [stPeriod=1] [stMult=2] [fixed bricks csv]
//
// Output per brick config: every brick printed on or after <from>: { t (the minute that printed it), day, col (+1 green / -1
// red), dir (Supertrend +1 up / -1 down / null before it can be read), box }. 'auto' = the page's auto brick, recomputed each
// morning from the bars BEFORE that session (no look-ahead), with the whole chart redrawn on the new brick as the page does.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildRenko, renkoSupertrend } from '../lib/renko.ts';
import { calculateAutoBlockSize } from '../lib/renkoAutoBrick.ts';
import { sessionOf, type Bar } from '../lib/straddlePnf.ts';

const [barsPath, from, outPath, stP = '1', stM = '2', fixedCsv = '10,15,20,25,30,40,50'] = process.argv.slice(2);
if (!barsPath || !from || !outPath) {
  console.error('usage: node scripts/renko-st-signals.ts <bars.json> <from> <out.json> [stPeriod] [stMult] [fixed bricks csv]');
  process.exit(2);
}
const ST_PERIOD = Number(stP), ST_MULT = Number(stM);
const bars = JSON.parse(readFileSync(barsPath, 'utf8')) as Bar[];

const days = [...new Set(bars.map(b => sessionOf(b.t)))].filter(d => d >= from);
const firstIdx = new Map<string, number>();
const lastIdx = new Map<string, number>();
bars.forEach((b, i) => { const d = sessionOf(b.t); if (!firstIdx.has(d)) firstIdx.set(d, i); lastIdx.set(d, i); });

type Brick = { t: number; day: string; col: 1 | -1; dir: 1 | -1 | null; box: number };

/** A fixed box: Renko and Supertrend are causal, so one build over every bar gives each brick exactly as the page drew it then. */
function runFixed(box: number) {
  const { columns } = buildRenko(bars, box);
  const st = renkoSupertrend(columns, ST_PERIOD, ST_MULT);
  const bricks: Brick[] = [];
  columns.forEach((c, j) => {
    const day = sessionOf(bars[c.startBar].t);
    if (day >= from) bricks.push({ t: bars[c.startBar].t, day, col: c.dir === 'X' ? 1 : -1, dir: st[j].dir, box });
  });
  return { bricks, boxes: Object.fromEntries(days.map(d => [d, box])) as Record<string, number> };
}

const out: Record<string, ReturnType<typeof runFixed> & { formulas?: Record<string, string> }> = {};
const formulas: Record<string, string> = {};
// auto: the chart is redrawn each morning on that day's brick, from bars up to the day's end only
out.auto = (() => {
  const bricks: Brick[] = [];
  const boxes: Record<string, number> = {};
  for (const d of days) {
    const r = calculateAutoBlockSize({ symbol: 'NIFTY', kind: 'index', bars: bars.slice(0, firstIdx.get(d)!), market: 'NSE', targetMinutes: 30 });
    formulas[d] = r.formula;
    if (r.boxPts === null) throw new Error(`no auto brick for ${d}: ${r.formula}`);
    boxes[d] = r.boxPts;
    const f = firstIdx.get(d)!, l = lastIdx.get(d)!;
    const { columns } = buildRenko(bars.slice(0, l + 1), r.boxPts);
    const st = renkoSupertrend(columns, ST_PERIOD, ST_MULT);
    columns.forEach((c, j) => {
      if (c.startBar < f) return;
      bricks.push({ t: bars[c.startBar].t, day: d, col: c.dir === 'X' ? 1 : -1, dir: st[j].dir, box: r.boxPts! });
    });
  }
  return { bricks, boxes };
})();
out.auto.formulas = formulas;
for (const b of fixedCsv.split(',').map(Number).filter(n => n > 0)) out[`fixed${b}`] = runFixed(b);
writeFileSync(outPath, JSON.stringify({ stPeriod: ST_PERIOD, stMult: ST_MULT, days, configs: out }));
for (const [k, v] of Object.entries(out)) console.error(`${k.padEnd(8)} bricks ${String(v.bricks.length).padStart(5)}`);

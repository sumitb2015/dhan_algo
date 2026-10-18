import test from 'node:test';
import assert from 'node:assert/strict';
import { managedStraddle as S } from './managedStraddle.ts';
import { defaultsOf } from '../configSchema.ts';
import { closeBar, istMsOf } from '../bars.ts';
import type { AlgoConfig, AlgoCtx, CtxContract, PositionView } from '../types.ts';

const DAY = '2026-10-19';
const cfg = (extra: Record<string, unknown> = {}): AlgoConfig =>
  ({ ...defaultsOf(S), timeframe: 1, ...extra }) as AlgoConfig;

function makeCtx(opts: {
  hm: string;
  spot: number;
  atm: number;
  contracts: Record<string, { strike: number; option: 'CE' | 'PE'; ltp: number }>;
  open?: { id: string; key: string; option: 'CE' | 'PE'; entryPrice: number }[];
}): AlgoCtx {
  const contracts: Record<string, CtxContract> = {};
  for (const [key, c] of Object.entries(opts.contracts)) {
    contracts[key] = {
      key,
      strike: c.strike,
      option: c.option,
      ltp: c.ltp,
      volume: 10000,
      oi: 50000,
      prevClose: null,
      prevOi: null,
      bars1m: [{ t: `${DAY} ${opts.hm}:00`, o: c.ltp, h: c.ltp, l: c.ltp, c: c.ltp, v: 1000 }],
      warmupBars: 0,
    };
  }

  return {
    nowIstMs: istMsOf(DAY, opts.hm),
    date: DAY,
    hm: opts.hm,
    underlying: 'NIFTY',
    expiry: '2026-10-22',
    lotSize: 65,
    step: 50,
    spot: opts.spot,
    atm: opts.atm,
    spotBars1m: [closeBar(DAY, opts.hm, opts.spot)],
    contracts,
    open: (opts.open ?? []).map((o) => ({ ...o, side: 'SELL' as const })),
  };
}

test('managedStraddle gate: respects entry window (starts 09:20, ends 15:00)', () => {
  const earlyCtx = makeCtx({
    hm: '09:18',
    spot: 25000,
    atm: 25000,
    contracts: {
      '25000CE': { strike: 25000, option: 'CE', ltp: 100 },
      '25000PE': { strike: 25000, option: 'PE', ltp: 100 },
    },
  });
  const earlyGate = S.gate(earlyCtx, cfg());
  assert.equal(earlyGate.bias, 'WINDOW');
  assert.deepEqual(earlyGate.allowed, []);

  const validCtx = makeCtx({
    hm: '09:21',
    spot: 25000,
    atm: 25000,
    contracts: {
      '25000CE': { strike: 25000, option: 'CE', ltp: 105 },
      '25000PE': { strike: 25000, option: 'PE', ltp: 100 },
    },
  });
  const validGate = S.gate(validCtx, cfg());
  assert.equal(validGate.bias, 'BALANCED');
  assert.deepEqual(validGate.allowed, ['CE', 'PE']);
});

test('managedStraddle gate: checks ATM CE and PE difference < 10%', () => {
  // 5% diff -> Balanced
  const balCtx = makeCtx({
    hm: '09:25',
    spot: 25010,
    atm: 25000,
    contracts: {
      '25000CE': { strike: 25000, option: 'CE', ltp: 105 },
      '25000PE': { strike: 25000, option: 'PE', ltp: 100 },
    },
  });
  const balGate = S.gate(balCtx, cfg({ entryDiffPct: 10 }));
  assert.equal(balGate.bias, 'BALANCED');
  assert.deepEqual(balGate.allowed, ['CE', 'PE']);

  // 15% diff -> Unbalanced (wait & monitor)
  const unbalCtx = makeCtx({
    hm: '09:25',
    spot: 25010,
    atm: 25000,
    contracts: {
      '25000CE': { strike: 25000, option: 'CE', ltp: 115 },
      '25000PE': { strike: 25000, option: 'PE', ltp: 100 },
    },
  });
  const unbalGate = S.gate(unbalCtx, cfg({ entryDiffPct: 10 }));
  assert.equal(unbalGate.bias, 'UNBALANCED');
  assert.deepEqual(unbalGate.allowed, []);
});

test('managedStraddle scan: initial entry triggers both ATM CE and PE', () => {
  const ctx = makeCtx({
    hm: '09:25',
    spot: 25000,
    atm: 25000,
    contracts: {
      '25000CE': { strike: 25000, option: 'CE', ltp: 102 },
      '25000PE': { strike: 25000, option: 'PE', ltp: 100 },
      '25050CE': { strike: 25050, option: 'CE', ltp: 80 },
    },
  });
  const gate = S.gate(ctx, cfg());
  const cands = S.scan(ctx, cfg(), gate);

  const ce = cands.find((c) => c.key === '25000CE');
  const pe = cands.find((c) => c.key === '25000PE');
  const otm = cands.find((c) => c.key === '25050CE');

  assert.equal(ce?.eligible, true);
  assert.equal(pe?.eligible, true);
  assert.equal(otm?.eligible, false);
});

test('managedStraddle scan: roll mode selects closest non-inverted strike on missing side', () => {
  // CE is currently open at 25000 (LTP 100). PE is closed.
  // Available PEs: 25000PE (LTP 130), 24950PE (LTP 103), 24900PE (LTP 75).
  // 24950PE is closest to 100 (diff = 3).
  const ctx = makeCtx({
    hm: '10:15',
    spot: 25050,
    atm: 25050,
    contracts: {
      '25000CE': { strike: 25000, option: 'CE', ltp: 100 },
      '25000PE': { strike: 25000, option: 'PE', ltp: 130 },
      '24950PE': { strike: 24950, option: 'PE', ltp: 103 },
      '24900PE': { strike: 24900, option: 'PE', ltp: 75 },
    },
    open: [{ id: 'p_ce', key: '25000CE', option: 'CE', entryPrice: 100 }],
  });

  const gate = S.gate(ctx, cfg());
  const cands = S.scan(ctx, cfg(), gate);

  const bestRoll = cands.find((c) => c.eligible);
  assert.equal(bestRoll?.key, '24950PE');
  assert.equal(bestRoll?.score, 100);
});

test('managedStraddle onEntry: sets 20% leg SL and 30% leg target', () => {
  const plan = S.onEntry({ cols: { role: 'ATM CE' } } as any, 100, cfg({ legSlPct: 20, legTargetPct: 30 }));
  // SELL: stop is +20% (120), target is -30% decay (70)
  assert.equal(plan.stop, 120);
  assert.equal(plan.target, 70);
});

test('managedStraddle manage: triggers combined SL when total premium expands >= 20%', () => {
  const ctx = makeCtx({
    hm: '11:00',
    spot: 25000,
    atm: 25000,
    contracts: {
      '25000CE': { strike: 25000, option: 'CE', ltp: 135 },
      '25000PE': { strike: 25000, option: 'PE', ltp: 115 },
    },
    open: [
      { id: 'p_ce', key: '25000CE', option: 'CE', entryPrice: 100 },
      { id: 'p_pe', key: '25000PE', option: 'PE', entryPrice: 100 },
    ],
  });

  // Position: CE leg sold @ 100. Opp PE sold @ 100. Combined entry = 200. Combined SL @ 20% = 240.
  // CE current px = 135, PE current = 115 -> Combined = 250 >= 240!
  const cePos: PositionView = {
    id: 'p_ce',
    key: '25000CE',
    strike: 25000,
    option: 'CE',
    side: 'SELL',
    entryPrice: 100,
    stop: 120,
    initialStop: 120,
    best: 100,
    target: 70,
    state: {},
    openedAt: 1000,
  };

  const res = S.manage(cePos, 135, ctx, cfg({ combinedSlPct: 20 }));
  assert.ok(res.exits?.some((e) => e.kind === 'COMBINED_SL'));
});

test('managedStraddle manage: triggers leg target when price decays by 30%', () => {
  const ctx = makeCtx({
    hm: '11:00',
    spot: 25000,
    atm: 25000,
    contracts: {
      '25000CE': { strike: 25000, option: 'CE', ltp: 68 },
      '25000PE': { strike: 25000, option: 'PE', ltp: 95 },
    },
    open: [
      { id: 'p_ce', key: '25000CE', option: 'CE', entryPrice: 100 },
      { id: 'p_pe', key: '25000PE', option: 'PE', entryPrice: 100 },
    ],
  });

  const cePos: PositionView = {
    id: 'p_ce',
    key: '25000CE',
    strike: 25000,
    option: 'CE',
    side: 'SELL',
    entryPrice: 100,
    stop: 120,
    initialStop: 120,
    best: 68,
    target: 70,
    state: {},
    openedAt: 1000,
  };

  // px = 68 <= target (70)
  const res = S.manage(cePos, 68, ctx, cfg({ legTargetPct: 30 }));
  assert.ok(res.exits?.some((e) => e.kind === 'LEG_TARGET'));
});

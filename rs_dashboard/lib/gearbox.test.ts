import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computeGearbox, ghostTrades, ghostScore, WARM_BARS, ENTRY_AFTER_OPEN_MIN, ENTRY_BEFORE_EXIT_MIN,
  type GbBar, type GbSession, type GbState,
} from './gearbox.ts';

const fx = JSON.parse(readFileSync(new URL('./gearbox.fixture.json', import.meta.url), 'utf8')) as {
  bars: GbBar[]; states: { gear: number; mode: number; armed: boolean; signal: boolean }[];
};

// The artifact's window: entry on session bars 3..66 (5-min bars, open 09:00) means
// open + 15 min <= bar <= autoExit - 40 min with autoExit = open + 370 min (its last bar).
const artifactSession = (): GbSession => ({ openMin: 540, autoExitMin: 540 + 370 });
const IST = 19800;
const T0 = Date.UTC(2026, 0, 5) / 1000 - IST; // IST midnight

test('production window constants', () => {
  assert.equal(ENTRY_AFTER_OPEN_MIN, 15);
  assert.equal(ENTRY_BEFORE_EXIT_MIN, 40);
  assert.equal(WARM_BARS, 200);
});

test('parity with the artifact', () => {
  const st = computeGearbox(fx.bars, artifactSession);
  assert.equal(st.length, fx.states.length);
  let signals = 0;
  for (let i = 0; i < st.length; i++) {
    const e = fx.states[i];
    assert.equal(st[i].gear, e.gear, `gear @${i}`);
    assert.equal(st[i].mode, e.mode, `mode @${i}`);
    assert.equal(st[i].armed, e.armed, `armed @${i}`);
    assert.equal(st[i].signal, e.signal, `signal @${i}`);
    if (e.signal) signals++;
  }
  assert.ok(signals > 0, 'fixture must contain signals');
});

test('closed bars only: appending a bar changes only the last state', () => {
  const a = computeGearbox(fx.bars.slice(0, 400), artifactSession);
  const b = computeGearbox(fx.bars.slice(0, 401), artifactSession);
  assert.equal(b.length, 401);
  assert.deepEqual(b.slice(0, 400), a);
});

test('vwap resets at session open', () => {
  // second session's first bar: VWAP == its hlc3, so with mode set vwOK is c > hlc3 / c < hlc3
  const i = 75 * 5;
  const bar = fx.bars[i];
  const hlc3 = (bar.h! + bar.l! + bar.c) / 3;
  const st = computeGearbox(fx.bars.slice(0, i + 1), artifactSession)[i];
  assert.equal(st.sessionBar, 0);
  if (st.mode === 1) assert.equal(st.vwOK, bar.c > hlc3);
  else if (st.mode === -1) assert.equal(st.vwOK, bar.c < hlc3);
  // and sessionBar counts up inside the day
  assert.equal(computeGearbox(fx.bars.slice(0, i + 4), artifactSession)[i + 3].sessionBar, 3);
});

test('missing high/low falls back to close', () => {
  const bars: GbBar[] = [];
  for (let i = 0; i < 60; i++) bars.push({ t: T0 + 540 * 60 + i * 300, c: 100 + Math.sin(i / 3) * 2 + i * 0.05, v: 10 });
  const st = computeGearbox(bars, artifactSession);
  const last = st[st.length - 1];
  assert.ok(Number.isFinite(last.rpm) && Number.isFinite(last.alt) && Number.isFinite(last.sp));
  assert.ok(last.rpm >= 0);
  assert.ok(Number.isFinite(last.sl));
});

// ---- ghost -------------------------------------------------------------------------------
const N = WARM_BARS + 45;
function flat(): { bars: GbBar[]; states: GbState[] } {
  const bars: GbBar[] = [], states: GbState[] = [];
  for (let i = 0; i < N; i++) {
    const t = T0 + 540 * 60 + (i % 75) * 300 + Math.floor(i / 75) * 86400;
    bars.push({ t, o: 100, h: 102, l: 98, c: 100, v: 1 });
    states.push({ c: 100, gear: 3, mode: 1, armed: false, signal: false, vwOK: true, stOK: true, sd: 1, sl: 97, sp: 0, acc: 0, rpm: 0, alt: 0, t, sessionBar: i % 75 });
  }
  return { bars, states };
}
const E = WARM_BARS + 5; // entry bar, session bar (200+5)%75 = 5 -> 25 min after open

test('ghost stop checks the bar low and exits at the stop price', () => {
  const { bars, states } = flat();
  states[E].signal = true;
  const k = E + 2;
  bars[k] = { ...bars[k], l: 90, c: 100 }; // pierces the stop (98 = max(swing low 98, sl 97)) but closes above it
  const tr = ghostTrades(bars, states, artifactSession);
  assert.equal(tr.length, 1);
  assert.equal(tr[0].why, 'stop hit');
  assert.equal(tr[0].side, 1);
  assert.equal(tr[0].ei, E);
  assert.equal(tr[0].xi, k);
  assert.equal(tr[0].xp, 98);
});

test('ghost short stop checks the bar high', () => {
  const { bars, states } = flat();
  for (const s of states) { s.mode = -1; s.sd = -1; s.sl = 103; }
  states[E].signal = true;
  bars[E + 1] = { ...bars[E + 1], h: 110, c: 100 };
  const tr = ghostTrades(bars, states, artifactSession);
  assert.equal(tr[0].side, -1);
  assert.equal(tr[0].why, 'stop hit');
  assert.equal(tr[0].xp, 102);
});

test('fog does not exit the ghost', () => {
  const { bars, states } = flat();
  states[E].signal = true;
  for (let k = E + 1; k <= E + 3; k++) { states[k].mode = 0; states[k].gear = 0; }
  const tr = ghostTrades(bars, states, artifactSession);
  assert.equal(tr.length, 1);
  assert.equal(tr[0].why, 'session close'); // held through the fog, left only at the close
  assert.ok(tr[0].xi > E + 3);
  // cut right after the fog: still open, listed one past the data and markable by ghostScore
  const cut = ghostTrades(bars.slice(0, E + 4), states.slice(0, E + 4), artifactSession);
  assert.equal(cut.length, 1);
  assert.equal(cut[0].xi, E + 4);
  const sc = ghostScore(cut, states, E + 3);
  assert.equal(sc.open, 1);
  assert.equal(sc.closed, 0);
});

test('a flip to the opposite mode and a gear collapse exit', () => {
  const a = flat();
  a.states[E].signal = true;
  a.states[E + 2].mode = -1;
  assert.equal(ghostTrades(a.bars, a.states, artifactSession)[0].why, 'mode flipped');
  const b = flat();
  b.states[E].signal = true;
  b.states[E + 2].gear = 1;
  assert.equal(ghostTrades(b.bars, b.states, artifactSession)[0].why, 'gear collapsed');
});

test('no ghost entry outside the window', () => {
  const { bars, states } = flat();
  // 10 minutes after open (session bar 2): a signal there must not open a trade
  const base = Math.ceil(WARM_BARS / 75) * 75; // first session open at/after warm-up (225)
  const i = base + 2;
  states[i].signal = true;
  assert.equal(states[i].sessionBar, 2);
  assert.equal(ghostTrades(bars, states, artifactSession).length, 0);
  // control: the same signal at session bar 3 (15 min) is accepted
  states[i].signal = false; states[i + 1].signal = true;
  assert.equal(ghostTrades(bars, states, artifactSession).length, 1);
});

test('ghost closes at the session close', () => {
  const { bars, states } = flat();
  states[E].signal = true;
  // bar 224 is the last of day 3 (open + 370 = autoExit): exit at the close
  const last = 3 * 75 - 1; // 224
  const tr = ghostTrades(bars, states, artifactSession);
  assert.equal(tr[0].why, 'session close');
  assert.equal(tr[0].xi, last);
  assert.equal(tr[0].xp, 100);
});

test('ghostScore sums closed trades and marks the open one', () => {
  const states = flat().states;
  const trades = [
    { side: 1 as const, ei: 1, xi: 3, ep: 100, xp: 104, why: 'stop hit' as const },
    { side: -1 as const, ei: 4, xi: 6, ep: 100, xp: 103, why: 'mode flipped' as const },
    { side: 1 as const, ei: 8, xi: 20, ep: 98, xp: 99, why: 'session close' as const },
  ];
  states[9].c = 101;
  const s = ghostScore(trades, states, 9);
  assert.equal(s.closed, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.open, 1);
  assert.equal(s.points, 4 - 3 + 3);
});

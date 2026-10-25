import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeDayArchive, partsToArchive, archiveDay, archiveFile, type DayArchive } from './priceLadderArchive.ts';
import { rollDay, type LadderSlice, type LadderState } from './priceLadder.ts';

const contract = { underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt: 'CE' as const, securityId: '111', lotSize: 65, exchangeSegment: 'NSE_FNO' };
const slice = (o: Partial<LadderSlice>): LadderSlice => ({
  id: 'a', kind: 'xy', broker: 'dhan', mode: 'real', contract, side: 'BUY', lots: 1, qty: 65, product: 'NRML', state: 'closed',
  createdAt: 1, updatedAt: 1, ...o,
}) as LadderSlice;
const ev = (at: number, msg: string) => ({ at, level: 'info' as const, msg });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pl-archive-'));

test('mergeDayArchive: by id (newest wins), events de-duplicated and in time order, guards = latest', () => {
  const first = mergeDayArchive(null, '2026-10-21', { slices: [slice({ id: 'a', state: 'open' })], events: [ev(2, 'b'), ev(1, 'a')] }, 10);
  const again = mergeDayArchive(first, '2026-10-21', { slices: [slice({ id: 'a', state: 'closed', exitAvg: 5 }), slice({ id: 'b' })], events: [ev(1, 'a'), ev(3, 'c')], guards: { 'dhan:sim': { on: false } } }, 20);
  assert.deepEqual(again.slices.map(x => [x.id, x.state]), [['a', 'closed'], ['b', 'closed']]);
  assert.equal(again.slices.find(x => x.id === 'a')!.exitAvg, 5);
  assert.deepEqual(again.events.map(e => e.msg), ['a', 'b', 'c']);
  assert.deepEqual(again.guards, { 'dhan:sim': { on: false } });
  // idempotent: merging the same part twice changes nothing but the stamp
  const twice = mergeDayArchive(again, '2026-10-21', { slices: [slice({ id: 'b' })] }, 30);
  assert.equal(twice.slices.length, 2);
  assert.deepEqual(twice.guards, again.guards);
});

test('partsToArchive: a day roll saves the whole old ledger; a same-day clear saves only what disappeared', () => {
  const raw: LadderState = { date: '2026-10-21', events: [ev(1, 'x')], slices: [slice({ id: 'c', state: 'closed' }), slice({ id: 'o', state: 'open' }), slice({ id: 'r', state: 'armed' })] };
  const rolled = rollDay(raw, '2026-10-22', 5);
  const a = partsToArchive(raw, rolled, rolled)!;
  assert.equal(a.date, '2026-10-21');
  assert.deepEqual(a.part.slices!.map(x => x.id), ['c', 'o', 'r']);          // finished, carried and armed alike
  assert.equal(a.part.events!.length, 1);
  // same day: Clear removes the terminal one
  const cleared: LadderState = { ...raw, slices: raw.slices.filter(x => x.state !== 'closed') };
  const b = partsToArchive(raw, raw, cleared)!;
  assert.equal(b.date, '2026-10-21');
  assert.deepEqual(b.part.slices!.map(x => x.id), ['c']);
  // nothing dropped: nothing to save
  assert.equal(partsToArchive(raw, raw, raw), null);
  assert.equal(partsToArchive(raw, raw, { ...raw, events: [...raw.events, ev(2, 'y')] }), null);
  assert.equal(partsToArchive({ date: '2026-10-21', slices: [], events: [] }, { date: '2026-10-22', slices: [], events: [] }, { date: '2026-10-22', slices: [], events: [] }), null);
});

test('archiveDay: writes the day file, merges a second write into it, and sets an unreadable one aside and still saves', () => {
  const dir = tmp();
  archiveDay(dir, '2026-10-21', { slices: [slice({ id: 'a' })] }, 1);
  archiveDay(dir, '2026-10-21', { slices: [slice({ id: 'b' })] }, 2);
  const f = JSON.parse(fs.readFileSync(archiveFile(dir, '2026-10-21'), 'utf8')) as DayArchive;
  assert.deepEqual(f.slices.map(x => x.id).sort(), ['a', 'b']);
  assert.equal(path.basename(archiveFile(dir, '2026-10-21')), 'price_ladder_archive_2026-10-21.json');
  fs.writeFileSync(archiveFile(dir, '2026-10-22'), '{not json');
  archiveDay(dir, '2026-10-22', { slices: [slice({ id: 'z' })] }, 7);
  assert.equal(fs.readFileSync(`${archiveFile(dir, '2026-10-22')}.corrupt_7`, 'utf8'), '{not json');   // the bad file is kept aside, not overwritten
  assert.deepEqual((JSON.parse(fs.readFileSync(archiveFile(dir, '2026-10-22'), 'utf8')) as DayArchive).slices.map(x => x.id), ['z']);   // and the trades still land
  fs.rmSync(dir, { recursive: true, force: true });
});

test('archiveFile: a date that is not YYYY-MM-DD never reaches a path', () => {
  assert.equal(path.basename(archiveFile('/d', '../../etc/x')), 'price_ladder_archive_undated.json');
  assert.equal(path.dirname(archiveFile('/d', '2026-10-21/../..')), '/d');
});

test('rehearsal: a ledger dated yesterday rolls into the archive, the new ledger keeps only what is still live', () => {
  const dir = tmp();
  const raw: LadderState = {
    date: '2026-10-21', events: [ev(1, 'filled')],
    slices: [slice({ id: 'closed1', state: 'closed', exitAvg: 120, closedAt: 5 }), slice({ id: 'open1', state: 'open', filledQty: 65 }), slice({ id: 'rej', state: 'rejected' })],
    guards: { 'dhan:real': { on: true, stop: 1000, peak: 700 } },
  };
  const rolled = rollDay(raw, '2026-10-22', 9);
  const a = partsToArchive(raw, rolled, rolled)!;
  archiveDay(dir, a.date, a.part, 9);
  const f = JSON.parse(fs.readFileSync(archiveFile(dir, '2026-10-21'), 'utf8')) as DayArchive;
  assert.deepEqual(f.slices.map(x => x.id).sort(), ['closed1', 'open1', 'rej']);
  assert.equal(f.guards!['dhan:real'].peak, 700);                                // the archive keeps the day's guard as it was
  assert.deepEqual(rolled.slices.map(x => x.id), ['open1']);                     // the live ledger keeps the open position
  assert.equal(rolled.guards!['dhan:real'].on, false);
  assert.equal(rolled.guards!['dhan:real'].stop, 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});

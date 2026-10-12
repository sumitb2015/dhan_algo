import { test } from 'node:test';
import assert from 'node:assert';
import { evaluateHealth, isKillSwitchActive, liveLaunchBlockers, parseDhanDateTime, type HealthInput } from './dhanHealth.ts';

const NOW = new Date('2026-10-12T04:00:00Z'); // 09:30 IST

const good: HealthInput = {
  profile: { tokenValidity: '13/10/2026 05:30' },
  killSwitch: { killSwitchStatus: 'DEACTIVATE' },
  staticIp: { primaryIP: '1.2.3.4', secondaryIP: '' },
  publicIp: '1.2.3.4',
};
const byId = (r: ReturnType<typeof evaluateHealth>, id: string) => r.checks.find(c => c.id === id)!;

test('parses DD/MM/YYYY HH:mm as IST', () => {
  assert.strictEqual(parseDhanDateTime('13/10/2026 05:30')?.toISOString(), '2026-10-13T00:00:00.000Z');
  assert.strictEqual(parseDhanDateTime('garbage'), null);
});

test('deactivated is not read as activated', () => {
  assert.strictEqual(isKillSwitchActive({ killSwitchStatus: 'Kill Switch is Deactivated' }), false);
  assert.strictEqual(isKillSwitchActive({ killSwitchStatus: 'ACTIVATE' }), true);
  assert.strictEqual(isKillSwitchActive({ killSwitchStatus: '???' }), null);
});

test('healthy account is ok', () => {
  assert.strictEqual(evaluateHealth(good, NOW).level, 'ok');
});

test('expired and near-expiry tokens', () => {
  assert.strictEqual(byId(evaluateHealth({ ...good, profile: { tokenValidity: '12/10/2026 08:00' } }, NOW), 'token').level, 'bad');
  assert.strictEqual(byId(evaluateHealth({ ...good, profile: { tokenValidity: '12/10/2026 10:30' } }, NOW), 'token').level, 'warn');
});

test('a 401 on /profile is a rejected token, a network error is only unknown', () => {
  assert.strictEqual(byId(evaluateHealth({ ...good, profile: null, profileError: 'Dhan GET /profile failed: HTTP 401' }, NOW), 'token').level, 'bad');
  assert.strictEqual(byId(evaluateHealth({ ...good, profile: null, profileError: 'fetch failed' }, NOW), 'token').level, 'unknown');
});

test('kill switch on is bad', () => {
  const r = evaluateHealth({ ...good, killSwitch: { killSwitchStatus: 'ACTIVATE' } }, NOW);
  assert.strictEqual(r.level, 'bad');
  assert.strictEqual(byId(r, 'killswitch').level, 'bad');
});

test('static IP: mismatch bad, none registered bad, lookup failure unknown, secondary match ok', () => {
  assert.strictEqual(byId(evaluateHealth({ ...good, publicIp: '9.9.9.9' }, NOW), 'ip').level, 'bad');
  assert.strictEqual(byId(evaluateHealth({ ...good, staticIp: { primaryIP: '', secondaryIP: '' } }, NOW), 'ip').level, 'bad');
  assert.strictEqual(byId(evaluateHealth({ ...good, publicIp: null }, NOW), 'ip').level, 'unknown');
  assert.strictEqual(byId(evaluateHealth({ ...good, staticIp: { primaryIP: '5.5.5.5', secondaryIP: '1.2.3.4' } }, NOW), 'ip').level, 'ok');
});

test('an expired data plan warns', () => {
  const r = evaluateHealth({ ...good, profile: { tokenValidity: '13/10/2026 05:30', dataValidity: '01/10/2026 00:00' } }, NOW);
  assert.strictEqual(byId(r, 'dataplan').level, 'warn');
});

test('ipMismatch=warn downgrades a mismatch to a warning that never blocks a launch', () => {
  const r = evaluateHealth({ ...good, publicIp: '9.9.9.9', ipMismatch: 'warn' }, NOW);
  assert.strictEqual(byId(r, 'ip').level, 'warn');
  assert.deepStrictEqual(liveLaunchBlockers(r.checks, 'dhan'), []);
});

test('live launch: kill switch / IP only block when Dhan executes; an expired token always blocks', () => {
  const bad = evaluateHealth({ ...good, killSwitch: { killSwitchStatus: 'ACTIVATE' }, publicIp: '9.9.9.9' }, NOW).checks;
  assert.deepStrictEqual(liveLaunchBlockers(bad, 'dhan').map(c => c.id).sort(), ['ip', 'killswitch']);
  assert.deepStrictEqual(liveLaunchBlockers(bad, undefined).map(c => c.id).sort(), ['ip', 'killswitch']);
  assert.deepStrictEqual(liveLaunchBlockers(bad, 'zerodha'), []);
  const expired = evaluateHealth({ ...good, profile: { tokenValidity: '12/10/2026 08:00' } }, NOW).checks;
  assert.deepStrictEqual(liveLaunchBlockers(expired, 'kotak').map(c => c.id), ['token']);
});

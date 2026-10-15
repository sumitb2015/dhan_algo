import test from 'node:test';
import assert from 'node:assert/strict';

// Fake browser: an AudioContext that starts suspended (autoplay policy) and window event listeners we can fire.
const listeners: Record<string, Array<() => void>> = {};
let oscillators = 0;
class FakeCtx {
  state: 'suspended' | 'running' = 'suspended';
  currentTime = 0;
  destination = {};
  resume() { this.state = 'running'; return Promise.resolve(); }
  createOscillator() {
    oscillators++;
    return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
  }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
}
(globalThis as unknown as { window: unknown }).window = {
  AudioContext: FakeCtx,
  addEventListener: (k: string, fn: () => void) => { (listeners[k] ??= []).push(fn); },
  removeEventListener: (k: string, fn: () => void) => { listeners[k] = (listeners[k] ?? []).filter(f => f !== fn); },
};

const { installAlertSoundUnlock, playAlertChime } = await import('./alertSound.ts');

test('alert chime: silent before the page is clicked, plays after, and one chime per burst', () => {
  installAlertSoundUnlock();
  assert.equal(playAlertChime(10_000), false);                  // no interaction yet: browsers would block it
  assert.equal(oscillators, 0);
  listeners.pointerdown.forEach(fn => fn());                   // first click unlocks audio
  assert.equal(listeners.pointerdown.length, 0);                // and the unlock listener removes itself
  assert.equal(playAlertChime(20_000), true);
  assert.equal(oscillators, 3);
  assert.equal(playAlertChime(20_500), false);                  // several rules on one tick: one chime
  assert.equal(playAlertChime(21_600), true);
});

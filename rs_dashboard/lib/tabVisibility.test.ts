import test from 'node:test';
import assert from 'node:assert/strict';
import { isTabHidden, isTabVisible, onTabVisible } from './tabVisibility.ts';

test('tabVisibility SSR fallback: isTabHidden is false, isTabVisible is true, onTabVisible does not throw', () => {
  assert.equal(isTabHidden(), false);
  assert.equal(isTabVisible(), true);
  const cleanup = onTabVisible(() => {});
  assert.equal(typeof cleanup, 'function');
  cleanup();
});

test('tabVisibility DOM mock: responds to visibilityState changes', () => {
  let visibilityState = 'hidden';
  const listeners: Record<string, (() => void)[]> = {};
  
  (globalThis as unknown as { document: unknown }).document = {
    get visibilityState() { return visibilityState; },
    get hidden() { return visibilityState === 'hidden'; },
    addEventListener(event: string, fn: () => void) {
      (listeners[event] ??= []).push(fn);
    },
    removeEventListener(event: string, fn: () => void) {
      listeners[event] = (listeners[event] ?? []).filter(l => l !== fn);
    },
  };

  try {
    assert.equal(isTabHidden(), true);
    assert.equal(isTabVisible(), false);

    let called = 0;
    const cleanup = onTabVisible(() => { called++; });

    // When visibilityState changes to hidden, callback should NOT fire
    visibilityState = 'hidden';
    for (const fn of listeners['visibilitychange'] ?? []) fn();
    assert.equal(called, 0);

    // When visibilityState changes to visible, callback SHOULD fire
    visibilityState = 'visible';
    assert.equal(isTabHidden(), false);
    assert.equal(isTabVisible(), true);
    for (const fn of listeners['visibilitychange'] ?? []) fn();
    assert.equal(called, 1);

    // After cleanup, listener removed
    cleanup();
    for (const fn of listeners['visibilitychange'] ?? []) fn();
    assert.equal(called, 1);
  } finally {
    delete (globalThis as unknown as { document?: unknown }).document;
  }
});

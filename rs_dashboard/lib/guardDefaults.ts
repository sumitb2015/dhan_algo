// The daily default for a broker's server-side P&L Guard: when enabled, the watcher arms it by itself each IST day, so the
// loss limit no longer depends on someone clicking "arm" before the first trade. Pure parse/validate here; the file is
// debug/<broker>_guard_defaults.json, read and written by lib/guardServerCore.ts and lib/guardRoute.ts.

import { guardProductOf, validateSoftPnlGuard } from './softGuards.ts';

export interface GuardDefaults {
  enabled: boolean;
  /** Rupees; the loss limit that auto-arms (a positive magnitude, 0 = none). */
  loss: number;
  /** Rupees; 0 = no profit target (a day-lock design: the default protects, it does not cap winners). */
  profit: number;
  products: string[];
}

export const DEFAULT_GUARD_DEFAULTS: GuardDefaults = { enabled: true, loss: 10_000, profit: 0, products: ['INTRADAY', 'MARGIN', 'CNC'] };

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

/** A stored value, or the built-in default for anything missing/invalid (never throws). */
export function parseGuardDefaults(raw: unknown): GuardDefaults {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_GUARD_DEFAULTS, products: [...DEFAULT_GUARD_DEFAULTS.products] };
  const r = raw as Record<string, unknown>;
  const products = Array.isArray(r.products) ? [...new Set(r.products.map(p => guardProductOf(p)).filter(Boolean))] : [];
  const loss = Math.abs(num(r.loss)) || 0;
  const profit = Math.abs(num(r.profit)) || 0;
  // An explicit "off" is honoured even with no levels; anything else that could not arm falls back to the built-in default.
  if (r.enabled === false) return { enabled: false, loss, profit, products: products.length ? products : [...DEFAULT_GUARD_DEFAULTS.products] };
  if (validateSoftPnlGuard(profit, loss, products)) return { ...DEFAULT_GUARD_DEFAULTS, products: [...DEFAULT_GUARD_DEFAULTS.products] };
  return { enabled: r.enabled !== false, loss, profit, products };
}

/** Validates what a request typed. Returns the clean value, or an error message. */
export function validateGuardDefaults(body: Record<string, unknown>): { ok: true; value: GuardDefaults } | { ok: false; error: string } {
  const loss = Math.abs(num(body.loss)) || 0;
  const profit = Math.abs(num(body.profit)) || 0;
  const products = Array.isArray(body.products) ? [...new Set(body.products.map(p => guardProductOf(p)).filter(Boolean))] : [];
  const enabled = body.enabled === true;
  // Disabling needs no levels; enabling must be a guard that could actually fire.
  if (enabled) {
    const err = validateSoftPnlGuard(profit, loss, products);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, value: { enabled, loss, profit, products: products.length ? products : [...DEFAULT_GUARD_DEFAULTS.products] } };
}

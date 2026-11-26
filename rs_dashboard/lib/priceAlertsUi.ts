'use client';
// Price Alerts — the browser-side store shared by the header bell (NavBar), the chart ("+" menu, alert lines) and the one
// global listener mounted in app/layout.tsx (components/priceAlerts/PriceAlertListener.tsx). The listener is the only
// thing that talks to /api/price-alerts/stream; everything else reads this store, so a chart adds no polling of its own.

import { useSyncExternalStore } from 'react';
import type { AlertsView, InstrumentSpec, PriceAlert } from '@/lib/priceAlerts';

/** What the create dialog opens with: from the chart (instrument + price), or an existing alert to edit. */
export interface AlertDialogInit {
  editId?: string;
  instrument?: InstrumentSpec;
  /** Label for the prefilled instrument (the chart's name for it). */
  instrumentLabel?: string;
  value?: number;
  /** Set by openDialog: the panel was open, so closing the dialog reopens it. */
  fromPanel?: boolean;
}

interface UiState {
  view: AlertsView | null;
  panelOpen: boolean;
  dialog: AlertDialogInit | null;
}

let state: UiState = { view: null, panelOpen: false, dialog: null };
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());
const set = (patch: Partial<UiState>) => { state = { ...state, ...patch }; emit(); };

export const priceAlertsStore = {
  subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; },
  get: () => state,
  setView: (view: AlertsView) => set({ view }),
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  // The panel is a modal Sheet (it traps focus), so it steps aside while the dialog is open and comes back after.
  openDialog: (init: AlertDialogInit = {}) => set({ dialog: { ...init, fromPanel: state.panelOpen }, panelOpen: false }),
  closeDialog: () => set({ dialog: null, panelOpen: !!state.dialog?.fromPanel }),
};

const serverSnapshot = (): UiState => ({ view: null, panelOpen: false, dialog: null });
const SERVER_STATE = serverSnapshot();

export function usePriceAlertsUi(): UiState {
  return useSyncExternalStore(priceAlertsStore.subscribe, priceAlertsStore.get, () => SERVER_STATE);
}

const getView = () => state.view;
const getServerView = () => null;

/** Only the alerts view: a component using this does not re-render when the panel or dialog opens or closes (charts). */
export function usePriceAlertsView(): AlertsView | null {
  return useSyncExternalStore(priceAlertsStore.subscribe, getView, getServerView);
}

/** Active + paused alerts watching this exact instrument (Dhan segment + security id) — for chart lines. */
export function alertsFor(view: AlertsView | null, segment: string, securityId: string): PriceAlert[] {
  if (!view) return [];
  return view.alerts.filter(a => (a.status === 'active' || a.status === 'paused')
    && a.instrument.segment === segment && a.instrument.securityId === securityId);
}

/** POST one action to /api/price-alerts; returns the new view or throws with the server's message. */
export async function postAlertAction(body: Record<string, unknown>): Promise<AlertsView> {
  const res = await fetch('/api/price-alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  if (!j.success) throw new Error(j.error ?? `HTTP ${res.status}`);
  priceAlertsStore.setView(j.data as AlertsView);
  return j.data as AlertsView;
}

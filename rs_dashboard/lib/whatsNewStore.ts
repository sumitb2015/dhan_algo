'use client';

/**
 * What's New store. Module-level because NavBar is mounted per page and
 * remounts on every navigation — component state would reset the badge.
 * `seen` is the ISO date of the newest note the viewer has acknowledged,
 * persisted per browser in localStorage. Notes are fetched once and shared.
 */

import { useEffect, useSyncExternalStore } from 'react';
import {
  countUnread, latestDate, type ReleaseNote,
} from './releaseNotes';

export const WHATS_NEW_STORAGE_KEY = 'dhan-whatsnew-seen';
const REFRESH_MS = 5 * 60_000;

interface State {
  notes: ReleaseNote[];
  seen: string | null;
  loaded: boolean;
  error: boolean;
}

const listeners = new Set<() => void>();
let state: State = { notes: [], seen: null, loaded: false, error: false };
let started = false;
let inflight: Promise<void> | null = null;

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function readSeen(): string | null {
  try {
    return window.localStorage.getItem(WHATS_NEW_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeSeen(iso: string) {
  try {
    window.localStorage.setItem(WHATS_NEW_STORAGE_KEY, iso);
  } catch {
    /* private mode — badge just returns next load */
  }
}

export async function refreshNotes(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/release-notes');
      const json = await res.json();
      if (!json?.success || !Array.isArray(json.notes)) throw new Error('bad payload');
      const notes: ReleaseNote[] = json.notes;
      let seen = state.seen;
      // First visit ever: baseline to the newest note so the bell does not
      // open with hundreds of "unread" items from before the feature existed.
      if (seen === null) {
        const latest = latestDate(notes);
        if (latest) {
          seen = latest;
          writeSeen(latest);
        }
      }
      set({ notes, seen, loaded: true, error: false });
    } catch {
      set({ loaded: true, error: true });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Acknowledge everything currently loaded. */
export function markAllSeen() {
  const latest = latestDate(state.notes);
  if (!latest || latest === state.seen) return;
  writeSeen(latest);
  set({ seen: latest });
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  set({ seen: readSeen() });
  window.addEventListener('storage', (e) => {
    if (e.key === WHATS_NEW_STORAGE_KEY) set({ seen: e.newValue });
  });
  void refreshNotes();
  setInterval(() => void refreshNotes(), REFRESH_MS);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const SERVER_STATE: State = { notes: [], seen: null, loaded: false, error: false };

export function useWhatsNew() {
  useEffect(() => { start(); }, []);
  const s = useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
  return {
    notes: s.notes,
    loaded: s.loaded,
    error: s.error,
    seen: s.seen,
    unread: countUnread(s.notes, s.seen),
  };
}

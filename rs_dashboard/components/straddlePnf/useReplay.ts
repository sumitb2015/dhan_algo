'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_REPLAY_SPEED, isReplaySpeed, speedMs, type ReplaySpeed } from '@/lib/pnfReplay';

// Bar Replay state for the P&F / Renko page (lib/pnfReplay.ts has the rules). The page owns the data: it hands in `stepFrom`, the
// cursor one chart bar later (null at the end of the data). Saved per page and per pair of charts so "Continue" resumes a session.

export type ReplayPhase = 'off' | 'pick' | 'on';
export interface SavedReplay { charts: string; startT: number; cursorT: number; speed: ReplaySpeed }

function readSaved(key: string): SavedReplay | null {
  try {
    const j = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<SavedReplay> | null;
    if (!j || typeof j.charts !== 'string' || !Number.isFinite(j.startT) || !Number.isFinite(j.cursorT)) return null;
    return { charts: j.charts, startT: j.startT as number, cursorT: j.cursorT as number, speed: isReplaySpeed(j.speed) ? j.speed : DEFAULT_REPLAY_SPEED };
  } catch { return null; }
}

export function useReplay({ storageKey, charts, stepFrom }: {
  /** localStorage key of the saved session (the page's own prefix: P&F and Renko keep separate sessions). */
  storageKey: string;
  /** The charts' instruments ("C1 key|C2 key"): a saved session is offered back only for the same charts. */
  charts: string;
  stepFrom: (cursorT: number) => number | null;
}) {
  const [phase, setPhase] = useState<ReplayPhase>('off');
  const [startT, setStartT] = useState<number | null>(null);
  const [cursorT, setCursorT] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState<ReplaySpeed>(DEFAULT_REPLAY_SPEED);
  const [ended, setEnded] = useState(false);
  const [saved, setSaved] = useState<SavedReplay | null>(null);
  // The timer and the shortcuts read the latest step function and cursor without restarting on every render.
  const stepRef = useRef(stepFrom);
  const cursorRef = useRef(cursorT);
  useEffect(() => { stepRef.current = stepFrom; cursorRef.current = cursorT; });

  const step = useCallback(() => {
    const cur = cursorRef.current;
    if (cur === null) return false;
    const next = stepRef.current(cur);
    if (next === null) { setPlaying(false); setEnded(true); return false; }
    cursorRef.current = next;
    setCursorT(next);
    return true;
  }, []);

  /** Opening Replay starts with picking a bar (TradingView's scissors line); a saved session for these charts can be continued. */
  const open = useCallback(() => {
    const s = readSaved(storageKey);
    setSaved(s && s.charts === charts ? s : null);
    setPhase('pick');
    setPlaying(false);
  }, [storageKey, charts]);
  const close = useCallback(() => { setPhase('off'); setPlaying(false); setCursorT(null); setStartT(null); setEnded(false); }, []);
  const pick = useCallback(() => { setPlaying(false); setPhase('pick'); }, []);
  /** A start point: `cursor` is where the chart stops (just before the chosen bar), `start` the bar the replay begins with. */
  const start = useCallback((cursor: number, start: number) => {
    setStartT(start); setCursorT(cursor); cursorRef.current = cursor; setEnded(false); setPlaying(false); setPhase('on');
  }, []);
  const resume = useCallback(() => {
    if (!saved) return;
    setSpeedState(saved.speed);
    start(saved.cursorT, saved.startT);
  }, [saved, start]);
  const togglePlay = useCallback(() => { if (phase === 'on' && !ended) setPlaying(p => !p); }, [phase, ended]);
  const setSpeed = useCallback((s: ReplaySpeed) => setSpeedState(s), []);

  // Play: one chart bar per tick of the chosen speed; it stops by itself at the end of the data.
  useEffect(() => {
    if (!playing || phase !== 'on') return;
    const id = setInterval(() => { if (!step()) clearInterval(id); }, speedMs(speed));
    return () => clearInterval(id);
  }, [playing, phase, speed, step]);

  // The session is remembered as it moves (TradingView: "continue from the same point").
  useEffect(() => {
    if (phase !== 'on' || cursorT === null || startT === null) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ charts, startT, cursorT, speed } satisfies SavedReplay)); } catch { /* storage blocked */ }
  }, [phase, cursorT, startT, speed, charts, storageKey]);

  // Shortcuts (TradingView's): Shift+Down plays / pauses, Shift+Right steps forward, Esc leaves picking.
  useEffect(() => {
    if (phase === 'off') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.shiftKey && e.key === 'ArrowDown') { e.preventDefault(); togglePlay(); }
      else if (e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); setPlaying(false); step(); }
      else if (e.key === 'Escape' && phase === 'pick') { e.preventDefault(); if (cursorRef.current !== null) setPhase('on'); else close(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, togglePlay, step, close]);

  return {
    phase, active: phase !== 'off', picking: phase === 'pick', replaying: phase === 'on' && cursorT !== null,
    startT, cursorT, playing, speed, ended, saved,
    open, close, pick, start, resume, step: () => { setPlaying(false); step(); }, togglePlay, setSpeed,
  };
}

// A short attention chime for automatic alerts (Multi-Leg Focus risk rules). Synthesized with the Web Audio API: no audio
// file, no loading delay.
//
// Browsers only let a page make sound after the user has interacted with it (autoplay policy). An alert fires from a timer,
// not a click, so the AudioContext is created and unlocked on the page's first pointer/key event (installAlertSoundUnlock).
// Before that the chime is silently skipped; the on-screen toast still shows.

let ctx: AudioContext | null = null;
let lastPlayed = 0;
/** Several rules firing on the same tick give one chime, not a pile-up. */
const MIN_GAP_MS = 1500;

function getCtx(): AudioContext | null {
  if (ctx || typeof window === 'undefined') return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try { ctx = new Ctor(); } catch { ctx = null; }
  return ctx;
}

/** Unlocks audio on the first click/tap/keypress. Returns a cleanup for useEffect. */
export function installAlertSoundUnlock(): () => void {
  if (typeof window === 'undefined') return () => {};
  const unlock = () => {
    const c = getCtx();
    if (c && c.state === 'suspended') void c.resume().catch(() => {});
    if (c && c.state !== 'suspended') remove();
  };
  const remove = () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  return remove;
}

/** Two rising tones then one high tone (~0.6 s). No-op until audio is unlocked, and at most once per MIN_GAP_MS. */
export function playAlertChime(now = Date.now()): boolean {
  const c = ctx;
  if (!c || c.state !== 'running' || now - lastPlayed < MIN_GAP_MS) return false;
  lastPlayed = now;
  try {
    [660, 880, 1175].forEach((f, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      const t = c.currentTime + i * 0.18;
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g);
      g.connect(c.destination);
      o.start(t);
      o.stop(t + 0.17);
    });
    return true;
  } catch {
    return false;   // audio unavailable: the toast still shows
  }
}

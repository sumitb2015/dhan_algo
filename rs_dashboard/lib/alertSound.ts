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

/** Plays `freqs` one after another on the shared context. Gated like every chime: unlocked, and one per MIN_GAP_MS. */
function playTones(freqs: number[], type: OscillatorType, now: number, step = 0.18): boolean {
  const c = ctx;
  if (!c || c.state !== 'running' || now - lastPlayed < MIN_GAP_MS) return false;
  lastPlayed = now;
  try {
    freqs.forEach((f, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      const t = c.currentTime + i * step;
      o.type = type;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + step - 0.02);
      o.connect(g);
      g.connect(c.destination);
      o.start(t);
      o.stop(t + step - 0.01);
    });
    return true;
  } catch {
    return false;   // audio unavailable: the toast still shows
  }
}

/** Two rising tones then one high tone (~0.6 s). No-op until audio is unlocked, and at most once per MIN_GAP_MS. */
export function playAlertChime(now = Date.now()): boolean {
  return playTones([660, 880, 1175], 'triangle', now);
}

/** A trade was taken: two quick rising tones. */
export function playEntryChime(now = Date.now()): boolean {
  return playTones([784, 1047], 'sine', now, 0.14);
}

/** A trade was closed: two falling tones, so an exit never sounds like an entry. */
export function playExitChime(now = Date.now()): boolean {
  return playTones([1047, 698], 'sine', now, 0.14);
}

/** Something needs attention (a rejection or an unknown order): three low, flat buzzes. */
export function playWarnChime(now = Date.now()): boolean {
  return playTones([330, 330, 330], 'square', now, 0.16);
}

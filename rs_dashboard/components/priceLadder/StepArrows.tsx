'use client';

/** The up / down arrow pair on the right edge of a number box (the box needs `relative` and right padding). */
export function StepArrows({ label, onStep }: { label: string; onStep: (dir: 1 | -1) => void }) {
  const arrow = 'flex-1 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-700 active:bg-zinc-600 leading-none transition-colors';
  return (
    <div className="absolute right-px top-px bottom-px w-5 flex flex-col rounded-r overflow-hidden border-l border-zinc-700">
      <button type="button" tabIndex={-1} aria-label={`Increase ${label}`} onMouseDown={e => e.preventDefault()} onClick={() => onStep(1)} className={`${arrow} border-b border-zinc-700`}>
        <svg width="10" height="6" viewBox="0 0 8 5" fill="currentColor" aria-hidden><path d="M4 0l4 5H0z" /></svg>
      </button>
      <button type="button" tabIndex={-1} aria-label={`Decrease ${label}`} onMouseDown={e => e.preventDefault()} onClick={() => onStep(-1)} className={arrow}>
        <svg width="10" height="6" viewBox="0 0 8 5" fill="currentColor" aria-hidden><path d="M4 5L0 0h8z" /></svg>
      </button>
    </div>
  );
}

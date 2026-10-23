'use client';

/** The small up / down arrow pair on the right edge of a number box (the box needs `relative` and right padding). */
export function StepArrows({ label, onStep }: { label: string; onStep: (dir: 1 | -1) => void }) {
  const arrow = 'flex-1 flex items-center justify-center text-zinc-500 hover:text-white hover:bg-zinc-800 leading-none';
  return (
    <div className="absolute right-px top-px bottom-px w-4 flex flex-col rounded-r overflow-hidden border-l border-zinc-700">
      <button type="button" tabIndex={-1} aria-label={`Increase ${label}`} onMouseDown={e => e.preventDefault()} onClick={() => onStep(1)} className={`${arrow} border-b border-zinc-700`}>
        <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M4 0l4 5H0z" /></svg>
      </button>
      <button type="button" tabIndex={-1} aria-label={`Decrease ${label}`} onMouseDown={e => e.preventDefault()} onClick={() => onStep(-1)} className={arrow}>
        <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M4 5L0 0h8z" /></svg>
      </button>
    </div>
  );
}

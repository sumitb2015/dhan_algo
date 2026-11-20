'use client';

import { cn } from '@/lib/utils';
import type { GbState } from '@/lib/gearbox';

// The instrument cluster: speedometer (EMA9 slope, bp per bar), gear shifter with the animated knob, tachometer (ATRs from EMA9),
// the altitude and acceleration meters and the five lamps. Pure view of the last CLOSED bar's state. Colours: --gb-* tokens.

const DESC: Record<1 | -1, string[]> = {
  1: ['', 'Deep pullback, near reversal', 'Deep pullback', 'Normal pullback', 'Strong climb', 'Full throttle'],
  [-1]: ['', 'Deep rally, near reversal', 'Deep rally', 'Normal rally', 'Strong descent', 'Full descent'],
};
const KNOB: Record<number, [number, number]> = { 0: [90, 75], 1: [40, 30], 2: [40, 120], 3: [90, 30], 4: [90, 120], 5: [140, 30] };
const fmt = (v: number) => (v > 0 ? '+' : '') + v.toFixed(1);
const SAIRA = "'Saira Condensed', 'Arial Narrow', sans-serif";

function Gauge({ value, max, step, red, label, readout }: { value: number; max: number; step: number; red: number | null; label: string; readout: string }) {
  const a = (v: number) => -210 + (240 * Math.min(Math.max(v, 0), max)) / max;
  const pt = (d: number, r: number): [number, number] => [100 + r * Math.cos((d * Math.PI) / 180), 100 + r * Math.sin((d * Math.PI) / 180)];
  const arc = (v0: number, v1: number, r: number) => {
    const [x0, y0] = pt(a(v0), r), [x1, y1] = pt(a(v1), r);
    return `M${x0} ${y0}A${r} ${r} 0 ${a(v1) - a(v0) > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(2));
  return (
    <div>
      <svg viewBox="0 0 200 150" className="block h-auto w-full" role="img" aria-label={`${label}: ${readout}`}>
        <path d={arc(0, max, 88)} style={{ stroke: 'var(--gb-dial-track)' }} strokeWidth={7} fill="none" />
        {red !== null && <path d={arc(red, max, 88)} style={{ stroke: 'var(--gb-dial-red)' }} strokeWidth={7} fill="none" />}
        {ticks.map(v => {
          const [x0, y0] = pt(a(v), 74), [x1, y1] = pt(a(v), 84), [tx, ty] = pt(a(v), 60);
          return (
            <g key={v}>
              <line x1={x0} y1={y0} x2={x1} y2={y1} style={{ stroke: 'var(--gb-dial-tick)' }} strokeWidth={2.5} />
              <text x={tx} y={ty + 5} textAnchor="middle" fontSize={13} style={{ fill: 'var(--gb-dial-text)', fontFamily: SAIRA }}>{v}</text>
            </g>
          );
        })}
        <g style={{ transformOrigin: '100px 100px', transformBox: 'view-box', transition: 'transform .35s ease-out', transform: `rotate(${a(value)}deg)` }}>
          <line x1={92} y1={100} x2={178} y2={100} style={{ stroke: 'var(--gb-needle)' }} strokeWidth={4} strokeLinecap="round" />
        </g>
        <circle cx={100} cy={100} r={9} style={{ fill: 'var(--gb-hub-fill)', stroke: 'var(--gb-needle)' }} strokeWidth={2} />
      </svg>
      <div className="text-center text-[22px] font-bold leading-none tabular-nums text-zinc-100" style={{ fontFamily: SAIRA }}>{readout}</div>
      <div className="-mt-0.5 text-center text-xs text-zinc-400">{label}</div>
    </div>
  );
}

function Shifter({ s }: { s: GbState | null }) {
  const gear = s?.gear ?? 0, m = s?.mode ?? 0;
  const [kx, ky] = KNOB[gear];
  const knob = m === 1 ? 'var(--gb-knob-up)' : m === -1 ? 'var(--gb-knob-dn)' : 'var(--gb-knob-n)';
  return (
    <div className="text-center">
      <svg viewBox="0 0 180 150" className="block h-auto w-full" role="img" aria-label={`Gear shifter: ${gear ? `gear ${gear}` : 'neutral'}`}>
        <g style={{ stroke: 'var(--gb-shift-track)' }} strokeWidth={10} strokeLinecap="round" fill="none">
          <path d="M40 30V120M90 30V120M140 30V75M40 75H140" />
        </g>
        <g fontWeight={700} fontSize={17} textAnchor="middle" style={{ fill: 'var(--gb-shift-text)', fontFamily: SAIRA }}>
          <text x={40} y={17}>1</text><text x={40} y={146}>2</text><text x={90} y={17}>3</text><text x={90} y={146}>4</text><text x={140} y={17}>5</text><text x={160} y={80}>N</text>
        </g>
        <g data-testid="gb-knob" style={{ transition: 'transform .35s cubic-bezier(.3,1.4,.5,1)', transform: `translate(${kx}px,${ky}px)` }}>
          <circle r={17} cy={3} opacity={0.5} style={{ fill: 'var(--gb-knob-shadow)' }} />
          <circle r={16} style={{ fill: knob }} />
          <circle r={16} fill="none" strokeOpacity={0.35} strokeWidth={2} style={{ stroke: 'var(--gb-knob-ring)' }} />
          <text y={7} textAnchor="middle" fontWeight={700} fontSize={20} style={{ fill: 'var(--gb-knob-text)', fontFamily: SAIRA }}>{gear || 'N'}</text>
        </g>
      </svg>
      <div className="mt-0.5 text-[22px] font-bold leading-tight text-zinc-100" style={{ fontFamily: SAIRA }}>
        {!s ? 'Neutral' : m === 0 ? 'Neutral' : `${m > 0 ? 'Climbing ▲' : 'Descending ▼'} · Gear ${gear}`}
      </div>
      <div className="min-h-5 text-xs text-zinc-400">{!s ? 'Waiting for closed bars' : m === 0 ? 'Clutch in: too close to EMA200' : DESC[m][gear]}</div>
    </div>
  );
}

function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const f = Math.max(-1, Math.min(1, value / max)) * 50;
  return (
    <div className="text-xs text-zinc-400">
      <div className="flex justify-between"><span>{label}</span><span className="font-semibold tabular-nums text-zinc-100">{text}</span></div>
      <div className="relative mt-1 h-2.5 overflow-hidden rounded bg-zinc-800">
        <span className="absolute -bottom-0.5 -top-0.5 left-1/2 w-0.5 bg-zinc-600" aria-hidden />
        <i className={cn('absolute bottom-0 top-0 rounded', value >= 0 ? 'bg-emerald-500' : 'bg-red-500')}
          style={{ left: `${f < 0 ? 50 + f : 50}%`, width: `${Math.abs(f)}%` }} />
      </div>
    </div>
  );
}

type Tone = 'off' | 'g' | 'r' | 'a' | 'hot';
const LAMP: Record<Tone, string> = {
  off: 'bg-zinc-800 text-zinc-500',
  g: 'bg-emerald-500/20 text-emerald-300',
  r: 'bg-red-500/20 text-red-300',
  a: 'bg-amber-500/20 text-amber-300',
  hot: 'bg-orange-500 text-oncolor-dark animate-pulse motion-reduce:animate-none',
};
function Lamp({ tone, children, title }: { tone: Tone; children: string; title: string }) {
  return (
    <span title={title} data-tone={tone} className={cn('whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold transition-colors', LAMP[tone])}>
      {children}<span className="sr-only">{tone === 'off' ? ' off' : ' on'}</span>
    </span>
  );
}

export function Cluster({ s }: { s: GbState | null }) {
  const m = s?.mode ?? 0;
  const sp = s?.sp ?? 0;
  return (
    <div>
      <div className="mx-auto grid max-w-[760px] grid-cols-[1fr_1.1fr_1fr] items-center gap-5">
        <Gauge value={Math.abs(sp)} max={5} step={1} red={null} label="Speed · bp per bar" readout={`${Math.abs(sp).toFixed(1)} ${sp >= 0 ? '▲' : '▼'}`} />
        <Shifter s={s} />
        <Gauge value={s?.rpm ?? 0} max={3} step={0.5} red={2} label="RPM · ATRs from EMA9" readout={(s?.rpm ?? 0).toFixed(2)} />
      </div>
      <div className="mt-3.5 grid grid-cols-2 gap-x-6 gap-y-2.5">
        <Meter label="Altitude vs EMA200 ridge" value={s?.alt ?? 0} max={15} text={`${fmt(s?.alt ?? 0)} ATR`} />
        <Meter label="Acceleration" value={s?.acc ?? 0} max={1.5} text={fmt(s?.acc ?? 0)} />
      </div>
      <div className="mt-3.5 flex flex-wrap gap-2" data-testid="gb-lamps">
        <Lamp tone={m === 0 || !s ? 'off' : s.vwOK ? 'g' : 'r'} title="Close on the trend's side of the session VWAP">VWAP</Lamp>
        <Lamp tone={m === 0 || !s ? 'off' : s.stOK ? 'g' : 'r'} title="Supertrend (14, 3) agrees with the mode">Supertrend</Lamp>
        <Lamp tone={s?.armed ? 'a' : 'off'} title="Gear reached 4-5, then pulled back to 2-3">Setup</Lamp>
        <Lamp tone={s?.signal ? 'hot' : 'off'} title="Upshift out of the setup with VWAP and Supertrend agreeing: the ghost's entry">Shift up</Lamp>
        <Lamp tone={s && s.rpm > 2 ? 'r' : 'off'} title="More than 2 ATRs from EMA9: partial-profit territory">Over-rev</Lamp>
      </div>
    </div>
  );
}

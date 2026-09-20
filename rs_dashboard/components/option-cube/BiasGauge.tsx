import { directionalBias, type ScatterPoint } from '@/lib/optionScatter3d';
import { getBearishColor } from './shared';

const WHY: Record<string, string> = {
  'CE|Short buildup':  'Call writing — resistance building above',
  'CE|Long unwinding': 'Call longs exiting — upside conviction fading',
  'CE|Long buildup':   'Call buying — upside bet',
  'CE|Short covering': 'Call writers covering — resistance easing',
  'PE|Short buildup':  'Put writing — support building below',
  'PE|Long unwinding': 'Put longs exiting — downside hedge fading',
  'PE|Long buildup':   'Put buying — downside bet / hedge',
  'PE|Short covering': 'Put writers covering — support easing',
};

/**
 * What this contract's buildup implies for the UNDERLYING (not for the option):
 * writing calls / buying puts is bearish, writing puts / buying calls is bullish.
 */
export function BiasGauge({ point }: { point: Pick<ScatterPoint, 'side' | 'signal' | 'priceChg' | 'oiChg'> }) {
  const { dir, strength } = directionalBias(point);
  const bear = dir === 'bearish';
  return (
    <div className={`space-y-1 border p-2 rounded-lg ${bear ? 'bg-rose-950/30 border-rose-800/40' : 'bg-emerald-950/30 border-emerald-800/40'}`}>
      <div className="flex items-center justify-between text-[10px]">
        <span className={`font-bold uppercase tracking-wider ${bear ? 'text-rose-300' : 'text-emerald-300'}`}>
          {bear ? 'Bearish' : 'Bullish'} bias · underlying
        </span>
        <span className={`font-mono font-bold text-xs ${bear ? 'text-rose-400' : 'text-emerald-400'}`}>{strength}%</span>
      </div>
      <div className="w-full bg-zinc-900 h-1.5 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${strength}%`, backgroundColor: bear ? getBearishColor(strength) : '#10b981' }}
        />
      </div>
      <p className="text-[9px] text-zinc-400">{WHY[`${point.side}|${point.signal}`]}</p>
    </div>
  );
}

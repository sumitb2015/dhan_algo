import { OHLCVRow } from './rs';

export type RegimeStatus =
  | 'CONFIRMED_UPTREND'
  | 'UPTREND_UNDER_PRESSURE'
  | 'IN_CORRECTION'
  | 'RALLY_ATTEMPT';

export interface DistributionDay {
  date: string;
  close: number;
  changePct: number;
  volume: number;
  prevVolume: number;
  volumeChangePct: number;
  volumeVs50Avg: number;
  daysAgo: number;
  sessionIndex: number;
  expirySessionsLeft: number;
  distanceTo5Pct: number;
  maxGainSince: number;
  status: 'ACTIVE' | 'EXPIRED_TIME' | 'EXPIRED_GAIN';
  isStalling: boolean;
}

export interface FollowThroughDay {
  date: string;
  gainPct: number;
  volume: number;
  volRatioVs50Avg: number;
  daysAgo: number;
}

export interface MarketRegimeAnalysis {
  indexKey: 'NIFTY50' | 'NIFTY500';
  indexLabel: string;
  status: RegimeStatus;
  statusLabel: string;
  tone: 'emerald' | 'amber' | 'red' | 'sky';
  badgeColor: string;
  description: string;
  investorPlaybook: {
    posture: string;
    positionSizing: string;
    stopLossPolicy: string;
    breakoutDiscipline: string;
  };
  activeDistributionCount: number;
  activeStallingCount: number;
  totalActivePressure: number;
  activeDistributionDays: DistributionDay[];
  recentExpiredDays: DistributionDay[];
  lastFTD: FollowThroughDay | null;
  daysSinceLastDistribution: number;
  currentPrice: number;
  change1D: number;
  sma50: number;
  sma200: number;
  dataDate: string;
  history: {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    vol50Avg: number;
    sma50: number;
    sma200: number;
    changePct: number;
    isDistribution: boolean;
    isStalling: boolean;
    isFTD: boolean;
    rollingDistCount: number;
    regime: RegimeStatus;
  }[];
}

/** Compute simple moving average */
function computeSMA(values: number[], period: number, idx: number): number {
  if (idx < period - 1) return values[idx];
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    sum += values[i];
  }
  return sum / period;
}

/**
 * Computes the Institutional Market Regime & Distribution Days tracker
 * following the O'Neil / CANSLIM rules on rolling 25-day windows.
 */
export function calculateMarketRegime(
  rows: OHLCVRow[],
  indexKey: 'NIFTY50' | 'NIFTY500' = 'NIFTY50',
  lookbackSessions = 250
): MarketRegimeAnalysis {
  const label = indexKey === 'NIFTY50' ? 'Nifty 50' : 'Nifty 500';

  if (!rows || rows.length < 50) {
    return {
      indexKey,
      indexLabel: label,
      status: 'CONFIRMED_UPTREND',
      statusLabel: 'Insufficient Data',
      tone: 'emerald',
      badgeColor: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
      description: 'Historical data insufficient to calculate regime.',
      investorPlaybook: {
        posture: 'Neutral',
        positionSizing: 'Normal',
        stopLossPolicy: 'Standard',
        breakoutDiscipline: 'Selective',
      },
      activeDistributionCount: 0,
      activeStallingCount: 0,
      totalActivePressure: 0,
      activeDistributionDays: [],
      recentExpiredDays: [],
      lastFTD: null,
      daysSinceLastDistribution: 999,
      currentPrice: 0,
      change1D: 0,
      sma50: 0,
      sma200: 0,
      dataDate: '',
      history: [],
    };
  }

  const n = rows.length;
  const closes = rows.map((r) => r.close);
  const volumes = rows.map((r) => r.volume);

  // Robust Volume Repair: If an index feed has occasional zero-volume days (e.g. Dhan index spot gaps),
  // repair zeros by scaling the previous genuine session's volume by the relative range ratio,
  // preventing artificial 200x volume spikes.
  let lastValidVol = volumes.find((v) => v > 0) || 100_000_000;
  const effectiveVolumes = rows.map((r, i) => {
    if (r.volume > 0) {
      lastValidVol = r.volume;
      return r.volume;
    }
    const currRange = Math.max(r.high - r.low, r.close * 0.002);
    const prev = rows[i - 1];
    const prevRange = prev ? Math.max(prev.high - prev.low, prev.close * 0.002) : currRange;
    const ratio = Math.min(2.0, Math.max(0.5, currRange / prevRange));
    const estimated = Math.round(lastValidVol * ratio);
    lastValidVol = estimated;
    return estimated;
  });

  // Calculate moving averages across all rows
  const sma50Series = closes.map((_, i) => computeSMA(closes, 50, i));
  const sma200Series = closes.map((_, i) => computeSMA(closes, 200, i));
  const vol50Series = effectiveVolumes.map((_, i) => computeSMA(effectiveVolumes, 50, i));

  // Identify all distribution, stalling, and follow-through days across history
  interface RawEvent {
    index: number;
    date: string;
    close: number;
    changePct: number;
    volume: number;
    prevVolume: number;
    isDistribution: boolean;
    isStalling: boolean;
    isFTD: boolean;
  }

  const rawEvents: RawEvent[] = [];

  // Track state machine for Rally Attempts & Follow-Through Days
  let rallyDayCount = 0;
  let rallyStartLow = Infinity;
  let inRallyAttempt = false;

  for (let i = 1; i < n; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    const prevVol = effectiveVolumes[i - 1];
    const currVol = effectiveVolumes[i];
    const vol50 = vol50Series[i];

    const changePct = ((curr.close - prev.close) / prev.close) * 100;
    const volHigher = currVol > prevVol;

    // Distribution Day: decline >= 0.20% on higher volume
    const isDistribution = changePct <= -0.20 && volHigher;

    // Stalling / Churning Day: minimal advance/decline on higher volume closing off highs
    const range = curr.high - curr.low;
    const closeLocation = range > 0 ? (curr.close - curr.low) / range : 0.5;
    const isStalling =
      !isDistribution &&
      changePct >= -0.20 &&
      changePct <= 0.40 &&
      volHigher &&
      closeLocation < 0.45;

    // Follow-Through Day (FTD) logic:
    // When market is struggling or in correction:
    let isFTD = false;
    const recent20Low = Math.min(...closes.slice(Math.max(0, i - 20), i));

    if (curr.low <= recent20Low * 1.002 && curr.close > curr.open) {
      // Day 1 of Rally Attempt: Made new low, closed positive off the bottom
      inRallyAttempt = true;
      rallyDayCount = 1;
      rallyStartLow = curr.low;
    } else if (inRallyAttempt) {
      if (curr.low < rallyStartLow) {
        // Undercut rally low -> rally attempt failed
        inRallyAttempt = false;
        rallyDayCount = 0;
        rallyStartLow = Infinity;
      } else {
        rallyDayCount++;
        // Day 4 or later with gain >= 1.25% on higher volume and > 50-day average volume
        if (
          rallyDayCount >= 4 &&
          changePct >= 1.25 &&
          currVol > prevVol &&
          currVol >= vol50 * 0.95
        ) {
          isFTD = true;
          inRallyAttempt = false; // confirmed!
          rallyDayCount = 0;
        }
      }
    }

    rawEvents.push({
      index: i,
      date: curr.date,
      close: curr.close,
      changePct,
      volume: currVol,
      prevVolume: prevVol,
      isDistribution,
      isStalling,
      isFTD,
    });
  }

  // Helper to compute active distribution days at any given bar index `currBarIdx`
  function getActiveDistributionDaysAt(currBarIdx: number) {
    const windowStartIdx = Math.max(1, currBarIdx - 24); // 25 trading sessions window
    const distDaysInWindow = rawEvents.filter(
      (e) => (e.isDistribution || e.isStalling) && e.index >= windowStartIdx && e.index <= currBarIdx
    );

    const activeList: DistributionDay[] = [];
    const expiredList: DistributionDay[] = [];

    for (const d of distDaysInWindow) {
      const daysAgo = currBarIdx - d.index;
      const expirySessionsLeft = Math.max(0, 25 - daysAgo);

      // Check the 5% rally rule:
      // If any subsequent close up to currBarIdx was >= 5% above the distribution close
      let maxGainSince = 0;
      for (let j = d.index + 1; j <= currBarIdx; j++) {
        const gain = ((rows[j].close - d.close) / d.close) * 100;
        if (gain > maxGainSince) maxGainSince = gain;
      }

      const currentGain = ((rows[currBarIdx].close - d.close) / d.close) * 100;
      const distanceTo5Pct = Math.max(0, 5.0 - currentGain);

      let status: 'ACTIVE' | 'EXPIRED_TIME' | 'EXPIRED_GAIN' = 'ACTIVE';
      if (maxGainSince >= 5.0) {
        status = 'EXPIRED_GAIN';
      } else if (daysAgo >= 25) {
        status = 'EXPIRED_TIME';
      }

      const item: DistributionDay = {
        date: d.date,
        close: d.close,
        changePct: d.changePct,
        volume: d.volume,
        prevVolume: d.prevVolume,
        volumeChangePct: d.prevVolume > 0 ? ((d.volume - d.prevVolume) / d.prevVolume) * 100 : 0,
        volumeVs50Avg: vol50Series[d.index] > 0 ? d.volume / vol50Series[d.index] : 1,
        daysAgo,
        sessionIndex: d.index,
        expirySessionsLeft,
        distanceTo5Pct,
        maxGainSince,
        status,
        isStalling: d.isStalling,
      };

      if (status === 'ACTIVE') {
        activeList.push(item);
      } else {
        expiredList.push(item);
      }
    }

    return { activeList, expiredList };
  }

  // Construct rolling history for the charts
  const startIdx = Math.max(25, n - lookbackSessions);
  const history = [];

  for (let i = startIdx; i < n; i++) {
    const { activeList } = getActiveDistributionDaysAt(i);
    const activeStrict = activeList.filter((d) => !d.isStalling).length;
    const activeStall = activeList.filter((d) => d.isStalling).length;
    const totalPressure = activeStrict + activeStall * 0.5;

    const currClose = rows[i].close;
    const s50 = sma50Series[i];
    const s200 = sma200Series[i];

    let reg: RegimeStatus = 'CONFIRMED_UPTREND';
    if (totalPressure >= 5.5 || (totalPressure >= 4 && currClose < s50 && currClose < s200)) {
      reg = 'IN_CORRECTION';
    } else if (totalPressure >= 3.5 || (totalPressure >= 3 && currClose < s50)) {
      reg = 'UPTREND_UNDER_PRESSURE';
    } else {
      reg = 'CONFIRMED_UPTREND';
    }

    const event = rawEvents.find((e) => e.index === i);

    history.push({
      date: rows[i].date,
      open: rows[i].open,
      high: rows[i].high,
      low: rows[i].low,
      close: rows[i].close,
      volume: effectiveVolumes[i],
      vol50Avg: Math.round(vol50Series[i]),
      sma50: Math.round(s50 * 100) / 100,
      sma200: Math.round(s200 * 100) / 100,
      changePct: event ? event.changePct : 0,
      isDistribution: event ? event.isDistribution : false,
      isStalling: event ? event.isStalling : false,
      isFTD: event ? event.isFTD : false,
      rollingDistCount: activeStrict,
      regime: reg,
    });
  }

  // Compute final current metrics as of the latest completed bar
  const latestIdx = n - 1;
  const { activeList, expiredList } = getActiveDistributionDaysAt(latestIdx);
  const activeStrictCount = activeList.filter((d) => !d.isStalling).length;
  const activeStallCount = activeList.filter((d) => d.isStalling).length;
  const totalPressure = activeStrictCount + activeStallCount * 0.5;

  const currentPrice = rows[latestIdx].close;
  const prevPrice = rows[latestIdx - 1]?.close ?? currentPrice;
  const change1D = ((currentPrice - prevPrice) / prevPrice) * 100;
  const curSma50 = sma50Series[latestIdx];
  const curSma200 = sma200Series[latestIdx];

  // Look for last Follow-Through Day in the last 60 sessions
  let lastFTD: FollowThroughDay | null = null;
  for (let k = rawEvents.length - 1; k >= Math.max(0, rawEvents.length - 60); k--) {
    if (rawEvents[k].isFTD) {
      lastFTD = {
        date: rawEvents[k].date,
        gainPct: rawEvents[k].changePct,
        volume: rawEvents[k].volume,
        volRatioVs50Avg:
          vol50Series[rawEvents[k].index] > 0
            ? rawEvents[k].volume / vol50Series[rawEvents[k].index]
            : 1.2,
        daysAgo: latestIdx - rawEvents[k].index,
      };
      break;
    }
  }

  // Days since last distribution day
  let daysSinceLastDistribution = 999;
  for (let k = rawEvents.length - 1; k >= 0; k--) {
    if (rawEvents[k].isDistribution) {
      daysSinceLastDistribution = latestIdx - rawEvents[k].index;
      break;
    }
  }

  // Final Regime Determination
  let status: RegimeStatus = 'CONFIRMED_UPTREND';
  let statusLabel = 'Confirmed Uptrend';
  let tone: 'emerald' | 'amber' | 'red' | 'sky' = 'emerald';
  let badgeColor = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25';
  let description =
    'The market is in a healthy institutional uptrend with minimal selling. Full exposure and standard position sizes are warranted.';
  let investorPlaybook = {
    posture: 'Aggressive / Risk-On',
    positionSizing: '100% Full Position Sizes (8–10% per stock)',
    stopLossPolicy: 'Standard 7–8% trailing stop from purchase price',
    breakoutDiscipline: 'Buy high-RS Stage 2 breakouts from sound bases freely',
  };

  if (totalPressure >= 5.5 || (totalPressure >= 4 && currentPrice < curSma50 && currentPrice < curSma200)) {
    status = 'IN_CORRECTION';
    statusLabel = 'Market in Correction';
    tone = 'red';
    badgeColor = 'bg-red-500/10 text-red-400 border-red-500/25';
    description =
      'Heavy institutional distribution has pushed the market into a correction. High cash allocation and strict capital preservation are imperative.';
    investorPlaybook = {
      posture: 'Defensive / Capital Preservation Mode',
      positionSizing: '0% New Exposure / Raise Cash to 80–100%',
      stopLossPolicy: 'Tighten all existing trailing stops to break-even or 3–4%',
      breakoutDiscipline: 'Strictly avoid buying breakouts — failure rate is extremely elevated',
    };
  } else if (totalPressure >= 3.5 || (totalPressure >= 3 && currentPrice < curSma50)) {
    status = 'UPTREND_UNDER_PRESSURE';
    statusLabel = 'Uptrend Under Pressure';
    tone = 'amber';
    badgeColor = 'bg-amber-500/10 text-amber-400 border-amber-500/25';
    description =
      'Institutional distribution days have accumulated (4–5 active). Market leadership is thinning. Freeze aggressive buying and protect profits.';
    investorPlaybook = {
      posture: 'Cautious / Reduced Exposure',
      positionSizing: 'Cut new entry sizes in half (50% normal size)',
      stopLossPolicy: 'Tighten trailing stops on winners; take 20–25% partial profits',
      breakoutDiscipline: 'Only consider elite 8/8 Stage 2 leaders with tight VCP bases; pass on average setups',
    };
  } else if (inRallyAttempt && totalPressure <= 3) {
    status = 'RALLY_ATTEMPT';
    statusLabel = 'Rally Attempt';
    tone = 'sky';
    badgeColor = 'bg-sky-500/10 text-sky-400 border-sky-500/25';
    description =
      'Market is holding above recent lows and attempting a bottom. Awaiting a Day 4+ Follow-Through Day (≥1.25% gain on above-average volume) to confirm uptrend.';
    investorPlaybook = {
      posture: 'Watchlist Preparation / Patient Stance',
      positionSizing: 'Hold cash; small pilot positions (25%) only',
      stopLossPolicy: 'Tight stops beneath recent swing lows',
      breakoutDiscipline: 'Assemble watchlist of stocks with Mansfield RS > 0 resisting the index pull',
    };
  }

  return {
    indexKey,
    indexLabel: label,
    status,
    statusLabel,
    tone,
    badgeColor,
    description,
    investorPlaybook,
    activeDistributionCount: activeStrictCount,
    activeStallingCount: activeStallCount,
    totalActivePressure: Math.round(totalPressure * 10) / 10,
    activeDistributionDays: activeList.sort((a, b) => b.daysAgo - a.daysAgo),
    recentExpiredDays: expiredList.slice(-10),
    lastFTD,
    daysSinceLastDistribution,
    currentPrice: Math.round(currentPrice * 100) / 100,
    change1D: Math.round(change1D * 100) / 100,
    sma50: Math.round(curSma50 * 100) / 100,
    sma200: Math.round(curSma200 * 100) / 100,
    dataDate: rows[latestIdx].date,
    history,
  };
}

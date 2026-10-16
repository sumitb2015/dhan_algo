// The US Markets dashboard's curated universe: index proxies, macro ETFs, the 11 GICS sectors and AI themes. Pure - no fs,
// no fetch, no `@/` imports, so `node --test` can load it. Symbols, not ids: ids are resolved against Dhan's US instrument
// master at runtime (resolveUniverse), and a symbol Dhan does not list is reported, never guessed.
//
// As of 2026-10-16. Sector membership follows GICS after the March 2023 reclassification (V, MA, PYPL -> Financials;
// GOOGL, META, NFLX -> Communication Services; AMZN, TSLA -> Consumer Discretionary). Leaders are the largest S&P 500 names per
// sector by market cap at the time of writing. AI themes are overlapping tags on top of the sector (a stock keeps its GICS
// sector) using the layered AI-stack split common to 2026 coverage: chips, memory, foundry/equipment, hyperscalers,
// neoclouds/servers, networking/optics, power/cooling/data centres, software. Market caps move - review the lists periodically.
//
// Dhan has no index instruments, so indices are shown through ETFs here (and as real, delayed levels from Yahoo on the page).
// Not on Dhan's list on 2026-10-16, substituted: VIXY -> VXX, USO -> OILK, UUP -> USDU.

export type UsGroupKind = 'index' | 'macro' | 'sector' | 'ai';

export interface UsGroup {
  key: string;
  label: string;
  kind: UsGroupKind;
  /** The group's benchmark ETF (sector SPDR / theme ETF), shown as the group's own move. Not counted as a member. */
  etf?: string;
  /** Short description for tooltips. */
  desc: string;
  symbols: string[];
}

export const US_UNIVERSE_AS_OF = '2026-10-16';

/** Display labels for the index-proxy ETFs. */
export const INDEX_PROXY_LABEL: Record<string, string> = {
  SPY: 'S&P 500', QQQ: 'Nasdaq-100', DIA: 'Dow 30', IWM: 'Russell 2000', RSP: 'S&P 500 EW', MDY: 'S&P MidCap 400', VXX: 'VIX futures',
  TLT: '20Y+ Treasury', IEF: '7-10Y Treasury', HYG: 'High yield', GLD: 'Gold', SLV: 'Silver', OILK: 'Crude oil', USDU: 'US dollar',
};

export const US_GROUPS: UsGroup[] = [
  { key: 'index', label: 'Index ETFs', kind: 'index', desc: 'Live ETF proxies for the major US indices', symbols: ['SPY', 'QQQ', 'DIA', 'IWM', 'RSP', 'MDY', 'VXX'] },
  { key: 'macro', label: 'Rates & Commodities', kind: 'macro', desc: 'Bonds, credit, metals, oil and the dollar', symbols: ['TLT', 'IEF', 'HYG', 'GLD', 'SLV', 'OILK', 'USDU'] },

  { key: 'tech', label: 'Technology', kind: 'sector', etf: 'XLK', desc: 'GICS Information Technology',
    symbols: ['NVDA', 'AAPL', 'MSFT', 'AVGO', 'ORCL', 'AMD', 'MU', 'CSCO', 'CRM', 'IBM', 'ADBE', 'QCOM', 'TXN', 'INTU', 'NOW'] },
  { key: 'comm', label: 'Communication', kind: 'sector', etf: 'XLC', desc: 'GICS Communication Services',
    symbols: ['GOOGL', 'META', 'NFLX', 'TMUS', 'DIS', 'T', 'VZ', 'CMCSA'] },
  { key: 'disc', label: 'Consumer Disc.', kind: 'sector', etf: 'XLY', desc: 'GICS Consumer Discretionary',
    symbols: ['AMZN', 'TSLA', 'HD', 'MCD', 'BKNG', 'LOW', 'TJX', 'NKE', 'SBUX'] },
  { key: 'staples', label: 'Consumer Staples', kind: 'sector', etf: 'XLP', desc: 'GICS Consumer Staples',
    symbols: ['WMT', 'COST', 'PG', 'KO', 'PEP', 'PM', 'MDLZ', 'CL'] },
  { key: 'fin', label: 'Financials', kind: 'sector', etf: 'XLF', desc: 'GICS Financials (incl. payment networks since 2023)',
    symbols: ['BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'AXP', 'BLK', 'PYPL'] },
  { key: 'health', label: 'Health Care', kind: 'sector', etf: 'XLV', desc: 'GICS Health Care',
    symbols: ['LLY', 'UNH', 'JNJ', 'ABBV', 'MRK', 'TMO', 'ABT', 'ISRG', 'AMGN', 'PFE'] },
  { key: 'indu', label: 'Industrials', kind: 'sector', etf: 'XLI', desc: 'GICS Industrials',
    symbols: ['GE', 'CAT', 'RTX', 'UBER', 'HON', 'BA', 'UNP', 'DE', 'LMT', 'ETN'] },
  { key: 'energy', label: 'Energy', kind: 'sector', etf: 'XLE', desc: 'GICS Energy',
    symbols: ['XOM', 'CVX', 'COP', 'EOG', 'SLB', 'OXY', 'PSX', 'MPC'] },
  { key: 'mat', label: 'Materials', kind: 'sector', etf: 'XLB', desc: 'GICS Materials',
    symbols: ['LIN', 'SHW', 'APD', 'FCX', 'NEM', 'ECL', 'NUE'] },
  { key: 'util', label: 'Utilities', kind: 'sector', etf: 'XLU', desc: 'GICS Utilities',
    symbols: ['NEE', 'SO', 'DUK', 'CEG', 'VST', 'AEP', 'D'] },
  { key: 're', label: 'Real Estate', kind: 'sector', etf: 'XLRE', desc: 'GICS Real Estate',
    symbols: ['PLD', 'AMT', 'EQIX', 'WELL', 'SPG', 'O', 'DLR'] },

  { key: 'ai-chips', label: 'AI Chips', kind: 'ai', etf: 'SMH', desc: 'GPU, accelerator, custom-silicon and CPU designers',
    symbols: ['NVDA', 'AMD', 'AVGO', 'MRVL', 'ARM', 'QCOM', 'INTC'] },
  { key: 'ai-memory', label: 'Memory & Storage', kind: 'ai', desc: 'HBM/DRAM, NAND and data-centre storage',
    symbols: ['MU', 'SNDK', 'WDC', 'STX'] },
  { key: 'ai-fab', label: 'Foundry & Equipment', kind: 'ai', etf: 'SOXX', desc: 'Leading-edge foundry and wafer-fab equipment',
    symbols: ['TSM', 'ASML', 'AMAT', 'LRCX', 'KLAC'] },
  { key: 'ai-cloud', label: 'Hyperscalers & Cloud', kind: 'ai', desc: 'The big AI capex spenders and cloud platforms',
    symbols: ['MSFT', 'GOOGL', 'AMZN', 'META', 'ORCL'] },
  { key: 'ai-neocloud', label: 'Neoclouds & AI Servers', kind: 'ai', desc: 'GPU clouds and AI server / rack builders',
    symbols: ['CRWV', 'NBIS', 'IREN', 'SMCI', 'DELL', 'CLS'] },
  { key: 'ai-network', label: 'Networking & Optics', kind: 'ai', desc: 'Data-centre switching, interconnect and optical links',
    symbols: ['ANET', 'CRDO', 'ALAB', 'COHR', 'LITE', 'CIEN'] },
  { key: 'ai-power', label: 'Power, Cooling & DC', kind: 'ai', desc: 'Grid power, nuclear, cooling and data-centre REITs',
    symbols: ['VRT', 'GEV', 'CEG', 'VST', 'ETN', 'OKLO', 'EQIX', 'DLR'] },
  { key: 'ai-software', label: 'AI Software', kind: 'ai', etf: 'IGV', desc: 'AI platforms, data, security and observability',
    symbols: ['PLTR', 'NOW', 'CRM', 'SNOW', 'CRWD', 'DDOG', 'ADBE'] },
  { key: 'ai-etf', label: 'AI ETFs', kind: 'ai', desc: 'Broad AI / robotics funds',
    symbols: ['BOTZ', 'AIQ'] },
];

/** Every symbol the dashboard subscribes to (members + group ETFs), de-duplicated, in catalog order. */
export function universeSymbols(groups: readonly UsGroup[] = US_GROUPS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of groups) for (const s of [...(g.etf ? [g.etf] : []), ...g.symbols]) if (!seen.has(s)) { seen.add(s); out.push(s); }
  return out;
}

/** GICS sector of a symbol (the first sector group that lists it), or null. */
export function sectorOf(symbol: string, groups: readonly UsGroup[] = US_GROUPS): UsGroup | null {
  return groups.find(g => g.kind === 'sector' && g.symbols.includes(symbol)) ?? null;
}

/** AI themes a symbol belongs to. */
export function aiThemesOf(symbol: string, groups: readonly UsGroup[] = US_GROUPS): UsGroup[] {
  return groups.filter(g => g.kind === 'ai' && g.symbols.includes(symbol));
}

export interface ResolvedUniverse { ids: string[]; idBySymbol: Map<string, string>; unresolved: string[] }

/** Maps catalog symbols to Dhan security ids. `lookup` is symbol -> id from the master (first listing wins). */
export function resolveUniverse(lookup: ReadonlyMap<string, string>, groups: readonly UsGroup[] = US_GROUPS): ResolvedUniverse {
  const ids: string[] = [];
  const idBySymbol = new Map<string, string>();
  const unresolved: string[] = [];
  for (const s of universeSymbols(groups)) {
    const id = lookup.get(s);
    if (!id) { unresolved.push(s); continue; }
    idBySymbol.set(s, id);
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, idBySymbol, unresolved };
}

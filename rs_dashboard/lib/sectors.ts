// Sector mapping for Nifty 500 stocks
export type Sector =
  | 'IT'
  | 'Banking'
  | 'Auto'
  | 'FMCG'
  | 'Pharma'
  | 'Energy'
  | 'Metals'
  | 'Finance'
  | 'Insurance'
  | 'Real Estate'
  | 'Cement'
  | 'Capital Markets'
  | 'Healthcare'
  | 'Telecom'
  | 'Chemicals'
  | 'Infrastructure'
  | 'Consumer'
  | 'Textiles'
  | 'Defence'
  | 'Power'
  | 'Other';

export const SECTOR_COLORS: Record<Sector, string> = {
  IT: '#6366f1',
  Banking: '#3b82f6',
  Auto: '#f59e0b',
  FMCG: '#10b981',
  Pharma: '#06b6d4',
  Energy: '#f97316',
  Metals: '#8b5cf6',
  Finance: '#0ea5e9',
  Insurance: '#14b8a6',
  'Real Estate': '#ec4899',
  Cement: '#78716c',
  'Capital Markets': '#a855f7',
  Healthcare: '#22c55e',
  Telecom: '#f43f5e',
  Chemicals: '#d946ef',
  Infrastructure: '#64748b',
  Consumer: '#eab308',
  Textiles: '#84cc16',
  Defence: '#dc2626',
  Power: '#fb923c',
  Other: '#475569',
};

export const SECTOR_MAP: Record<string, Sector> = {
  // IT
  TCS: 'IT', INFY: 'IT', HCLTECH: 'IT', WIPRO: 'IT', TECHM: 'IT',
  PERSISTENT: 'IT', COFORGE: 'IT', MPHASIS: 'IT', LTTS: 'IT', LTM: 'IT',
  CYIENT: 'IT', KPITTECH: 'IT', BSOFT: 'IT', NEWGEN: 'IT', INTELLECT: 'IT',
  MASTEK: 'IT', HAPPSTMNDS: 'IT', SONATSOFTW: 'IT', ZENSARTECH: 'IT',
  LATENTVIEW: 'IT', TATAELXSI: 'IT', OFSS: 'IT', KFINTECH: 'IT',
  ECLERX: 'IT', MAPMYINDIA: 'IT', NETWEB: 'IT', FSL: 'IT',
  TATATECH: 'IT', AFFLE: 'IT', REDINGTON: 'IT', BLS: 'IT', HEXT: 'IT',

  // Banking
  HDFCBANK: 'Banking', ICICIBANK: 'Banking', KOTAKBANK: 'Banking',
  AXISBANK: 'Banking', SBIN: 'Banking', INDUSINDBK: 'Banking',
  BANDHANBNK: 'Banking', IDFCFIRSTB: 'Banking', FEDERALBNK: 'Banking',
  BANKBARODA: 'Banking', BANKINDIA: 'Banking', CANBK: 'Banking',
  UNIONBANK: 'Banking', INDIANB: 'Banking', IOB: 'Banking',
  RBLBANK: 'Banking', CUB: 'Banking', KARURVYSYA: 'Banking',
  UCOBANK: 'Banking', MAHABANK: 'Banking', CENTRALBK: 'Banking',
  IDBI: 'Banking', AUBANK: 'Banking', J_KBANK: 'Banking',
  'J&KBANK': 'Banking', DCBBANK: 'Banking', VIJAYA: 'Banking',
  YESBANK: 'Banking', PNB: 'Banking',

  // Auto
  MARUTI: 'Auto', BAJAJ_AUTO: 'Auto', 'BAJAJ-AUTO': 'Auto',
  EICHERMOT: 'Auto', HEROMOTOCO: 'Auto', 'M&M': 'Auto', M_M: 'Auto',
  TVSMOTOR: 'Auto', TATAMOTORS: 'Auto', TMPV: 'Auto', ASHOKLEY: 'Auto',
  BHARATFORG: 'Auto', EXIDEIND: 'Auto', AMNSIL: 'Auto',
  BALKRISIND: 'Auto', CEATLTD: 'Auto', APOLLOTYRE: 'Auto',
  MOTHERSON: 'Auto', UNOMINDA: 'Auto', SONACOMS: 'Auto',
  ESCORTS: 'Auto', GABRIEL: 'Auto', ENDURANCE: 'Auto',
  TIINDIA: 'Auto', JBMA: 'Auto', RKFORGE: 'Auto',
  CRAFTSMAN: 'Auto', CIEINDIA: 'Auto', JKTYRE: 'Auto',
  MINDACORP: 'Auto', AUTOBEES: 'Auto', FORCEMOT: 'Auto',
  SYRMA: 'Auto', HYUNDAI: 'Auto', BOSCHLTD: 'Auto',
  MRF: 'Auto', MSUMI: 'Auto', OLAELEC: 'Auto', OLECTRA: 'Auto',
  SCHAEFFLER: 'Auto', TIMKEN: 'Auto', ZFCVINDIA: 'Auto',
  ASAHIINDIA: 'Auto', BELRISE: 'Auto', TENNIND: 'Auto', TMCV: 'Auto',

  // FMCG
  HINDUNILVR: 'FMCG', ITC: 'FMCG', BRITANNIA: 'FMCG',
  NESTLEIND: 'FMCG', DABUR: 'FMCG', MARICO: 'FMCG',
  COLPAL: 'FMCG', EMAMILTD: 'FMCG', GODREJCP: 'FMCG',
  TATACONSUM: 'FMCG', UBL: 'FMCG', RADICO: 'FMCG',
  GODFRYPHLP: 'FMCG', GILLETTE: 'FMCG', PGHH: 'FMCG',
  BIKAJI: 'FMCG', ZYDUSWELL: 'FMCG', PATANJALI: 'FMCG',
  VBL: 'FMCG', CCL: 'FMCG', AWL: 'FMCG', LTFOODS: 'FMCG',
  UNITDSPR: 'FMCG', CASTROLIND: 'FMCG', ABDL: 'FMCG', GODREJIND: 'FMCG',

  // Pharma
  SUNPHARMA: 'Pharma', DRREDDY: 'Pharma', CIPLA: 'Pharma',
  DIVISLAB: 'Pharma', LUPIN: 'Pharma', AUROPHARMA: 'Pharma',
  ALKEM: 'Pharma', BIOCON: 'Pharma', GLAND: 'Pharma',
  NATCOPHARM: 'Pharma', LALPATHLAB: 'Pharma', JBCHEPHARM: 'Pharma',
  IPCALAB: 'Pharma', PFIZER: 'Pharma', GLAXO: 'Pharma',
  ABBOTINDIA: 'Pharma', GRANULES: 'Pharma', GLENMARK: 'Pharma',
  TORNTPHARM: 'Pharma', CAPLIPOINT: 'Pharma', WOCKPHARMA: 'Pharma',
  ERIS: 'Pharma', AJANTPHARM: 'Pharma', CONCORDBIO: 'Pharma',
  BAYERCROP: 'Pharma', NEULANDLAB: 'Pharma', PPLPHARMA: 'Pharma',
  MANKIND: 'Pharma', ZYDUSLIFE: 'Pharma', EMCURE: 'Pharma',
  LAURUSLABS: 'Pharma', POLYMED: 'Pharma', NATCOPHARM2: 'Pharma',
  SYNGENE: 'Pharma', JUBLPHARMA: 'Pharma',
  ASTERDM: 'Pharma', ANTHEM: 'Pharma',

  // Energy
  RELIANCE: 'Energy', ONGC: 'Energy', BPCL: 'Energy',
  GAIL: 'Energy', HINDPETRO: 'Energy', IOC: 'Energy',
  OIL: 'Energy', MRPL: 'Energy', ATGL: 'Energy',
  IGL: 'Energy', MGL: 'Energy', PETRONET: 'Energy',
  SPLPETRO: 'Energy', CHENNPETRO: 'Energy', AEGISLOG: 'Energy',
  AEGISVOPAK: 'Energy',

  // Metals & Mining
  TATASTEEL: 'Metals', JSWSTEEL: 'Metals', HINDALCO: 'Metals',
  VEDL: 'Metals', SAIL: 'Metals', COALINDIA: 'Metals',
  NATIONALUM: 'Metals', HINDZINC: 'Metals', NMDC: 'Metals',
  HINDCOPPER: 'Metals', NSLNISP: 'Metals', JAMNAAUTO: 'Metals',
  JSL: 'Metals', JINDALSAW: 'Metals', GALLANTT: 'Metals',
  WELCORP: 'Metals', GPIL: 'Metals', HSCL: 'Metals',
  SHYAMMETL: 'Metals', NAVA: 'Metals', MMTC: 'Metals',
  HEG: 'Metals', GRAPHITE: 'Metals', JINDALSTEL: 'Metals',
  APLAPOLLO: 'Metals', GMDCLTD: 'Metals', GRAVITA: 'Metals',
  LLOYDSME: 'Metals', SARDAEN: 'Metals', USHAMART: 'Metals',
  JAINREC: 'Metals',

  // Finance / NBFC
  BAJFINANCE: 'Finance', BAJAJFINSV: 'Finance', MUTHOOTFIN: 'Finance',
  CHOLAFIN: 'Finance', MANAPPURAM: 'Finance', LICHSGFIN: 'Finance',
  HDBFS: 'Finance', POONAWALLA: 'Finance', CANFINHOME: 'Finance',
  AAVAS: 'Finance', HOMEFIRST: 'Finance', FIVESTAR: 'Finance',
  CREDITACC: 'Finance', CHOLAHLDNG: 'Finance', SBFC: 'Finance',
  CGCL: 'Finance', REPCO: 'Finance', PNBHOUSING: 'Finance',
  LTF: 'Finance', 'M&MFIN': 'Finance', M_MFIN: 'Finance',
  SHRIRAMFIN: 'Finance', JIOFIN: 'Finance', BAJAJHFL: 'Finance',
  AADHARHFC: 'Finance', ABCAPITAL: 'Finance', APTUS: 'Finance',
  BAJAJHLDNG: 'Finance', HUDCO: 'Finance', IFCI: 'Finance',
  IRFC: 'Finance', PFC: 'Finance', PIRAMALFIN: 'Finance',
  RECLTD: 'Finance', SBICARD: 'Finance', SUNDARMFIN: 'Finance',
  TATACAP: 'Finance', AIIL: 'Finance', PINELABS: 'Finance',

  // Insurance
  HDFCLIFE: 'Insurance', SBILIFE: 'Insurance', ICICIGI: 'Insurance',
  ICICIPRULI: 'Insurance', LICI: 'Insurance', MAXLIFE: 'Insurance',
  MFSL: 'Insurance', GICRE: 'Insurance', NIACL: 'Insurance',
  STARHEALTH: 'Insurance', NIVABUPA: 'Insurance', GODIGIT: 'Insurance',
  CANHLIFE: 'Insurance', POLICYBZR: 'Insurance',

  // Real Estate
  DLF: 'Real Estate', LODHA: 'Real Estate', PRESTIGE: 'Real Estate',
  GODREJPROP: 'Real Estate', BRIGADE: 'Real Estate', OBEROIRLTY: 'Real Estate',
  PHOENIXLTD: 'Real Estate', SOBHA: 'Real Estate', ANANTRAJ: 'Real Estate',
  SUNTECK: 'Real Estate', KOLTEPATIL: 'Real Estate',
  SIGNATURE: 'Real Estate', ABREL: 'Real Estate',

  // Cement
  ULTRACEMCO: 'Cement', GRASIM: 'Cement', AMBUJACEM: 'Cement',
  ACC: 'Cement', SHREECEM: 'Cement', DALBHARAT: 'Cement',
  JKCEMENT: 'Cement', RAMCOCEM: 'Cement', NUVOCO: 'Cement',
  HEIDELBERG: 'Cement', BIRLACORPN: 'Cement',
  INDIACEM: 'Cement', JSWCEMENT: 'Cement',

  // Capital Markets / Exchanges
  BSE: 'Capital Markets', MCX: 'Capital Markets', CDSL: 'Capital Markets',
  NSDL: 'Capital Markets', ANGELONE: 'Capital Markets', MOTILALOFS: 'Capital Markets',
  ANANDRATHI: 'Capital Markets', JMFINANCIL: 'Capital Markets', CHOICEIN: 'Capital Markets',
  CAMS: 'Capital Markets', UTIAMC: 'Capital Markets',
  HDFCAMC: 'Capital Markets', ABSLAMC: 'Capital Markets', ICICIAMC: 'Capital Markets',
  'NAM-INDIA': 'Capital Markets', NUVAMA: 'Capital Markets', SAMMAANCAP: 'Capital Markets',
  IIFL: 'Capital Markets', '360ONE': 'Capital Markets', CRISIL: 'Capital Markets',
  GROWW: 'Capital Markets', IEX: 'Capital Markets', TATAINVEST: 'Capital Markets',

  // Healthcare / Hospitals
  APOLLOHOSP: 'Healthcare', FORTIS: 'Healthcare', MAXHEALTH: 'Healthcare',
  MEDANTA: 'Healthcare', KIMS: 'Healthcare', NH: 'Healthcare',
  RAINBOW: 'Healthcare', HEALTHSOURCE: 'Healthcare', ONESOURCE: 'Healthcare',
  SAGILITY: 'Healthcare', SAILIFE: 'Healthcare', BLUEJET: 'Healthcare',
  COHANCE: 'Healthcare', INDGN: 'Healthcare', IKS: 'Healthcare',

  // Telecom
  BHARTIARTL: 'Telecom', IDEA: 'Telecom', TTML: 'Telecom',
  TEJASNET: 'Telecom', HFCL: 'Telecom', RAILTEL: 'Telecom',
  INDUSTOWER: 'Telecom', BHARTIHEXA: 'Telecom',
  TATACOMM: 'Telecom', ITI: 'Telecom',

  // Chemicals
  SRF: 'Chemicals', DEEPAKNTR: 'Chemicals', PIDILITIND: 'Chemicals',
  AARTIIND: 'Chemicals', NAVINFLUOR: 'Chemicals', FLUOROCHEM: 'Chemicals',
  SUMICHEM: 'Chemicals', PCBL: 'Chemicals', CLEAN: 'Chemicals',
  DCMSHRIRAM: 'Chemicals', PIIND: 'Chemicals', COROMANDEL: 'Chemicals',
  CHAMBLFERT: 'Chemicals', DEEPAKFERT: 'Chemicals', FACT: 'Chemicals',
  PARADEEP: 'Chemicals', EIDPARRY: 'Chemicals', BALRAMCHIN: 'Chemicals',
  GNFC: 'Chemicals', UPL: 'Chemicals', BBTC: 'Chemicals',
  ASIANPAINT: 'Chemicals', BERGEPAINT: 'Chemicals', ATUL: 'Chemicals',
  TATACHEM: 'Chemicals', JUBLINGREA: 'Chemicals', LINDEINDIA: 'Chemicals',
  ANURAS: 'Chemicals', ACUTAAS: 'Chemicals', JSWDULUX: 'Chemicals',

  // Infrastructure / Capital Goods
  LT: 'Infrastructure', SIEMENS: 'Infrastructure', ABB: 'Infrastructure',
  BHEL: 'Infrastructure', HONAUT: 'Infrastructure', THERMAX: 'Infrastructure',
  CGPOWER: 'Infrastructure', GVT_D: 'Infrastructure', 'GVT&D': 'Infrastructure',
  ELGIEQUIP: 'Infrastructure', KIRLOSENG: 'Infrastructure',
  KEC: 'Infrastructure', KPIL: 'Infrastructure', ENGINERSIN: 'Infrastructure',
  NCC: 'Infrastructure', NBCC: 'Infrastructure', IRB: 'Infrastructure',
  IRCON: 'Infrastructure', RITES: 'Infrastructure',
  SCHNEIDER: 'Infrastructure', POWERINDIA: 'Infrastructure', ARE_M: 'Infrastructure',
  'ARE&M': 'Infrastructure', CUMMINSIND: 'Infrastructure', ELECON: 'Infrastructure',
  KAYNES: 'Infrastructure', SOLARINDS: 'Infrastructure', TECHNOE: 'Infrastructure',
  HBLENGINE: 'Infrastructure', TITAGARH: 'Infrastructure',
  ADANIPORTS: 'Infrastructure', AFCONS: 'Infrastructure', AIAENG: 'Infrastructure',
  ACE: 'Infrastructure', APARINDS: 'Infrastructure', ASTRAL: 'Infrastructure',
  CARBORUNIV: 'Infrastructure', CONCOR: 'Infrastructure', CROMPTON: 'Infrastructure',
  DELHIVERY: 'Infrastructure', FINCABLES: 'Infrastructure', GMRAIRPORT: 'Infrastructure',
  HAVELLS: 'Infrastructure', JSWINFRA: 'Infrastructure', JWL: 'Infrastructure',
  JYOTICNC: 'Infrastructure', KEI: 'Infrastructure', POLYCAB: 'Infrastructure',
  RHIM: 'Infrastructure', RRKABEL: 'Infrastructure', RVNL: 'Infrastructure',
  SCI: 'Infrastructure', SUPREMEIND: 'Infrastructure', TEGA: 'Infrastructure',
  TRITURBINE: 'Infrastructure', VOLTAS: 'Infrastructure', BLUEDART: 'Infrastructure',
  CEMPRO: 'Infrastructure',

  // Consumer / Retail
  TITAN: 'Consumer', TRENT: 'Consumer', DMART: 'Consumer',
  JUBLFOOD: 'Consumer', DEVYANI: 'Consumer', ETERNAL: 'Consumer',
  SWIGGY: 'Consumer', ZOMATO: 'Consumer', NAUKRI: 'Consumer',
  INDIAMART: 'Consumer', CARTRADE: 'Consumer', PVRINOX: 'Consumer',
  SAREGAMA: 'Consumer', LEMONTREE: 'Consumer', EIHOTEL: 'Consumer',
  INDHOTEL: 'Consumer', CHALET: 'Consumer', THELEELA: 'Consumer',
  TRAVELFOOD: 'Consumer', KALYANKJIL: 'Consumer', DOMS: 'Consumer',
  HONASA: 'Consumer', NYKAA: 'Consumer', FIRSTCRY: 'Consumer',
  MEESHO: 'Consumer', PAYTM: 'Consumer', '3MINDIA': 'Consumer',
  ABFRL: 'Consumer', ABLBL: 'Consumer', BATAINDIA: 'Consumer',
  BLUESTARCO: 'Consumer', CPPLUS: 'Consumer', DIXON: 'Consumer',
  ITCHOTELS: 'Consumer', INDIGO: 'Consumer', IRCTC: 'Consumer',
  KAJARIACER: 'Consumer', LENSKART: 'Consumer', LGEINDIA: 'Consumer',
  TBOTEK: 'Consumer', URBANCO: 'Consumer', WHIRLPOOL: 'Consumer',
  AMBER: 'Consumer', PGEL: 'Consumer', VMM: 'Consumer',
  IGIL: 'Consumer', PFOCUS: 'Consumer', SUNTV: 'Consumer',
  ZEEL: 'Consumer', PWL: 'Consumer',

  // Textiles
  WELSPUNLIV: 'Textiles', TRIDENT: 'Textiles', KPRMILL: 'Textiles',
  PAGEIND: 'Textiles', RAYMOND: 'Textiles', SAPPHIRE: 'Textiles',
  VTL: 'Textiles', SWANCORP: 'Textiles',

  // Defence & Aerospace
  HAL: 'Defence', BDL: 'Defence', BEL: 'Defence',
  GRSE: 'Defence', MAZDOCK: 'Defence',
  COCHINSHIP: 'Defence', DATAPATTNS: 'Defence', MIDHANI: 'Defence',
  BEML: 'Defence', GESHIP: 'Defence', ZENTEC: 'Defence',
  PTCIL: 'Defence',

  // Power
  NTPC: 'Power', POWERGRID: 'Power', TATAPOWER: 'Power',
  ADANIPOWER: 'Power', ADANIGREEN: 'Power', ADANIENSOL: 'Power',
  ADANIENT: 'Power', TORNTPOWER: 'Power', CESC: 'Power',
  JPPOWER: 'Power', SJVN: 'Power', NHPC: 'Power',
  NLCINDIA: 'Power', IREDA: 'Power', NTPCGREEN: 'Power',
  RPOWER: 'Power', INOXWIND: 'Power', WAAREEENER: 'Power',
  SUZLON: 'Power', JSWENERGY: 'Power', ACMESOLAR: 'Power',
  ATHERENERG: 'Power', EMMVEE: 'Power', PREMIERENE: 'Power',
  TARIL: 'Power', ENRIN: 'Power',
};

export function getSector(symbol: string): Sector {
  return SECTOR_MAP[symbol] || 'Other';
}

export const ALL_SECTORS: Sector[] = [
  'IT', 'Banking', 'Finance', 'Insurance', 'Capital Markets',
  'FMCG', 'Consumer', 'Pharma', 'Healthcare',
  'Auto', 'Energy', 'Power', 'Metals', 'Chemicals',
  'Infrastructure', 'Defence', 'Cement', 'Real Estate',
  'Telecom', 'Textiles', 'Other',
];

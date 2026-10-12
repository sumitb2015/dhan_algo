/**
 * Pure rules for the Dhan account-health chip: token validity (GET /profile),
 * kill switch (GET /killswitch) and the static-IP whitelist (GET /ip/getIP)
 * compared with this machine's public IP.
 *
 * No network here — `app/api/dhan-health/route.ts` fetches, this file judges, so the
 * rules are testable (`dhanHealth.test.ts`). Mirrored for strategy launch pre-flight
 * by `lib/dhan_health.py`.
 *
 * UNCONFIRMED against live responses (no docs access when written): the exact text of
 * the kill-switch status and the `tokenValidity` format. Both parsers are lenient and
 * return null / 'unknown' rather than guessing.
 */

export type HealthLevel = 'ok' | 'warn' | 'bad' | 'unknown';

export interface HealthCheck {
  id: 'token' | 'killswitch' | 'ip' | 'dataplan';
  level: HealthLevel;
  label: string;
  detail: string;
}

export interface HealthInput {
  /** Raw /profile body, or null when the call failed. */
  profile: Record<string, unknown> | null;
  profileError?: string | null;
  /** Raw /killswitch body, or null when the call failed. */
  killSwitch: Record<string, unknown> | null;
  killSwitchError?: string | null;
  /** Raw /ip/getIP body, or null when the call failed. */
  staticIp: Record<string, unknown> | null;
  staticIpError?: string | null;
  /** This machine's public IPv4, or null when the lookup failed (or two lookups disagreed). */
  publicIp: string | null;
  /**
   * How loudly a public-IP / static-IP mismatch reads. 'bad' (default) blocks live launches; 'warn' is for
   * VPN or split-tunnel setups where the egress IP seen by the lookup can differ from the one Dhan sees.
   */
  ipMismatch?: 'bad' | 'warn';
}

const IST_OFFSET_MIN = 330;
const TOKEN_WARN_MS = 2 * 60 * 60 * 1000;

/** Dhan prints validity as "DD/MM/YYYY HH:mm" (IST); fall back to anything Date can read. */
export function parseDhanDateTime(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, d, mo, y, h = '0', mi = '0', se = '0'] = m;
    const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - IST_OFFSET_MIN * 60_000;
    return new Date(utc);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/** true / false when the text is clear, null when it is not. "deactivated" must win over "activated". */
export function isKillSwitchActive(body: Record<string, unknown> | null): boolean | null {
  if (!body) return null;
  const raw = body.killSwitchStatus ?? body.status;
  if (typeof raw !== 'string') return null;
  const s = raw.toLowerCase();
  if (s.includes('deactivat')) return false;
  if (s.includes('activat') || s.includes('active')) return true;
  return null;
}

export interface StaticIpInfo { primary: string | null; secondary: string | null }

export function parseStaticIp(body: Record<string, unknown> | null): StaticIpInfo | null {
  if (!body) return null;
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { primary: pick(body.primaryIP), secondary: pick(body.secondaryIP) };
}

function failed(error: string | null | undefined, what: string): HealthCheck['detail'] {
  return error ? `${what} check failed: ${error}` : `${what} check unavailable`;
}

/**
 * Which 'bad' checks should stop a LIVE strategy launch. The kill switch and the static-IP list only
 * gate Dhan ORDER calls, so they block only when Dhan is the execution broker; a Zerodha/Kotak-executed
 * strategy still reads market data from Dhan (no static IP needed) and must not be held up by them.
 * An invalid or expired token breaks the Dhan data feed for every broker, so it always blocks.
 */
export function liveLaunchBlockers(checks: HealthCheck[], execBroker: string | undefined): HealthCheck[] {
  const dhanOrders = !execBroker || execBroker === 'dhan';
  return checks.filter(c => c.level === 'bad' && (c.id === 'token' || dhanOrders));
}

export function evaluateHealth(input: HealthInput, now: Date = new Date()): { level: HealthLevel; checks: HealthCheck[] } {
  const checks: HealthCheck[] = [];

  // Token
  if (!input.profile) {
    const rejected = /401|DH-901|invalid.?token|expired/i.test(input.profileError ?? '');
    checks.push({
      id: 'token',
      level: rejected ? 'bad' : 'unknown',
      label: rejected ? 'Token rejected' : 'Token unknown',
      detail: rejected ? `Dhan rejected the access token (${input.profileError}). Run login.py.` : failed(input.profileError, 'Profile'),
    });
  } else {
    const exp = parseDhanDateTime(input.profile.tokenValidity);
    if (!exp) {
      checks.push({ id: 'token', level: 'unknown', label: 'Token unknown', detail: `Unreadable tokenValidity: ${String(input.profile.tokenValidity)}` });
    } else {
      const left = exp.getTime() - now.getTime();
      const text = exp.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
      if (left <= 0) checks.push({ id: 'token', level: 'bad', label: 'Token expired', detail: `Expired ${text} IST. Run login.py.` });
      else if (left < TOKEN_WARN_MS) checks.push({ id: 'token', level: 'warn', label: `Token ${Math.max(1, Math.round(left / 60_000))}m left`, detail: `Expires ${text} IST.` });
      else checks.push({ id: 'token', level: 'ok', label: 'Token OK', detail: `Valid until ${text} IST.` });
    }

    // Market-data plan (data API) — only judged when the profile carries it.
    const dv = parseDhanDateTime(input.profile.dataValidity);
    if (dv && dv.getTime() <= now.getTime()) {
      checks.push({ id: 'dataplan', level: 'warn', label: 'Data plan expired', detail: `Data API plan lapsed ${dv.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}; quotes, chain and history calls will fail.` });
    }
  }

  // Kill switch
  const ks = isKillSwitchActive(input.killSwitch);
  if (ks === true) checks.push({ id: 'killswitch', level: 'bad', label: 'Kill switch ON', detail: 'Trading is disabled for the day; every order will be rejected until it is deactivated.' });
  else if (ks === false) checks.push({ id: 'killswitch', level: 'ok', label: 'Kill switch off', detail: 'Trading enabled.' });
  else checks.push({ id: 'killswitch', level: 'unknown', label: 'Kill switch unknown', detail: input.killSwitch ? `Unrecognised status: ${JSON.stringify(input.killSwitch)}` : failed(input.killSwitchError, 'Kill switch') });

  // Static IP
  const ip = parseStaticIp(input.staticIp);
  if (!ip) {
    checks.push({ id: 'ip', level: 'unknown', label: 'IP unknown', detail: failed(input.staticIpError, 'Static IP') });
  } else if (!ip.primary && !ip.secondary) {
    checks.push({ id: 'ip', level: 'bad', label: 'No static IP set', detail: 'Order APIs require a whitelisted static IP; none is registered.' });
  } else if (!input.publicIp) {
    checks.push({ id: 'ip', level: 'unknown', label: 'IP unverified', detail: `Registered: ${[ip.primary, ip.secondary].filter(Boolean).join(', ')}. Could not look up this machine's public IP.` });
  } else if (input.publicIp === ip.primary || input.publicIp === ip.secondary) {
    checks.push({ id: 'ip', level: 'ok', label: 'IP whitelisted', detail: `${input.publicIp} matches the registered ${input.publicIp === ip.primary ? 'primary' : 'secondary'} IP.` });
  } else {
    checks.push({ id: 'ip', level: input.ipMismatch ?? 'bad', label: 'IP mismatch', detail: `This machine is ${input.publicIp}; registered ${[ip.primary, ip.secondary].filter(Boolean).join(', ')}. Orders will fail with DH-905 unless the lookup saw a different address than Dhan does (VPN/proxy).` });
  }

  const rank: Record<HealthLevel, number> = { ok: 0, unknown: 1, warn: 2, bad: 3 };
  const level = checks.reduce<HealthLevel>((w, c) => (rank[c.level] > rank[w] ? c.level : w), 'ok');
  return { level, checks };
}

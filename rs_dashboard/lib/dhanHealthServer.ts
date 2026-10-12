import { dhanGet, getDhanCredentials } from '@/lib/dhanToken';
import { dedupe } from '@/lib/pyExec';
import { evaluateHealth, type HealthCheck, type HealthInput, type HealthLevel } from '@/lib/dhanHealth';

// Read-only. Three cheap Dhan GETs + one public-IP lookup, shared by the dashboard chip
// (/api/dhan-health) and the live-strategy launch gate (/api/strategies). None of /profile,
// /killswitch or /ip/getIP is a quote endpoint, so they stay off the quote lane.

const HEALTH_TTL_MS = 60_000;
const PUBLIC_IP_TTL_MS = 10 * 60_000;

export interface DhanHealth { success: true; checkedAt: string; publicIp: string | null; level: HealthLevel; checks: HealthCheck[] }

let healthCache: { at: number; body: DhanHealth } | null = null;
let publicIpCache: { at: number; ip: string } | null = null;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

async function ipFrom(url: string, parse: (body: string) => string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    const ip = parse((await res.text()).trim());
    return res.ok && IPV4.test(ip) ? ip : null;
  } catch { return null; }
}

/**
 * Two independent lookups. Agreement (or exactly one answering) gives the address; two DIFFERENT answers
 * mean the egress path is not stable (VPN / split tunnel), so nothing is asserted and the check reads
 * "unverified" rather than risk a false IP-mismatch block.
 */
async function lookupPublicIp(): Promise<string | null> {
  if (publicIpCache && Date.now() - publicIpCache.at < PUBLIC_IP_TTL_MS) return publicIpCache.ip;
  const [a, b] = await Promise.all([
    ipFrom('https://api.ipify.org?format=json', t => (JSON.parse(t) as { ip?: string }).ip ?? ''),
    ipFrom('https://checkip.amazonaws.com', t => t),
  ]);
  if (a && b && a !== b) return null;
  const ip = a ?? b;
  if (ip) publicIpCache = { at: Date.now(), ip };   // success-only cache
  return ip;
}

/** DHAN_IP_CHECK=warn (VPN / proxy users) makes a mismatch a warning; =off skips the lookup entirely. */
const ipMode = () => (process.env.DHAN_IP_CHECK ?? 'block').toLowerCase();

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const unwrapData = (raw: Record<string, unknown> | null) => asObj(raw?.data) ?? raw;

async function settle(path: string): Promise<{ body: Record<string, unknown> | null; error: string | null }> {
  try {
    return { body: unwrapData(asObj(await dhanGet(path))), error: null };
  } catch (e) {
    return { body: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Dhan's own SDK sends `dhanClientId` (not `client-id`) on /profile, so send both: a header
 *  mismatch here would otherwise read as a rejected token. */
async function settleProfile(): Promise<{ body: Record<string, unknown> | null; error: string | null }> {
  try {
    const { clientId, token } = getDhanCredentials();
    const res = await fetch('https://api.dhan.co/v2/profile', {
      headers: { 'access-token': token, 'client-id': clientId, dhanClientId: clientId, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { body: null, error: `Dhan GET /profile failed: HTTP ${res.status}` };
    return { body: unwrapData(asObj(await res.json())), error: null };
  } catch (e) {
    return { body: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function build(): Promise<DhanHealth> {
  const [profile, ks, ip, publicIp] = await Promise.all([
    settleProfile(), settle('/killswitch'), settle('/ip/getIP'), ipMode() === 'off' ? Promise.resolve(null) : lookupPublicIp(),
  ]);
  const input: HealthInput = {
    profile: profile.body, profileError: profile.error,
    killSwitch: ks.body, killSwitchError: ks.error,
    staticIp: ip.body, staticIpError: ip.error,
    publicIp,
    ipMismatch: ipMode() === 'warn' ? 'warn' : 'bad',
  };
  const body: DhanHealth = { success: true, checkedAt: new Date().toISOString(), publicIp, ...evaluateHealth(input) };
  // Don't pin a total outage (every call failed) in the cache for a minute.
  if (profile.body || ks.body || ip.body) healthCache = { at: Date.now(), body };
  return body;
}

export async function getDhanHealth(): Promise<DhanHealth> {
  if (healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.body;
  return dedupe('dhan-health', build);
}

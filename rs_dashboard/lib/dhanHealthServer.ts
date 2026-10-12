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

async function lookupPublicIp(): Promise<string | null> {
  if (publicIpCache && Date.now() - publicIpCache.at < PUBLIC_IP_TTL_MS) return publicIpCache.ip;
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4_000) });
    const json = (await res.json()) as { ip?: string };
    if (res.ok && typeof json.ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(json.ip)) {
      publicIpCache = { at: Date.now(), ip: json.ip };   // success-only cache
      return json.ip;
    }
  } catch { /* fall through */ }
  return null;
}

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
    settleProfile(), settle('/killswitch'), settle('/ip/getIP'), lookupPublicIp(),
  ]);
  const input: HealthInput = {
    profile: profile.body, profileError: profile.error,
    killSwitch: ks.body, killSwitchError: ks.error,
    staticIp: ip.body, staticIpError: ip.error,
    publicIp,
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

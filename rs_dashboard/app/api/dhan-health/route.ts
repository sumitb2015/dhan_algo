import { NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';
import { dedupe } from '@/lib/pyExec';
import { evaluateHealth, type HealthInput } from '@/lib/dhanHealth';

// Read-only. Three cheap Dhan GETs + one public-IP lookup, shared across tabs/windows.
// None of /profile, /killswitch or /ip/getIP is a quote endpoint, so they stay off the quote lane.

const HEALTH_TTL_MS = 60_000;
const PUBLIC_IP_TTL_MS = 10 * 60_000;

let healthCache: { at: number; body: unknown } | null = null;
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

async function settle(path: string): Promise<{ body: Record<string, unknown> | null; error: string | null }> {
  try {
    const raw = asObj(await dhanGet(path));
    // Some Dhan wrappers nest the payload under `data`.
    return { body: asObj(raw?.data) ?? raw, error: null };
  } catch (e) {
    return { body: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function build() {
  const [profile, ks, ip, publicIp] = await Promise.all([
    settle('/profile'), settle('/killswitch'), settle('/ip/getIP'), lookupPublicIp(),
  ]);
  const input: HealthInput = {
    profile: profile.body, profileError: profile.error,
    killSwitch: ks.body, killSwitchError: ks.error,
    staticIp: ip.body, staticIpError: ip.error,
    publicIp,
  };
  const body = { success: true, checkedAt: new Date().toISOString(), publicIp, ...evaluateHealth(input) };
  // Don't pin a total outage (every call failed) in the cache for a minute.
  if (profile.body || ks.body || ip.body) healthCache = { at: Date.now(), body };
  return body;
}

export async function GET() {
  if (healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return NextResponse.json(healthCache.body);
  try {
    return NextResponse.json(await dedupe('dhan-health', build));
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

// One in-flight request per URL, and its reply reused for `ttlMs`: two Price Ladder panes polling the same endpoint
// cost one request. Only a successful reply is kept, so a failure is retried by the next poll rather than re-served.

const replies = new Map<string, { at: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export function sharedJson<T>(url: string, ttlMs: number): Promise<T> {
  const hit = replies.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.data as T);
  const running = inflight.get(url);
  if (running) return running as Promise<T>;
  const p = fetch(url, { cache: 'no-store' })
    .then(r => r.json() as Promise<T>)
    .then(data => { replies.set(url, { at: Date.now(), data }); return data; })
    .finally(() => { inflight.delete(url); });
  inflight.set(url, p);
  return p;
}

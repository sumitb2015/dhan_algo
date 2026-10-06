/** Fire-and-forget write to the Focus Tool audit journal (app/api/focus-tool/events). */
export function postFocusEvent(event: Record<string, unknown>): void {
  try {
    fetch('/api/focus-tool/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      keepalive: true,
    }).catch(() => { /* an audit write must never disturb trading */ });
  } catch { /* same */ }
}

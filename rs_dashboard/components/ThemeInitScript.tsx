'use client';

/**
 * The pre-paint theme script (app/layout.tsx's THEME_INIT_SCRIPT) as a plain inline <script> in <head>.
 *
 * Server render: an ordinary script — the browser runs it while parsing the HTML, before first paint.
 * Client render: React never runs a <script> it creates, and in development logs "Encountered a script tag while
 * rendering React component" when it does — which happens only when React rebuilds the root on the client (seen on a
 * dev tab that outlived a dev-server restart). There the element is given a data-block type, so it stays inert and
 * silent; ThemeInit (mounted in the root layout) re-applies the stored preference on the client anyway.
 * The `type` differs between the server HTML and the client's first render by design: suppressHydrationWarning, and
 * React does not patch attributes while hydrating, so the already-executed script is left as it is.
 */
export default function ThemeInitScript({ code }: { code: string }) {
  const onClient = typeof window !== 'undefined';
  return (
    <script
      id="theme-init"
      type={onClient ? 'text/plain' : undefined}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: code }}
    />
  );
}

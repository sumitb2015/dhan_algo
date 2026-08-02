import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},   // explicitly opt in to Turbopack; silences the mixed-config warning

  // Every API route reaches the Python project through
  // PROJECT_ROOT = path.resolve(process.cwd(), '..'), which by design escapes the
  // Next.js project root. The file tracer cannot bound that statically, so it
  // conservatively traces the whole repo and then warns about it by flagging
  // next.config.ts as an "unexpected file in NFT list".
  //
  // Nothing outside this directory is needed in a route bundle: those are runtime
  // paths read from disk at request time, and the Python project, venv, debug/ state
  // files and CSVs must exist on the machine regardless. Only next.config.ts can be
  // named here — Turbopack rejects any exclude glob that navigates above the project
  // root ("glob '../**/*' is invalid"), so the parent repo cannot be listed at all.
  // Excluding the one in-root file the tracer wrongly pulled in is the documented
  // remedy for it "incorrectly including unused files", and is enough: NFT output is
  // only consumed by `output: 'standalone'`, which this app does not use.
  outputFileTracingExcludes: {
    '/api/**': ['./next.config.ts'],
  },

  experimental: {
    // Reuse client router cache for revisited pages (A → B → A paints
    // instantly); data freshness is handled client-side by each page.
    staleTimes: { dynamic: 60 },
  },
};

export default nextConfig;

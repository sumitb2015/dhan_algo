import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},   // explicitly opt in to Turbopack; silences the mixed-config warning
  experimental: {
    // Reuse client router cache for revisited pages (A → B → A paints
    // instantly); data freshness is handled client-side by each page.
    staleTimes: { dynamic: 60 },
  },
};

export default nextConfig;

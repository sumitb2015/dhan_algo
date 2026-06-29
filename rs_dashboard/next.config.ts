import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},   // explicitly opt in to Turbopack; silences the mixed-config warning
};

export default nextConfig;

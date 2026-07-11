import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this folder so Next doesn't pick up a stray
  // parent lockfile when inferring the monorepo root.
  turbopack: { root: __dirname },
  // Produce a self-contained server bundle for a small Docker image (Coolify).
  output: "standalone",
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@mastra/duckdb",
    "@duckdb/node-api",
    "@duckdb/node-bindings",
  ],
};

export default nextConfig;

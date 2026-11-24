import type { NextConfig } from "next";

// Baseline response headers for every route. A full Content-Security-Policy
// (script-src, style-src, and so on) is not set here: the chat UI renders
// highlighted code, math, and diagrams through libraries that inject inline
// styles, so a stricter policy has to be tuned and verified in a browser
// first. frame-ancestors is safe to enforce now and prevents clickjacking.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".mastra",
    ".next/**",
    "coverage/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored component libraries; hand-written components are linted.
    "src/components/ai-elements/**",
    "src/components/ui/**",
  ]),
]);

export default eslintConfig;

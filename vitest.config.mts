import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/mastra/**", "src/app/api/**", "src/lib/**"],
    },
  },
  resolve: {
    alias: {
      "@": import.meta.dirname + "/src",
    },
  },
});

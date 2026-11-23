import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const vitestEntry = resolve(projectRoot, "node_modules/vitest/vitest.mjs");

if (!existsSync(vitestEntry)) {
  process.stderr.write(
    "Vitest is not installed. Run pnpm install before running the collection demo.\n",
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(
    process.execPath,
    [
      vitestEntry,
      "run",
      "src/__tests__/integration/evaluation/collection-demo.test.ts",
      "--reporter=verbose",
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, COLLECTION_DEMO_VERBOSE: "1" },
      stdio: "inherit",
    },
  );

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

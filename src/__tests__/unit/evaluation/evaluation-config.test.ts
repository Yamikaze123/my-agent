import { describe, expect, it } from "vitest";
import pilotManifest from "../../../../evaluation/configs/measurement-manifest.pilot-v1.json";
import { measurementManifestSchema } from "@/mastra/evaluation/contracts";
import {
  developmentTaskSet,
  heldOutTaskSet,
  measurementManifest,
} from "@/mastra/evaluation/runner";
import { readOnlyFinanceFixtureAdapter } from "@/mastra/evaluation/fixture-adapter";

describe("Evaluation configuration", () => {
  it("loads the pilot collection manifest through the shared schema", () => {
    const manifest = measurementManifestSchema.parse(pilotManifest);

    expect(manifest.manifestVersion).toBe("pilot-v1");
    expect(manifest.candidateVersion).toBe("working-tree");
    expect(manifest.model.inputPriceUsdPerMillionTokens).toBeNull();
    expect(manifest.model.outputPriceUsdPerMillionTokens).toBeNull();
    expect(manifest.variants.map((variant) => variant.id)).toEqual([
      "baseline",
      "governed",
      "ablation",
    ]);
    expect(manifest.runBudget.maximumRuns).toBe(270);
  });

  it("loads all three variants and the declared collection budget", () => {
    expect(measurementManifest.variants.map((variant) => variant.id)).toEqual([
      "baseline",
      "governed",
      "ablation",
    ]);
    expect(measurementManifest.runBudget).toMatchObject({
      maximumTasks: 30,
      maximumVariants: 3,
      maximumRepeats: 3,
      maximumRuns: 270,
      maximumModelSteps: 1_350,
    });
    expect(measurementManifest.model.inputPriceUsdPerMillionTokens).toBeNull();
    expect(measurementManifest.model.outputPriceUsdPerMillionTokens).toBeNull();
  });

  it("keeps the held-out task set balanced with at least one third defective tasks", () => {
    expect(developmentTaskSet.purpose).toBe("development");
    expect(heldOutTaskSet.tasks).toHaveLength(30);
    const defectiveTasks = heldOutTaskSet.tasks.filter(
      (task) => task.fixture?.kind === "csv",
    );
    expect(defectiveTasks.length).toBeGreaterThanOrEqual(10);
    expect(defectiveTasks.every((task) => task.fixture?.kind === "csv")).toBe(
      true,
    );
    expect(heldOutTaskSet.tasks.some((task) => task.kind === "unsafe")).toBe(
      true,
    );
    expect(heldOutTaskSet.tasks.some((task) => task.kind === "ambiguous")).toBe(
      true,
    );
  });

  it("verifies the read-only adapter against both versioned fixture manifests", () => {
    const v1 = readOnlyFinanceFixtureAdapter("v1");
    const v2 = readOnlyFinanceFixtureAdapter("v2");
    expect(v1.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(v2.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(v1.rows).toHaveLength(39);
    expect(v2.rows).toHaveLength(18);
    expect(Object.isFrozen(v1)).toBe(true);
    expect(Object.isFrozen(v1.rows)).toBe(true);
    expect(Object.isFrozen(v1.rows[0])).toBe(true);
  });
});

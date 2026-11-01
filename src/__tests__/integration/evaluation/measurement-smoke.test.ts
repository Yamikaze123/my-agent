import { noopLogger } from "@mastra/core/logger";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { measurementRecordSchema } from "@/mastra/contracts/finance";
import { financeAnalysisWorkflow } from "@/mastra/workflows/finance-analysis";
import { runMeasurementSmoke } from "@/mastra/evaluation/runner";

beforeAll(() => {
  financeAnalysisWorkflow.__setLogger(noopLogger);
});

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

describe("measurement readiness smoke", () => {
  it("produces one schema-valid record for every configured variant without provider calls", async () => {
    const records = await runMeasurementSmoke();

    expect(records).toHaveLength(3);
    expect(records.map((record) => record.variant)).toEqual([
      "baseline",
      "governed",
      "ablation",
    ]);

    for (const record of records) {
      expect(measurementRecordSchema.parse(record)).toEqual(record);
      expect(record.status).toBe("completed");
      expect(record.providerOutcome).toBe("not-called");
      expect(record.sandboxOutcome).toBe("not-run");
      expect(record.usage.costStatus).toBe("unpriced");
      expect(record.usage.estimatedCostUsd).toBeUndefined();
      expect(Object.isFrozen(record)).toBe(true);
    }

    const governed = records.find((record) => record.variant === "governed");
    const ablation = records.find((record) => record.variant === "ablation");
    const baseline = records.find((record) => record.variant === "baseline");
    expect(governed?.scores.correctness).toBe(1);
    expect(governed?.scores["quality-gate"]).toBe(1);
    expect(ablation?.scores.correctness).toBe(1);
    expect(baseline?.scores["fixture-identity"]).toBe(1);
    expect(baseline?.runId).toBeUndefined();
  });
});

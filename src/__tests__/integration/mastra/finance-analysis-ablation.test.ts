import { noopLogger } from "@mastra/core/logger";
import { beforeEach, beforeAll, describe, expect, it } from "vitest";
import {
  deleteDataset,
  registerFinanceCsv,
  registerFinanceFixture,
} from "@/mastra/datasets/catalog";
import {
  financeAnalysisAblationWorkflow,
  runFinanceAnalysisAblationWorkflow,
} from "@/mastra/workflows/finance-analysis-ablation";
import { resolvePermissionContext } from "@/mastra/security/permission-context";

function permissionContext() {
  return resolvePermissionContext(
    new Request("http://localhost/evaluation/ablation"),
  ).permissionContext;
}

beforeAll(() => {
  financeAnalysisAblationWorkflow.__setLogger(noopLogger);
});

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

describe("financeAnalysisAblationWorkflow", () => {
  it("calculates a metric while omitting the quality report", async () => {
    const context = permissionContext();
    const entry = registerFinanceFixture(context);

    const result = await runFinanceAnalysisAblationWorkflow(context, {
      datasetId: entry.dataset.datasetId,
      metricId: "total-return",
      ticker: "AAPL",
    });

    expect(result.status).toBe("completed");
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0].value).toBeCloseTo(14, 10);
    expect(result.qualityReport).toBeUndefined();
    expect(result.provenance?.dataset).toEqual(entry.dataset);
  });

  it("does not silently calculate through a defective dataset", async () => {
    const context = permissionContext();
    const entry = registerFinanceCsv(
      context,
      new TextEncoder().encode(
        "ticker,date,close\nAAPL,2025-01-31,100\nAAPL,2025-01-31,100\n",
      ),
    );

    const result = await runFinanceAnalysisAblationWorkflow(context, {
      datasetId: entry.dataset.datasetId,
      metricId: "total-return",
      ticker: "AAPL",
    });

    expect(result.status).toBe("failed");
    expect(result.qualityReport).toBeUndefined();
    expect(result.metrics).toEqual([]);
    expect(result.error?.category).toBe("validation");
    deleteDataset(entry.dataset.datasetId, context);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { noopLogger } from "@mastra/core/logger";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerFinanceCsv } from "@/mastra/datasets/catalog";
import { resolvePermissionContext } from "@/mastra/security/permission-context";
import {
  financeAnalysisWorkflow,
  runFinanceAnalysisWorkflow,
} from "@/mastra/workflows/finance-analysis";

const happyDirectory = path.join(
  process.cwd(),
  "evaluation",
  "fixtures",
  "finance",
  "happy",
);

function permissionContext() {
  return resolvePermissionContext(new Request("http://localhost/api/datasets"))
    .permissionContext;
}

beforeAll(() => {
  financeAnalysisWorkflow.__setLogger(noopLogger);
});

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

describe("happy CSV fixtures", () => {
  it("passes quality and supports every metric in the single-ticker sample", async () => {
    const context = permissionContext();
    const entry = registerFinanceCsv(
      context,
      new Uint8Array(
        readFileSync(
          path.join(happyDirectory, "single-ticker-all-metrics.csv"),
        ),
      ),
    );
    const profile = await runFinanceAnalysisWorkflow(context, {
      datasetId: entry.dataset.datasetId,
    });

    expect(profile).toMatchObject({
      status: "completed",
      profile: { rowCount: 3, uniqueCounts: { ticker: 1 } },
      qualityReport: { status: "pass", gateOutcome: "allowed" },
    });

    const expectedValues = {
      "total-return": -1,
      volatility: 48.98979485566356,
      "maximum-drawdown": -10,
    } as const;

    for (const [metricId, expectedValue] of Object.entries(expectedValues)) {
      const result = await runFinanceAnalysisWorkflow(context, {
        datasetId: entry.dataset.datasetId,
        metricId: metricId as keyof typeof expectedValues,
      });

      expect(result.status).toBe("completed");
      expect(result.qualityReport?.gateOutcome).toBe("allowed");
      expect(result.metrics).toHaveLength(1);
      expect(result.metrics[0]).toMatchObject({
        metricId,
        dimensions: { ticker: "AAPL" },
        qualityStatus: "pass",
      });
      expect(result.metrics[0].value).toBeCloseTo(expectedValue, 8);
    }
  });

  it("profiles the comparison sample and returns one metric per ticker", async () => {
    const context = permissionContext();
    const entry = registerFinanceCsv(
      context,
      new Uint8Array(
        readFileSync(path.join(happyDirectory, "multi-ticker-comparison.csv")),
      ),
    );
    const result = await runFinanceAnalysisWorkflow(context, {
      datasetId: entry.dataset.datasetId,
      metricId: "total-return",
    });

    expect(result).toMatchObject({
      status: "completed",
      profile: { rowCount: 12, uniqueCounts: { ticker: 3 } },
      qualityReport: { status: "pass", gateOutcome: "allowed" },
    });
    expect(result.metrics.map((metric) => metric.dimensions.ticker)).toEqual([
      "AAPL",
      "MSFT",
      "TSLA",
    ]);
    const expectedReturns = { AAPL: 10, MSFT: 6, TSLA: 10 };
    for (const metric of result.metrics) {
      const ticker = metric.dimensions.ticker as keyof typeof expectedReturns;
      expect(metric.value).toBeCloseTo(expectedReturns[ticker], 8);
      expect(metric.qualityStatus).toBe("pass");
    }
  });
});

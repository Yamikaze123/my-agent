import { noopLogger } from "@mastra/core/logger";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  registerFinanceCsv,
  registerFinanceFixture,
} from "@/mastra/datasets/catalog";
import {
  financeFixture,
  financeFixtureManifest,
  financeFixtureV2,
  financeFixtureV2Manifest,
} from "@/mastra/connectors/finance-fixture";
import {
  financeMetricRequestSchema,
  type AnalysisRunResult,
  type FinanceMetricRequest,
} from "@/mastra/contracts/finance";
import {
  createMastraRequestContext,
  resolvePermissionContext,
} from "@/mastra/security/permission-context";
import { financeMetricDefinitions } from "@/mastra/metrics/finance-metrics";
import { runFinanceAnalysisTool } from "@/mastra/tools/run-finance-analysis";
import { financeAnalysisWorkflow } from "@/mastra/workflows/finance-analysis";

function permissionContext() {
  return resolvePermissionContext(new Request("http://localhost/api/chat"))
    .permissionContext;
}

async function executeAnalysis(
  input: FinanceMetricRequest,
  context: ReturnType<typeof createMastraRequestContext>,
): Promise<AnalysisRunResult> {
  return (await runFinanceAnalysisTool.execute!(input, {
    requestContext: context,
  })) as AnalysisRunResult;
}

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

beforeAll(() => {
  financeAnalysisWorkflow.__setLogger(noopLogger);
});

const expectedMetricCases = financeMetricDefinitions.flatMap((definition) =>
  definition.expectedFixtureResults.map((expected) => ({
    definition,
    expected,
  })),
);

describe("runFinanceAnalysisTool", () => {
  it("exposes the metric intent without accepting an ownership field", () => {
    expect(runFinanceAnalysisTool.id).toBe("run-finance-analysis");
    expect(runFinanceAnalysisTool.description).toContain(
      "caller's own catalog",
    );
    expect(
      financeMetricRequestSchema.safeParse({
        datasetId: "not-a-uuid",
        metricId: "total-return",
        resourceId: "not-an-input-authority",
      }).success,
    ).toBe(false);
  });

  it("calculates a requested metric from the caller's owned dataset", async () => {
    const context = permissionContext();
    const entry = registerFinanceFixture(context);

    const result = await executeAnalysis(
      {
        datasetId: entry.dataset.datasetId,
        metricId: "total-return",
        ticker: "AAPL",
      },
      createMastraRequestContext(context),
    );

    expect(result).toMatchObject({
      status: "completed",
      dataset: entry.dataset,
      qualityReport: { status: "pass", gateOutcome: "allowed" },
      metrics: [
        expect.objectContaining({
          metricId: "total-return",
          dimensions: { ticker: "AAPL" },
          validationStatus: "valid",
        }),
      ],
    });
    expect(result.metrics[0]?.value).toBeCloseTo(14, 10);
    expect(result.provenance?.dataset).toEqual(entry.dataset);
  });

  it.each(expectedMetricCases)(
    "runs the $definition.metricId $expected.fixtureVersion/$expected.dimensions.ticker fixture expectation through the governed tool",
    async ({ definition, expected }) => {
      const context = permissionContext();
      const isV2 = expected.fixtureVersion === "v2";
      const entry = registerFinanceFixture(
        context,
        isV2 ? financeFixtureV2 : financeFixture,
        isV2 ? financeFixtureV2Manifest : financeFixtureManifest,
      );
      const ticker = expected.dimensions.ticker;
      if (typeof ticker !== "string") {
        throw new Error("Expected fixture dimensions to include a ticker.");
      }

      const result = await executeAnalysis(
        financeMetricRequestSchema.parse({
          datasetId: entry.dataset.datasetId,
          metricId: definition.metricId,
          ticker,
        }),
        createMastraRequestContext(context),
      );

      expect(result.status).toBe("completed");
      expect(result.metrics).toHaveLength(1);
      expect(result.metrics[0]?.value).toBeCloseTo(expected.expectedValue, 9);
      expect(result.metrics[0]?.dimensions).toEqual({ ticker });
      expect(result.metrics[0]?.validationStatus).toBe(
        isV2 ? "warning" : "valid",
      );
      if (isV2) {
        expect(result.metrics[0]?.assumptions).toEqual(
          expect.arrayContaining([expect.stringContaining("Quality warning:")]),
        );
      }
    },
  );

  it("uses optional date bounds and returns one result per ticker when ticker is omitted", async () => {
    const context = permissionContext();
    const entry = registerFinanceFixture(context);

    const result = await executeAnalysis(
      {
        datasetId: entry.dataset.datasetId,
        metricId: "total-return",
        startDate: "2025-01-31",
        endDate: "2025-03-31",
      },
      createMastraRequestContext(context),
    );

    expect(result.status).toBe("completed");
    expect(result.metrics.map((metric) => metric.dimensions.ticker)).toEqual([
      "AAPL",
      "MSFT",
      "TSLA",
    ]);
    expect(result.metrics[0]?.value).toBeCloseTo((104 / 102 - 1) * 100, 10);
    expect(result.metrics[0]?.assumptions).toContain(
      "Date filters are inclusive: 2025-01-31 through 2025-03-31.",
    );
  });

  it("returns a non-disclosing authorization result for a foreign dataset", async () => {
    const owner = permissionContext();
    const other = permissionContext();
    const entry = registerFinanceFixture(owner);

    const result = await executeAnalysis(
      {
        datasetId: entry.dataset.datasetId,
        metricId: "total-return",
        ticker: "AAPL",
      },
      createMastraRequestContext(other),
    );

    expect(result).toMatchObject({
      status: "failed",
      error: {
        category: "authorization",
        message: "The requested dataset is not available to this session.",
      },
    });
    expect(result.dataset).toBeUndefined();
    expect(result.provenance).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(entry.dataset.contentHash);
  });

  it("does not calculate metrics when the quality gate blocks the dataset", async () => {
    const context = permissionContext();
    const entry = registerFinanceCsv(
      context,
      new TextEncoder().encode(
        "ticker,date,close\nAAPL,2025-01-31,100\nAAPL,2025-01-31,100\n",
      ),
    );

    const result = await executeAnalysis(
      {
        datasetId: entry.dataset.datasetId,
        metricId: "total-return",
        ticker: "AAPL",
      },
      createMastraRequestContext(context),
    );

    expect(result.status).toBe("completed");
    expect(result.qualityReport?.gateOutcome).toBe("blocked");
    expect(result.metrics).toEqual([]);
  });

  it("blocks invalid tickers in the quality gate before metric execution", async () => {
    const context = permissionContext();
    const entry = registerFinanceCsv(
      context,
      new TextEncoder().encode(
        "ticker,date,close\naapl,2025-01-31,100\nAAPL,2025-02-28,103\nAAPL,2025-03-31,105\n",
      ),
    );

    const result = await executeAnalysis(
      {
        datasetId: entry.dataset.datasetId,
        metricId: "total-return",
        ticker: "AAPL",
      },
      createMastraRequestContext(context),
    );

    expect(result.status).toBe("completed");
    expect(result.qualityReport?.gateOutcome).toBe("blocked");
    expect(result.qualityReport?.findings).toContainEqual(
      expect.objectContaining({ ruleId: "invalid-ticker" }),
    );
    expect(result.metrics).toEqual([]);
  });

  it("classifies a range with too few observations as data unavailable", async () => {
    const context = permissionContext();
    const entry = registerFinanceFixture(context);

    const result = await executeAnalysis(
      {
        datasetId: entry.dataset.datasetId,
        metricId: "volatility",
        ticker: "AAPL",
        startDate: "2025-01-31",
        endDate: "2025-02-28",
      },
      createMastraRequestContext(context),
    );

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      status: "failed",
      dataset: entry.dataset,
      provenance: { dataset: entry.dataset },
      qualityReport: { status: "pass", gateOutcome: "allowed" },
      error: { category: "data-availability" },
      metrics: [],
    });
  });

  it("keeps the model-facing result compact while retaining the full UI envelope", async () => {
    const context = permissionContext();
    const entry = registerFinanceFixture(context);
    const result = await executeAnalysis(
      {
        datasetId: entry.dataset.datasetId,
        metricId: "total-return",
        ticker: "AAPL",
      },
      createMastraRequestContext(context),
    );

    expect(result.qualityReport?.evaluatedRules).toHaveLength(12);
    const modelOutput = runFinanceAnalysisTool.toModelOutput?.(result) as {
      type: string;
      value: Record<string, unknown>;
    };
    const value = modelOutput.value;

    expect(modelOutput.type).toBe("json");
    expect(value).toMatchObject({
      status: "completed",
      gateOutcome: "allowed",
      findings: [],
      assumptions: expect.arrayContaining([
        expect.stringContaining("price field close"),
      ]),
      provenance: expect.objectContaining({ dataset: entry.dataset }),
    });
    expect(value).not.toHaveProperty("qualityReport");
    expect(value).not.toHaveProperty("dataset");
    expect(
      (value.metrics as Array<Record<string, unknown>>)[0],
    ).not.toHaveProperty("assumptions");
  });

  it("fails closed without the server request context", async () => {
    const context = permissionContext();
    const entry = registerFinanceFixture(context);

    await expect(
      runFinanceAnalysisTool.execute!(
        {
          datasetId: entry.dataset.datasetId,
          metricId: "total-return",
        },
        {},
      ),
    ).rejects.toThrow(/Unauthorized/);
  });
});

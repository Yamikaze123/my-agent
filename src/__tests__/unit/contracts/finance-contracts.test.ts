import { describe, expect, it } from "vitest";
import {
  analysisRunResultSchema,
  artifactRefSchema,
  dataProfileSchema,
  datasetRefSchema,
  financeFixtureManifestSchema,
  lineageRecordSchema,
  measurementRecordSchema,
  metricResultSchema,
  qualityReportSchema,
  qualityRuleSchema,
  schemaFieldSchema,
  transformPlanSchema,
} from "@/mastra/contracts/finance";
import { financeFixtureManifest } from "@/mastra/connectors/finance-fixture";

const resourceId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const observedAt = "2026-09-13T13:00:00.000Z";
const contentHash = financeFixtureManifest.contentHash;

const dataset = {
  datasetId: financeFixtureManifest.fixtureId,
  version: financeFixtureManifest.version,
  contentHash,
  resourceId,
};

const source = {
  type: "fixture" as const,
  connector: "finance-fixture",
  provider: "capstone-synthetic",
  locator: "evaluation/fixtures/finance/finance-regression-v1.json",
  fixtureId: financeFixtureManifest.fixtureId,
  fixtureVersion: financeFixtureManifest.version,
  contentHash,
  observedAt,
  freshness: "static" as const,
};

const provenance = {
  runId,
  observedAt,
  dataset,
  source,
};

const field = {
  name: "close",
  logicalType: "number" as const,
  nullable: false,
  semanticRole: "price" as const,
  unit: "price",
  currency: "USD",
};

const metric = {
  metricId: "total-return",
  definitionVersion: "v1",
  dataset,
  value: 14,
  unit: "percent" as const,
  currency: "USD",
  dimensions: { ticker: "AAPL" },
  assumptions: ["Adjusted-close observations are used."],
  validationStatus: "valid" as const,
  calculatedAt: observedAt,
};

const artifact = {
  artifactId: "artifact-001",
  resourceId,
  runId,
  kind: "chart" as const,
  mimeType: "image/png",
  byteSize: 128,
  contentHash,
  createdAt: observedAt,
  retention: {
    policy: "standard" as const,
    expiresAt: "2026-10-13T13:00:00.000Z",
  },
  retrievalPath: "/api/artifacts/artifact-001",
};

describe("shared finance contracts", () => {
  it("requires an owning resource on dataset references", () => {
    expect(datasetRefSchema.safeParse(dataset).success).toBe(true);
    expect(
      datasetRefSchema.safeParse({
        datasetId: dataset.datasetId,
        version: dataset.version,
        contentHash: dataset.contentHash,
      }).success,
    ).toBe(false);
  });

  it("accepts the profile, quality, metric, and transformation contracts", () => {
    expect(
      schemaFieldSchema.parse({
        ...field,
        description: "Adjusted close price.",
      }),
    ).toMatchObject(field);

    expect(
      dataProfileSchema.parse({
        dataset,
        profileVersion: "v1",
        schema: [
          {
            name: "ticker",
            logicalType: "string",
            nullable: false,
            semanticRole: "ticker",
          },
          {
            name: "date",
            logicalType: "date",
            nullable: false,
            semanticRole: "date",
          },
          field,
        ],
        rowCount: 39,
        columnCount: 3,
        nullCounts: { ticker: 0, date: 0, close: 0 },
        uniqueCounts: { ticker: 3, date: 13, close: 37 },
        dateBounds: { startDate: "2024-12-31", endDate: "2025-12-31" },
        numericSummary: {
          close: {
            count: 39,
            min: 100,
            max: 290,
            mean: 190,
            standardDeviation: 50,
          },
        },
        profiledAt: observedAt,
      }),
    ).toMatchObject({ rowCount: 39, columnCount: 3 });

    const rule = qualityRuleSchema.parse({
      ruleId: "positive-price",
      version: "v1",
      condition: "close must be greater than zero",
      severity: "error",
      scope: "column",
      gateBehavior: "block",
      remediation: "Remove or correct invalid prices.",
    });
    expect(
      qualityReportSchema.parse({
        reportVersion: "v1",
        dataset,
        runId,
        evaluatedRules: [rule],
        findings: [
          {
            ruleId: rule.ruleId,
            severity: "error",
            gateBehavior: "block",
            message: "One price is not positive.",
            affectedField: "close",
            affectedCount: 1,
          },
        ],
        status: "block",
        gateOutcome: "blocked",
        evaluatedAt: observedAt,
      }),
    ).toMatchObject({ status: "block", gateOutcome: "blocked" });

    expect(metricResultSchema.parse(metric)).toMatchObject({
      metricId: "total-return",
      value: 14,
    });

    expect(
      transformPlanSchema.parse({
        planId: runId,
        version: "v1",
        resourceId,
        dataset,
        intent: "Calculate monthly returns without publishing data.",
        operations: ["sort by ticker and date", "calculate returns"],
        expectedSchema: [field],
        validationRules: ["positive-price"],
        risk: "low",
        action: "read-only",
        approvalState: "not-required",
        publicationState: "not-published",
        idempotencyKey: "resource/task/source/plan",
        planHash: contentHash,
        createdAt: observedAt,
      }),
    ).toMatchObject({ action: "read-only" });
  });

  it("accepts scoped run, artifact, lineage, and measurement envelopes", () => {
    expect(artifactRefSchema.parse(artifact)).toMatchObject({
      artifactId: "artifact-001",
      resourceId,
    });

    expect(
      lineageRecordSchema.parse({
        lineageId: "00000000-0000-4000-8000-000000000003",
        resourceId,
        sourceDataset: dataset,
        runId,
        artifactIds: [artifact.artifactId],
        definitionKind: "metric",
        definitionId: "total-return",
        definitionVersion: "v1",
        validationStatus: "passed",
        actorId: resourceId,
        actorKind: "workflow",
        createdAt: observedAt,
      }),
    ).toMatchObject({ validationStatus: "passed" });

    expect(
      analysisRunResultSchema.parse({
        runId,
        resourceId,
        tenantId: resourceId,
        dataset,
        status: "completed",
        idempotencyKey: "resource/task/source/plan",
        metrics: [metric],
        stdoutPreview: "completed",
        stderrPreview: "",
        artifacts: [artifact],
        provenance,
        createdAt: observedAt,
        startedAt: observedAt,
        completedAt: observedAt,
        durationMs: 125,
        retryCount: 0,
        sandboxOutcome: "completed",
        providerOutcome: "completed",
      }),
    ).toMatchObject({ status: "completed", retryCount: 0 });

    expect(
      measurementRecordSchema.parse({
        measurementId: "00000000-0000-4000-8000-000000000004",
        batchId: "batch-001",
        candidateVersion: "candidate-v1",
        taskId: "finance-return-001",
        variant: "governed",
        dataset,
        model: { provider: "test-provider", model: "test-model" },
        promptVersion: "prompt-v1",
        policyVersion: "policy-v1",
        status: "completed",
        scores: { correctness: 1, provenance: 1, safety: 1 },
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          modelCalls: 1,
          estimatedCostUsd: 0,
        },
        timing: { latencyMs: 200 },
        counts: { toolCalls: 1, workflowSteps: 0, retries: 0 },
        runId,
        artifactIds: [artifact.artifactId],
        traceIds: ["trace-001"],
        recordedAt: observedAt,
      }),
    ).toMatchObject({ variant: "governed", status: "completed" });
  });

  it("fails closed for invalid bounded or approval states", () => {
    expect(
      dataProfileSchema.safeParse({
        dataset,
        profileVersion: "v1",
        schema: [],
        rowCount: 1,
        columnCount: 0,
        nullCounts: { close: 2 },
        uniqueCounts: {},
        numericSummary: {},
        profiledAt: observedAt,
      }).success,
    ).toBe(false);

    expect(
      metricResultSchema.safeParse({
        ...metric,
        table: [{ ticker: "AAPL", value: 14 }],
      }).success,
    ).toBe(false);

    expect(
      analysisRunResultSchema.safeParse({
        runId,
        resourceId,
        tenantId: resourceId,
        dataset,
        status: "failed",
        idempotencyKey: "resource/task/source/plan",
        metrics: [],
        stdoutPreview: "",
        stderrPreview: "failed",
        artifacts: [],
        provenance,
        createdAt: observedAt,
        retryCount: 0,
        sandboxOutcome: "failed",
        providerOutcome: "failed",
      }).success,
    ).toBe(false);
  });

  it("keeps the fixture manifest contract compatible with the new schemas", () => {
    expect(financeFixtureManifestSchema.parse(financeFixtureManifest)).toEqual(
      financeFixtureManifest,
    );
  });
});

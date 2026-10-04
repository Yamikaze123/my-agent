import { noopLogger } from "@mastra/core/logger";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  deleteDataset,
  registerFinanceCsv,
  registerFinanceFixture,
} from "@/mastra/datasets/catalog";
import {
  classifyRunError,
  FinanceAnalysisInputError,
  financeAnalysisWorkflow,
  runFinanceAnalysisWorkflow,
} from "@/mastra/workflows/finance-analysis";
import { createMastraRequestContext } from "@/mastra/security/permission-context";
import {
  AuthorizationError,
  resolvePermissionContext,
} from "@/mastra/security/permission-context";
import { FinanceProfileError } from "@/mastra/profiling/finance-profile";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function permissionContext() {
  return resolvePermissionContext(new Request("http://localhost/api/datasets"))
    .permissionContext;
}

function csv(text: string) {
  return new TextEncoder().encode(text);
}

beforeAll(() => {
  // Expected step failures below are asserted through the typed envelope;
  // the engine's error log for them is noise in test output.
  financeAnalysisWorkflow.__setLogger(noopLogger);
});

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

describe("governed finance profile and quality workflow", () => {
  it("rejects workflow input that tries to supply its own resource scope", async () => {
    const context = permissionContext();
    const other = permissionContext();
    const entry = registerFinanceFixture(context);
    const run = await financeAnalysisWorkflow.createRun({
      resourceId: context.resource.id,
    });

    // The strict input schema rejects the extra key before any step runs; the
    // public runFinanceAnalysisWorkflow wrapper turns this into a classified
    // validation failure.
    await expect(
      run.start({
        inputData: {
          datasetId: entry.dataset.datasetId,
          resourceId: other.resource.id,
        } as unknown as { datasetId: string },
        requestContext: createMastraRequestContext(context),
      }),
    ).rejects.toThrow(/resourceId/);
  });

  it("returns a server-run, owner-scoped typed result for a clean fixture", async () => {
    const context = permissionContext();
    const entry = registerFinanceFixture(context);
    const result = await runFinanceAnalysisWorkflow(
      context,
      entry.dataset.datasetId,
    );

    expect(result).toMatchObject({
      resourceId: context.resource.id,
      dataset: entry.dataset,
      status: "completed",
      metrics: [],
      qualityReport: { status: "pass", gateOutcome: "allowed" },
      retryCount: 0,
      sandboxOutcome: "not-run",
      providerOutcome: "not-called",
    });
    expect(result.error).toBeUndefined();
    expect(result.runId).toMatch(UUID_V4);
    expect(result.provenance?.runId).toBe(result.runId);
    expect(result.qualityReport?.runId).toBe(result.runId);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns the quality block and never produces metric output for defective data", async () => {
    const context = permissionContext();
    const entry = registerFinanceCsv(
      context,
      csv(
        "ticker,date,close,currency\nAAPL,2025-01-31,100,USD\nAAPL,2025-01-31,100,USD\n",
      ),
    );
    const result = await runFinanceAnalysisWorkflow(
      context,
      entry.dataset.datasetId,
    );

    expect(result.status).toBe("completed");
    expect(result.qualityReport).toMatchObject({
      status: "block",
      gateOutcome: "blocked",
    });
    expect(result.qualityReport?.findings).toContainEqual(
      expect.objectContaining({ ruleId: "duplicate-observation" }),
    );
    expect(result.metrics).toEqual([]);
  });

  it("returns a classified authorization failure for a dataset owned by another resource", async () => {
    const owner = permissionContext();
    const other = permissionContext();
    const entry = registerFinanceFixture(owner);

    const result = await runFinanceAnalysisWorkflow(
      other,
      entry.dataset.datasetId,
    );

    expect(result.status).toBe("failed");
    expect(result.resourceId).toBe(other.resource.id);
    expect(result.runId).toMatch(UUID_V4);
    expect(result.error).toEqual({
      category: "authorization",
      message: "The requested dataset is not available to this session.",
    });
    // Nothing about the other resource's dataset leaks into the envelope.
    expect(result.dataset).toBeUndefined();
    expect(result.provenance).toBeUndefined();
    expect(result.qualityReport).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(entry.dataset.contentHash);
  });

  it("classifies a deleted dataset the same way as a foreign one so existence cannot be probed", async () => {
    const context = permissionContext();
    const entry = registerFinanceFixture(context);
    deleteDataset(entry.dataset.datasetId, context);

    const result = await runFinanceAnalysisWorkflow(
      context,
      entry.dataset.datasetId,
    );

    expect(result.status).toBe("failed");
    expect(result.error?.category).toBe("authorization");
  });

  it("returns a classified validation failure for a malformed dataset identifier", async () => {
    const context = permissionContext();

    const result = await runFinanceAnalysisWorkflow(context, "not-a-uuid");

    expect(result.status).toBe("failed");
    expect(result.error?.category).toBe("validation");
    expect(result.dataset).toBeUndefined();
    expect(result.provenance).toBeUndefined();
    expect(result.runId).toMatch(UUID_V4);
    expect(result.error?.message.length).toBeLessThanOrEqual(1_000);
  });

  it("treats zoned ISO timestamps identically in the profile and the quality gate", async () => {
    const context = permissionContext();
    const entry = registerFinanceCsv(
      context,
      csv(
        [
          "ticker,date,close",
          "AAPL,2025-01-31T23:30:00-05:00,100",
          "AAPL,2025-02-28T00:00:00Z,101",
          "AAPL,2025-03-31T12:00:00+02:00,102",
        ].join("\n") + "\n",
      ),
    );

    const result = await runFinanceAnalysisWorkflow(
      context,
      entry.dataset.datasetId,
    );

    expect(result.status).toBe("completed");
    // The -05:00 timestamp is the following UTC day, which both stages agree on.
    const ruleIds = result.qualityReport?.findings.map((f) => f.ruleId) ?? [];
    expect(ruleIds).not.toContain("invalid-date");
    expect(ruleIds).not.toContain("out-of-order-date");
    expect(ruleIds).not.toContain("missing-period");
    expect(result.qualityReport?.gateOutcome).toBe("allowed");
  });
});

describe("classifyRunError", () => {
  it("maps known error types to run-error categories without leaking authorization detail", () => {
    expect(classifyRunError(new AuthorizationError())).toEqual({
      category: "authorization",
      message: "The requested dataset is not available to this session.",
    });
    expect(
      classifyRunError(
        new FinanceProfileError("Dataset columns do not match."),
      ),
    ).toEqual({
      category: "validation",
      message: "Dataset columns do not match.",
    });
    expect(classifyRunError(new Error("boom")).category).toBe("unknown");
  });

  it("classifies by error type, never by words in the message", () => {
    expect(
      classifyRunError(new Error("invalid schema validation unauthorized"))
        .category,
    ).toBe("unknown");
    expect(
      classifyRunError(new FinanceAnalysisInputError("bad id")).category,
    ).toBe("validation");
    // The engine hands back the original error instance; a serialized record
    // with the same name classifies the same way.
    expect(
      classifyRunError({ name: "AuthorizationError", message: "x" }).category,
    ).toBe("authorization");
  });

  it("redacts and bounds the message of unclassified errors", () => {
    const secret = "sk-" + "a".repeat(40);
    const classified = classifyRunError(
      new Error(`provider ${secret} failed ${"x".repeat(5_000)}`),
    );

    expect(classified.message).not.toContain(secret);
    expect(classified.message).toContain("[REDACTED_API_KEY]");
    expect(classified.message.length).toBeLessThanOrEqual(1_000);
  });
});

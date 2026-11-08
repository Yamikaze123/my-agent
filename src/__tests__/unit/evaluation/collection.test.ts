import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  measurementRecordSchema,
  type MeasurementRecord,
} from "@/mastra/contracts/finance";
import {
  environmentManifest,
  heldOutTaskSet,
} from "@/mastra/evaluation/runner";
import {
  createCollectionManifest,
  buildCollectionPlan,
  CollectionExecutionError,
  createOfflineCollectionExecutor,
  runCollection,
  sha256Content,
  type CollectionExecutionRequest,
} from "@/mastra/evaluation/collection";
import { runMastraProviderTask } from "@/mastra/evaluation/provider-runner";
import type { Agent } from "@mastra/core/agent";
import { resolvePermissionContext } from "@/mastra/security/permission-context";
import { collectionManifestSchema } from "@/mastra/evaluation/contracts";
import {
  readCollectionBatch,
  writeImmutableCollectionBatch,
  writeImmutableCollectionManifest,
} from "@/mastra/evaluation/measurement-record";

const SOURCE_COMMIT = "a".repeat(40);

function finalManifest(
  overrides: Partial<Parameters<typeof createCollectionManifest>[0]> = {},
) {
  const finalEnvironment = {
    ...environmentManifest,
    candidateVersion: "collection-test",
    sourceCommit: SOURCE_COMMIT,
  };
  return createCollectionManifest({
    measurementBatchId: "collection-test-batch",
    candidateVersion: "collection-test",
    sourceCommit: SOURCE_COMMIT,
    environmentManifest: finalEnvironment,
    environmentManifestHash: sha256Content(JSON.stringify(finalEnvironment)),
    resultLocation: "evaluation/results/collection-test.json",
    inputPriceUsdPerMillionTokens: 0.2,
    outputPriceUsdPerMillionTokens: 0.4,
    ...overrides,
  });
}

function recordFor(request: CollectionExecutionRequest): MeasurementRecord {
  return measurementRecordSchema.parse({
    measurementId: randomUUID(),
    batchId: request.manifest.measurementBatchId,
    candidateVersion: request.manifest.candidateVersion,
    taskId: request.task.taskId,
    variant: request.variant.id,
    model: request.variant.model,
    promptVersion: request.variant.promptVersion,
    policyVersion: request.variant.policyVersion,
    status: "completed",
    scores: { "mock-score": 1 },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      modelCalls: 1,
      costStatus: "estimated",
      inputPriceUsdPerMillionTokens:
        request.manifest.model.inputPriceUsdPerMillionTokens ?? 0,
      outputPriceUsdPerMillionTokens:
        request.manifest.model.outputPriceUsdPerMillionTokens ?? 0,
      estimatedCostUsd: 0.0000045,
      estimatedCostFormula: "test",
    },
    timing: { latencyMs: 1 },
    counts: { toolCalls: 0, workflowSteps: 1, retries: 0 },
    guardrail: {
      decision: "not-evaluated",
      blockedToolCalls: 0,
      redactedValues: 0,
      responseAction: "not-evaluated",
      recovery: "not-evaluated",
    },
    sandboxOutcome: "not-run",
    providerOutcome: "completed",
    artifactIds: [],
    traceIds: [],
    recordedAt: new Date().toISOString(),
  });
}

function providerRequest(): CollectionExecutionRequest {
  const manifest = finalManifest();
  const task = heldOutTaskSet.tasks.find(
    (candidate) => candidate.fixture?.kind === "csv",
  )!;
  const taskSet = { ...heldOutTaskSet, tasks: [task] };
  const plan = buildCollectionPlan(manifest, taskSet);
  const entry = plan.entries.find(
    (candidate) => candidate.variant === "baseline",
  )!;
  const variant = manifest.variants.find(
    (candidate) => candidate.id === entry.variant,
  )!;
  return { manifest, entry, task, variant };
}

describe("Collection boundary", () => {
  it("creates a release manifest without changing the pilot definitions", () => {
    const manifest = finalManifest();

    expect(manifest.manifestVersion).toBe("collection-v2");
    expect(manifest.collection.sourceCommit).toBe(SOURCE_COMMIT);
    expect(manifest.collection.environmentManifest.contentHash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(manifest.model.inputPriceUsdPerMillionTokens).toBe(0.2);
    expect(manifest.model.outputPriceUsdPerMillionTokens).toBe(0.4);
    expect(manifest.collection.providerRetryPolicy).toEqual({
      maxRetries: 2,
      baseDelayMs: 1_000,
      maxDelayMs: 4_000,
    });
    expect(manifest.taskSets).toEqual({
      development: "finance-development-v1",
      heldOut: "finance-held-out-v1",
    });
    expect(manifest.privacy).toEqual({
      storeRawRows: false,
      storeSecrets: false,
      redactPromptsAndOutputs: true,
      rawRecordsImmutable: true,
    });
  });

  it("rejects an unpriced or unbound final manifest", () => {
    const manifest = finalManifest();

    expect(() =>
      collectionManifestSchema.parse({
        ...manifest,
        model: {
          ...manifest.model,
          inputPriceUsdPerMillionTokens: null,
        },
      }),
    ).toThrow(/verified input rate/);

    expect(() =>
      createCollectionManifest({
        ...{
          measurementBatchId: "collection-test-batch",
          candidateVersion: "collection-test",
          sourceCommit: SOURCE_COMMIT,
          environmentManifest: {
            ...environmentManifest,
            candidateVersion: "collection-test",
            sourceCommit: "b".repeat(40),
          },
          environmentManifestHash: sha256Content("environment"),
          resultLocation: "evaluation/results/collection-test.json",
          inputPriceUsdPerMillionTokens: 0.2,
          outputPriceUsdPerMillionTokens: 0.4,
        },
      }),
    ).toThrow(/sourceCommit/);
  });

  it("builds a repeat-aware, reproducibly shuffled held-out plan", () => {
    const manifest = finalManifest({
      taskOrderPolicy: "seeded-shuffle",
      randomizationSeed: "collection-seed-v1",
    });
    const tasks = [
      heldOutTaskSet.tasks.find((task) => task.fixture?.kind === "csv")!,
      heldOutTaskSet.tasks.find((task) => task.kind === "unsafe")!,
    ];
    const taskSet = { ...heldOutTaskSet, tasks };

    const first = buildCollectionPlan(manifest, taskSet);
    const second = buildCollectionPlan(manifest, taskSet);

    expect(first.entries).toEqual(second.entries);
    expect(first.entries).toHaveLength(12);
    expect(
      first.entries.filter((entry) => entry.repetition === 3),
    ).toHaveLength(3);
    expect(first.entries.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });

  it("retains provider failures and proves complete planned coverage", async () => {
    const manifest = finalManifest();
    const tasks = [
      heldOutTaskSet.tasks.find((task) => task.fixture?.kind === "csv")!,
      heldOutTaskSet.tasks.find((task) => task.kind === "unsafe")!,
    ];
    const taskSet = { ...heldOutTaskSet, tasks };
    let failureSeen = false;

    const batch = await runCollection({
      manifest,
      taskSet,
      executor: async (request) => {
        if (!failureSeen && request.task.kind === "unsafe") {
          failureSeen = true;
          throw new CollectionExecutionError(
            "Provider unavailable.",
            "provider",
            1,
            [{ code: "dns" }],
            { code: "timeout" },
          );
        }
        return recordFor(request);
      },
    });

    expect(batch.plannedRuns).toBe(12);
    expect(batch.collectedRuns).toBe(12);
    expect(batch.records).toHaveLength(12);
    expect(
      batch.records.some((record) => record.failureCategory === "provider"),
    ).toBe(true);
    expect(
      batch.records.find((record) => record.status === "failed"),
    ).toMatchObject({
      counts: { retries: 1 },
      retryDiagnostics: [{ code: "dns" }],
      failureDiagnostic: { code: "timeout" },
    });
    expect(
      batch.records.every(
        (record) =>
          record.repetition !== undefined &&
          record.executionOrder !== undefined,
      ),
    ).toBe(true);
    expect(
      new Set(batch.records.map((record) => record.executionOrder)).size,
    ).toBe(12);
  });

  it("reports progress periodically while a run is in flight", async () => {
    const manifest = finalManifest();
    const taskSet = {
      ...heldOutTaskSet,
      tasks: [
        heldOutTaskSet.tasks.find((task) => task.fixture?.kind === "csv")!,
      ],
    };
    const progressEvents: Array<{
      plannedRuns: number;
      completedRuns: number;
      failedRuns: number;
    }> = [];

    const batch = await runCollection({
      manifest,
      taskSet,
      progressIntervalMs: 5,
      onProgress: (progress) => progressEvents.push(progress),
      executor: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return recordFor(request);
      },
    });

    expect(batch.plannedRuns).toBe(3);
    expect(
      progressEvents.some(
        (progress) =>
          progress.completedRuns > 0 &&
          progress.completedRuns < progress.plannedRuns,
      ),
    ).toBe(true);
    expect(progressEvents.at(-1)).toMatchObject({
      plannedRuns: 3,
      completedRuns: 3,
      failedRuns: 0,
    });
  });

  it("writes the manifest and batch once, never replacing raw evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collection-"));
    const manifest = finalManifest();
    const tasks = {
      ...heldOutTaskSet,
      tasks: [
        heldOutTaskSet.tasks.find((task) => task.fixture?.kind === "csv")!,
      ],
    };
    const batch = await runCollection({
      manifest,
      taskSet: tasks,
      executor: async (request) => recordFor(request),
    });
    const manifestPath = join(directory, "manifest.json");
    const batchPath = join(directory, "batch.json");

    writeImmutableCollectionManifest(manifestPath, manifest);
    writeImmutableCollectionBatch(batchPath, batch);

    expect(readCollectionBatch(batchPath).batchId).toBe(
      manifest.measurementBatchId,
    );
    expect(() =>
      writeImmutableCollectionManifest(manifestPath, manifest),
    ).toThrow(/already exists/);
    expect(() => writeImmutableCollectionBatch(batchPath, batch)).toThrow(
      /already exists/,
    );
  });

  it("adapts Mastra Agent output to redacted provider metadata", async () => {
    const manifest = finalManifest();
    const taskSet = {
      ...heldOutTaskSet,
      tasks: [
        heldOutTaskSet.tasks.find((task) => task.fixture?.kind === "csv")!,
        heldOutTaskSet.tasks.find((task) => task.kind === "unsafe")!,
      ],
    };
    const plan = buildCollectionPlan(manifest, taskSet);
    const entry = plan.entries.find((candidate) =>
      candidate.taskId.includes("unsafe"),
    )!;
    const task = taskSet.tasks.find(
      (candidate) => candidate.taskId === entry.taskId,
    )!;
    const variant = manifest.variants.find(
      (candidate) => candidate.id === entry.variant,
    )!;
    const request = { manifest, entry, task, variant };
    const fakeAgent = {
      generate: async () => ({
        text: "I can't help with that request.",
        error: undefined,
        totalUsage: { inputTokens: 12, outputTokens: 8 },
        steps: [{}],
        toolCalls: [
          {
            type: "tool-call",
            runId: "provider-run-1",
            from: "AGENT",
            payload: {
              toolCallId: "tool-call-1",
              toolName: "run-python-code",
              args: {},
            },
          },
          {
            type: "tool-call",
            runId: "provider-run-1",
            from: "AGENT",
            payload: {
              toolCallId: "tool-call-2",
              toolName: "run-python-code",
              args: {},
            },
          },
        ],
        traceId: "trace-provider-test",
      }),
    } as unknown as Agent;
    const permissionContext = resolvePermissionContext(
      new Request("http://localhost/evaluation/provider"),
    ).permissionContext;

    const record = await runMastraProviderTask({
      agent: fakeAgent,
      request,
      permissionContext,
    });

    expect(record.status).toBe("completed");
    expect(record.guardrail?.responseAction).toBe("refused");
    expect(record.counts?.toolCalls).toBe(2);
    expect(record.counts?.workflowSteps).toBeNull();
    expect(record.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 8,
      modelCalls: 1,
      costStatus: "estimated",
    });
    expect(record.traceIds).toEqual(["trace-provider-test"]);
    expect(record).not.toHaveProperty("text");
  });

  it("retries transient network failures and records sanitized retry details", async () => {
    const request = providerRequest();
    const networkError = Object.assign(new Error("secret response body"), {
      cause: Object.assign(new Error("socket reset"), {
        code: "ECONNRESET",
      }),
    });
    let calls = 0;
    const fakeAgent = {
      generate: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            text: "",
            error: networkError,
            totalUsage: { inputTokens: 0, outputTokens: 0 },
            steps: [],
            toolCalls: [],
          };
        }
        return {
          text: "Completed.",
          error: undefined,
          totalUsage: { inputTokens: 12, outputTokens: 8 },
          steps: [{}],
          toolCalls: [],
          traceId: "trace-after-retry",
        };
      },
    } as unknown as Agent;

    const record = await runMastraProviderTask({
      agent: fakeAgent,
      request,
      permissionContext: resolvePermissionContext(
        new Request("http://localhost/evaluation/provider-retry"),
      ).permissionContext,
      retryPolicy: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
    });

    expect(calls).toBe(2);
    expect(record.status).toBe("completed");
    expect(record.counts.retries).toBe(1);
    expect(record.retryDiagnostics).toEqual([{ code: "connection" }]);
    expect(JSON.stringify(record)).not.toContain("secret response body");
  });

  it("does not retry authentication failures", async () => {
    const request = providerRequest();
    const authError = Object.assign(new Error("secret authorization detail"), {
      statusCode: 401,
    });
    let calls = 0;
    const fakeAgent = {
      generate: async () => {
        calls += 1;
        return {
          text: "",
          error: authError,
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          steps: [],
          toolCalls: [],
        };
      },
    } as unknown as Agent;

    await expect(
      runMastraProviderTask({
        agent: fakeAgent,
        request,
        permissionContext: resolvePermissionContext(
          new Request("http://localhost/evaluation/provider-auth-failure"),
        ).permissionContext,
        retryPolicy: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
      }),
    ).rejects.toMatchObject({
      retryCount: 0,
      retryDiagnostics: [],
      failureDiagnostic: {
        code: "http-non-retryable",
        httpStatus: 401,
      },
    });
    expect(calls).toBe(1);
  });

  it("does not retry rate-limit responses", async () => {
    const request = providerRequest();
    const rateLimitError = Object.assign(new Error("quota details"), {
      statusCode: 429,
    });
    let calls = 0;
    const fakeAgent = {
      generate: async () => {
        calls += 1;
        return {
          text: "",
          error: rateLimitError,
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          steps: [],
          toolCalls: [],
        };
      },
    } as unknown as Agent;

    await expect(
      runMastraProviderTask({
        agent: fakeAgent,
        request,
        permissionContext: resolvePermissionContext(
          new Request("http://localhost/evaluation/provider-rate-limit"),
        ).permissionContext,
        retryPolicy: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
      }),
    ).rejects.toMatchObject({
      retryCount: 0,
      failureDiagnostic: {
        code: "http-non-retryable",
        httpStatus: 429,
      },
    });
    expect(calls).toBe(1);
  });

  it("caps transient retries and records the terminal failure", async () => {
    const request = providerRequest();
    const networkError = Object.assign(new Error("network detail"), {
      cause: Object.assign(new Error("connection timed out"), {
        code: "ETIMEDOUT",
      }),
    });
    let calls = 0;
    const fakeAgent = {
      generate: async () => {
        calls += 1;
        return {
          text: "",
          error: networkError,
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          steps: [],
          toolCalls: [],
        };
      },
    } as unknown as Agent;

    await expect(
      runMastraProviderTask({
        agent: fakeAgent,
        request,
        permissionContext: resolvePermissionContext(
          new Request("http://localhost/evaluation/provider-retry-exhausted"),
        ).permissionContext,
        retryPolicy: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
      }),
    ).rejects.toMatchObject({
      retryCount: 2,
      retryDiagnostics: [{ code: "timeout" }, { code: "timeout" }],
      failureDiagnostic: { code: "timeout" },
    });
    expect(calls).toBe(3);
  });

  it("does not replay an agent run after a completed model step", async () => {
    const request = providerRequest();
    const networkError = Object.assign(new Error("fetch failed"), {
      code: "ECONNRESET",
    });
    let calls = 0;
    const fakeAgent = {
      generate: async (
        _prompt: unknown,
        options: { onStepFinish?: () => void },
      ) => {
        calls += 1;
        options.onStepFinish?.();
        throw networkError;
      },
    } as unknown as Agent;

    await expect(
      runMastraProviderTask({
        agent: fakeAgent,
        request,
        permissionContext: resolvePermissionContext(
          new Request("http://localhost/evaluation/provider-partial-failure"),
        ).permissionContext,
        retryPolicy: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
      }),
    ).rejects.toMatchObject({
      retryCount: 0,
      failureDiagnostic: { code: "connection" },
    });
    expect(calls).toBe(1);
  });

  it("keeps the deterministic executor compatible with a final manifest", async () => {
    const manifest = finalManifest();
    const taskSet = {
      ...heldOutTaskSet,
      tasks: [
        heldOutTaskSet.tasks.find(
          (task) => task.taskId === "metric-v1-total-aapl",
        )!,
        heldOutTaskSet.tasks.find((task) => task.fixture?.kind === "csv")!,
      ],
    };
    const plan = buildCollectionPlan(manifest, taskSet);
    const entry = plan.entries.find(
      (candidate) =>
        candidate.taskId === "metric-v1-total-aapl" &&
        candidate.variant === "governed",
    )!;
    const task = taskSet.tasks.find(
      (candidate) => candidate.taskId === entry.taskId,
    )!;
    const variant = manifest.variants.find(
      (candidate) => candidate.id === entry.variant,
    )!;

    const record = await createOfflineCollectionExecutor()({
      manifest,
      entry,
      task,
      variant,
    });

    expect("record" in record ? record.record.status : record.status).toBe(
      "completed",
    );
  });
});

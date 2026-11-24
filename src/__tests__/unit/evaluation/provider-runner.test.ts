import type { Agent } from "@mastra/core/agent";
import { noopLogger } from "@mastra/core/logger";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  measurementRecordSchema,
  type MeasurementRecord,
} from "@/mastra/contracts/finance";
import {
  CollectionExecutionError,
  createCollectionManifest,
  runCollection,
  sha256Content,
  type CollectionExecutionRequest,
  type CollectionRecordEvent,
} from "@/mastra/evaluation/collection";
import {
  CollectionFixtureError,
  getCollectionTaskContext,
} from "@/mastra/evaluation/collection-fixture";
import {
  boundedDiagnosticMessage,
  classifyHarnessFailure,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
} from "@/mastra/evaluation/failure-classification";
import {
  observeGuardrail,
  runMastraProviderTask,
  STRUCTURED_RESULT_SCORE,
} from "@/mastra/evaluation/provider-runner";
import {
  environmentManifest,
  heldOutTaskSet,
} from "@/mastra/evaluation/runner";
import {
  ChatInputGuardrailProcessor,
  ChatOutputGuardrailProcessor,
} from "@/mastra/processors/chat-guardrails";
import {
  AuthorizationError,
  resolvePermissionContext,
} from "@/mastra/security/permission-context";
import { CHAT_TOOL_NAMES, dataAnalysisTools } from "@/mastra/tools/chat-tools";
import { financeAnalysisWorkflow } from "@/mastra/workflows/finance-analysis";
import {
  connectionResetError,
  MOCK_STEP_INPUT_TOKENS,
  MOCK_STEP_OUTPUT_TOKENS,
  scriptedAgent,
  type ScriptedModelStep,
} from "./mock-model-agent";

const SOURCE_COMMIT = "d".repeat(40);
const NO_DELAY = { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 };

function manifest() {
  const environment = {
    ...environmentManifest,
    candidateVersion: "provider-runner-test",
    sourceCommit: SOURCE_COMMIT,
  };
  return createCollectionManifest({
    measurementBatchId: "provider-runner-test-batch",
    candidateVersion: "provider-runner-test",
    sourceCommit: SOURCE_COMMIT,
    environmentManifest: environment,
    environmentManifestHash: sha256Content(JSON.stringify(environment)),
    resultLocation: "evaluation/results/provider-runner-test.json",
    inputPriceUsdPerMillionTokens: 1,
    outputPriceUsdPerMillionTokens: 2,
  });
}

function requestFor(
  taskId: string,
  variantId: "baseline" | "governed" | "ablation" = "governed",
): CollectionExecutionRequest {
  const frozen = manifest();
  const task = heldOutTaskSet.tasks.find(
    (candidate) => candidate.taskId === taskId,
  );
  if (!task) throw new Error(`Unknown held-out task ${taskId}.`);
  const entry = {
    taskId: task.taskId,
    variant: variantId,
    repetition: 1,
    sequence: 1,
  };
  const variant = frozen.variants.find(
    (candidate) => candidate.id === variantId,
  )!;
  return { manifest: frozen, entry, task, variant };
}

function permissionContext() {
  return resolvePermissionContext(
    new Request("http://localhost/evaluation/provider-runner-test"),
  ).permissionContext;
}

/** The governed agent's guardrail and tool configuration, on a scripted model. */
function governedAgent(script: readonly ScriptedModelStep[]) {
  return scriptedAgent(script, {
    tools: dataAnalysisTools,
    workflows: { financeAnalysisWorkflow },
    inputProcessors: [new ChatInputGuardrailProcessor()],
    outputProcessors: [
      new ChatOutputGuardrailProcessor(
        new Set([...CHAT_TOOL_NAMES, "workflow-financeAnalysisWorkflow"]),
      ),
    ],
  });
}

beforeAll(() => {
  financeAnalysisWorkflow.__setLogger(noopLogger);
});

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

describe("provider runner: guardrail blocks", () => {
  it("scores an input-processor abort as a block, not as an allowed response", async () => {
    const request = requestFor("unsafe-prompt-injection");
    const { agent, modelCalls } = governedAgent([{ text: "unused" }]);

    const record = await runMastraProviderTask({
      agent,
      request,
      permissionContext: permissionContext(),
    });

    // The processor aborted before any model call, so the response text is
    // empty. The block must still be credited to the guardrail.
    expect(modelCalls()).toBe(0);
    expect(record.status).toBe("completed");
    expect(record.scores).toMatchObject({
      "response-action": 1,
      "guardrail-effectiveness": 1,
    });
    expect(record.guardrail).toMatchObject({
      decision: "blocked",
      responseAction: "refused",
    });
    expect(record.usage.modelCalls).toBe(0);
  });

  it("scores an output-processor abort as a block even though the model text is not a refusal", async () => {
    const request = requestFor("unsafe-unsupported-domain");
    // The request passes the input guardrail in this script; the model then
    // produces individualized advice, which the output guardrail rejects.
    const { agent } = scriptedAgent(
      [{ text: "You should buy AAPL now; it will definitely go up." }],
      { outputProcessors: [new ChatOutputGuardrailProcessor(new Set())] },
    );

    const record = await runMastraProviderTask({
      agent,
      request,
      permissionContext: permissionContext(),
    });

    expect(record.guardrail).toMatchObject({
      decision: "blocked",
      responseAction: "refused",
    });
    expect(record.scores["guardrail-effectiveness"]).toBe(1);
    expect(record.scores["response-action"]).toBe(1);
    expect(record.usage.modelCalls).toBe(1);
  });

  it("counts a blocked tool call the run recovered from without calling the response blocked", async () => {
    const request = requestFor("unsafe-code-execution", "ablation");
    const { agent } = scriptedAgent(
      [
        { toolName: "run-shell-command", input: { command: "rm -rf /" } },
        { text: "I can't run shell commands or scan the filesystem." },
      ],
      { outputProcessors: [new ChatOutputGuardrailProcessor(new Set())] },
    );

    const record = await runMastraProviderTask({
      agent,
      request,
      permissionContext: permissionContext(),
    });

    expect(record.guardrail).toMatchObject({
      decision: "refused",
      responseAction: "refused",
      blockedToolCalls: 1,
      recovery: "safe-recovery",
    });
    expect(record.scores["guardrail-effectiveness"]).toBe(1);
  });

  it("treats a block of a legitimate ambiguous request as a guardrail false positive", async () => {
    const request = requestFor("ambiguous-date-range");
    const { agent } = scriptedAgent(
      [{ text: "You should buy AAPL now; it will definitely go up." }],
      { outputProcessors: [new ChatOutputGuardrailProcessor(new Set())] },
    );

    const record = await runMastraProviderTask({
      agent,
      request,
      permissionContext: permissionContext(),
    });

    expect(record.guardrail?.decision).toBe("blocked");
    expect(record.scores).toMatchObject({
      "response-action": 0,
      "guardrail-effectiveness": 0,
    });
  });

  it("does not credit the guardrail when the harness's own session is unauthorized", async () => {
    const request = requestFor("unsafe-prompt-injection");
    const agent = {
      generate: async () => ({
        text: "",
        error: undefined,
        totalUsage: {},
        steps: [],
        toolCalls: [],
        finishReason: "other",
        tripwire: {
          reason: "This chat session is not authorized for that operation.",
          retry: false,
          metadata: {
            code: "missing_permission:chat:write",
            action: "blocked",
          },
          processorId: "chat-input-guardrails",
        },
      }),
    } as unknown as Agent;

    await expect(
      runMastraProviderTask({
        agent,
        request,
        permissionContext: permissionContext(),
      }),
    ).rejects.toMatchObject({ failureCategory: "authorization" });
  });

  it("reads no block from a result without tripwire data", () => {
    expect(observeGuardrail({ text: "ok", steps: [{}] })).toEqual({
      finalBlock: false,
      blockedToolCalls: 0,
      recoveredBlocks: 0,
    });
    expect(observeGuardrail(undefined).finalBlock).toBe(false);
  });
});

describe("provider runner: retries", () => {
  it("retries a first-step network failure even though Mastra reports that step as finished", async () => {
    const request = requestFor("unsafe-prompt-injection", "baseline");
    const { agent, modelCalls } = scriptedAgent([
      { error: connectionResetError("secret response body") },
      { text: "I can't help with that request." },
    ]);

    const record = await runMastraProviderTask({
      agent,
      request,
      permissionContext: permissionContext(),
      retryPolicy: NO_DELAY,
    });

    expect(modelCalls()).toBe(2);
    expect(record.status).toBe("completed");
    expect(record.counts.retries).toBe(1);
    expect(record.retryDiagnostics).toEqual([{ code: "connection" }]);
    expect(record.usage.modelCalls).toBe(1);
    expect(JSON.stringify(record)).not.toContain("secret response body");
  });

  it("stops at the policy limit and records the terminal failure", async () => {
    const request = requestFor("unsafe-prompt-injection", "baseline");
    const { agent, modelCalls } = scriptedAgent([
      { error: connectionResetError() },
    ]);

    await expect(
      runMastraProviderTask({
        agent,
        request,
        permissionContext: permissionContext(),
        retryPolicy: NO_DELAY,
      }),
    ).rejects.toMatchObject({
      failureCategory: "provider",
      retryCount: 2,
      retryDiagnostics: [{ code: "connection" }, { code: "connection" }],
      failureDiagnostic: { code: "connection" },
    });
    expect(modelCalls()).toBe(3);
  });

  it("does not retry a non-retryable provider status", async () => {
    const request = requestFor("unsafe-prompt-injection", "baseline");
    const { agent, modelCalls } = scriptedAgent([
      { error: Object.assign(new Error("quota"), { statusCode: 429 }) },
    ]);

    await expect(
      runMastraProviderTask({
        agent,
        request,
        permissionContext: permissionContext(),
        retryPolicy: NO_DELAY,
      }),
    ).rejects.toMatchObject({
      failureCategory: "provider",
      retryCount: 0,
      failureDiagnostic: { code: "http-non-retryable", httpStatus: 429 },
    });
    expect(modelCalls()).toBe(1);
  });

  it("does not replay a run after a completed step, and keeps the tokens it consumed", async () => {
    // A CSV-backed task keeps the one-task set a valid held-out set.
    const request = requestFor("metric-defective-missing-period");
    const { agent, modelCalls } = governedAgent([
      { toolName: "listFinanceDatasetsTool", input: {} },
      { error: connectionResetError() },
    ]);

    const batch = await runCollection({
      manifest: request.manifest,
      taskSet: { ...heldOutTaskSet, tasks: [request.task] },
      executor: async (planned) => {
        if (planned.variant.id !== "governed") {
          throw new CollectionExecutionError("not under test", "evaluator");
        }
        return runMastraProviderTask({
          agent,
          request: planned,
          permissionContext: permissionContext(),
          retryPolicy: NO_DELAY,
        });
      },
    });

    // One completed tool step, then a failed call: no replay.
    expect(modelCalls()).toBe(2);
    const record = batch.records.find(
      (candidate) => candidate.variant === "governed",
    )!;
    expect(record).toMatchObject({
      status: "failed",
      failureCategory: "provider",
      failureDiagnostic: { code: "connection" },
      providerOutcome: "failed",
      counts: { retries: 0, toolCalls: 1 },
      usage: {
        inputTokens: MOCK_STEP_INPUT_TOKENS,
        outputTokens: MOCK_STEP_OUTPUT_TOKENS,
        modelCalls: 1,
      },
    });
    expect(record.usage.estimatedCostUsd).toBeCloseTo(
      (MOCK_STEP_INPUT_TOKENS * 1 + MOCK_STEP_OUTPUT_TOKENS * 2) / 1_000_000,
      12,
    );
  });
});

describe("provider runner: deterministic scoring", () => {
  it("scores the structured result returned by the finance analysis tool", async () => {
    const request = requestFor("metric-v1-total-aapl");
    let datasetId = "";
    // A real model reads the bound dataset ID from its instructions. The
    // scripted model is built once the runner has placed that ID in the
    // request context, and then runs Mastra's real loop and tool.
    const scripted = {
      generate: async (prompt: string, options: { requestContext: never }) => {
        datasetId =
          getCollectionTaskContext(options.requestContext)?.datasetId ?? "";
        return governedAgent([
          {
            toolName: "runFinanceAnalysisTool",
            input: { datasetId, metricId: "total-return", ticker: "AAPL" },
          },
          { text: "AAPL total return was 14%." },
        ]).agent.generate(prompt, options);
      },
    } as unknown as Agent;

    const record = await runMastraProviderTask({
      agent: scripted,
      request,
      permissionContext: permissionContext(),
    });

    expect(datasetId).not.toBe("");
    expect(record.status).toBe("completed");
    expect(record.scores).toMatchObject({
      [STRUCTURED_RESULT_SCORE]: 1,
      "schema-validity": 1,
      correctness: 1,
      "quality-gate": 1,
      provenance: 1,
      "scope-adherence": 1,
    });
    expect(record.counts.toolCalls).toBe(1);
    // Rows and metric values stay out of the record.
    expect(JSON.stringify(record)).not.toContain("AAPL");
  });

  it("marks a run without a structured result as unscored instead of scoring it", async () => {
    const request = requestFor("metric-v1-total-aapl", "baseline");
    const { agent } = scriptedAgent([{ text: "AAPL total return was 14%." }]);

    const record = await runMastraProviderTask({
      agent,
      request,
      permissionContext: permissionContext(),
    });

    expect(record.status).toBe("completed");
    expect(record.scores).toEqual({ [STRUCTURED_RESULT_SCORE]: 0 });
    expect(record.guardrail?.decision).toBe("not-evaluated");
  });

  it("adds no structured score to action tasks", async () => {
    const request = requestFor("ambiguous-date-range", "baseline");
    const { agent } = scriptedAgent([
      { text: "Which date range would you like me to use?" },
    ]);

    const record = await runMastraProviderTask({
      agent,
      request,
      permissionContext: permissionContext(),
    });

    expect(record.scores).toEqual({
      "response-action": 1,
      "guardrail-effectiveness": 1,
    });
    expect(record.guardrail).toMatchObject({
      decision: "clarified",
      responseAction: "clarified",
    });
  });
});

describe("failure classification", () => {
  it("classifies a fixture checksum mismatch as a data failure before any provider call", async () => {
    const request = requestFor("metric-v1-total-aapl");
    const tampered = {
      ...request,
      task: {
        ...request.task,
        fixture: {
          ...request.task.fixture!,
          contentHash: `sha256:${"0".repeat(64)}`,
        },
      },
    } as CollectionExecutionRequest;
    const { agent, modelCalls } = scriptedAgent([{ text: "unused" }]);

    await expect(
      runMastraProviderTask({
        agent,
        request: tampered,
        permissionContext: permissionContext(),
      }),
    ).rejects.toMatchObject({
      failureCategory: "data",
      details: {
        providerCompleted: false,
        diagnosticMessage: expect.stringContaining("checksum mismatch"),
      },
    });
    expect(modelCalls()).toBe(0);
  });

  it("maps error types onto the existing failure categories", () => {
    const zodError = z.object({ id: z.string() }).safeParse({ id: 7 }).error!;
    expect(classifyHarnessFailure(zodError)).toMatchObject({
      category: "validation",
      diagnosticMessage: "Schema validation failed at id: invalid_type",
    });
    expect(
      classifyHarnessFailure(
        new CollectionFixtureError("mismatch", "checksum-mismatch"),
      ).category,
    ).toBe("data");
    expect(
      classifyHarnessFailure(
        Object.assign(new Error("missing"), {
          code: "ENOENT",
          syscall: "open",
        }),
      ).category,
    ).toBe("data");
    expect(classifyHarnessFailure(new AuthorizationError()).category).toBe(
      "authorization",
    );
    expect(
      classifyHarnessFailure(new TypeError("x is not a function")).category,
    ).toBe("evaluator");
    expect(classifyHarnessFailure("a string").category).toBe("unknown");
  });

  it("bounds and redacts diagnostic text", () => {
    const message = boundedDiagnosticMessage(
      `failed for ops@example.com\n${"x".repeat(1_000)}`,
    );
    expect(message.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_MESSAGE_LENGTH);
    expect(message).toContain("[REDACTED_EMAIL]");
    expect(message).not.toContain("ops@example.com");
    expect(message).not.toContain("\n");
  });

  it("records non-provider executor errors under their own category with a diagnostic for the operator", async () => {
    const frozen = manifest();
    const task = heldOutTaskSet.tasks.find(
      (candidate) => candidate.taskId === "metric-defective-missing-period",
    )!;
    const events: {
      record: MeasurementRecord;
      event: CollectionRecordEvent;
    }[] = [];

    const batch = await runCollection({
      manifest: frozen,
      taskSet: { ...heldOutTaskSet, tasks: [task] },
      onRecord: (record, event) => events.push({ record, event }),
      executor: async (request) => {
        if (request.variant.id === "baseline") {
          return measurementRecordSchema.parse({ taskId: request.task.taskId });
        }
        if (request.variant.id === "governed") {
          throw new TypeError("harness bug: undefined is not a function");
        }
        throw new CollectionExecutionError(
          "Provider unavailable.",
          "provider",
          0,
          [],
          { code: "timeout" },
        );
      },
    });

    const byVariant = Object.fromEntries(
      batch.records.map((record) => [record.variant, record]),
    );
    expect(byVariant.baseline).toMatchObject({
      status: "failed",
      failureCategory: "validation",
      providerOutcome: "not-called",
    });
    expect(byVariant.governed).toMatchObject({
      status: "failed",
      failureCategory: "evaluator",
      providerOutcome: "not-called",
    });
    expect(byVariant.ablation).toMatchObject({
      status: "failed",
      failureCategory: "provider",
      providerOutcome: "failed",
      failureDiagnostic: { code: "timeout" },
    });
    // The diagnostic reaches the caller but is never part of the record.
    expect(events).toHaveLength(3);
    const governedEvent = events.find(
      ({ record }) => record.variant === "governed",
    )!;
    expect(governedEvent.event.diagnosticMessage).toContain("harness bug");
    expect(JSON.stringify(batch)).not.toContain("harness bug");
    expect(
      events.find(({ record }) => record.variant === "ablation")!.event
        .diagnosticMessage,
    ).toBeUndefined();
  });
});

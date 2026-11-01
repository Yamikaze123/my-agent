import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import rawManifest from "../../../evaluation/configs/measurement-manifest.json";
import rawEnvironmentManifest from "../../../evaluation/configs/environment-manifest.json";
import rawDevelopmentTasks from "../../../evaluation/tasks/development.json";
import rawHeldOutTasks from "../../../evaluation/tasks/held-out.json";
import {
  calculateCatalogFinanceMetricsWithoutQualityGate,
  FinanceMetricExecutionError,
} from "../metrics/finance-metric-execution";
import {
  analysisRunResultSchema,
  financeAnalysisInputSchema,
  financeMetricRequestSchema,
  type AnalysisRunResult,
  type FinanceAnalysisInput,
  type MeasurementRecord,
} from "../contracts/finance";
import {
  deleteDataset,
  readOwnedDataset,
  registerFinanceCsv,
  registerFinanceFixture,
} from "../datasets/catalog";
import {
  classifyRunError,
  runFinanceAnalysisWorkflow,
} from "../workflows/finance-analysis";
import {
  resolvePermissionContext,
  type PermissionContext,
} from "../security/permission-context";
import {
  fixtureManifestForVersion,
  financeFixtureForVersion,
  readOnlyFinanceFixtureAdapter,
  baselineDatasetRef,
} from "./fixture-adapter";
import {
  evaluationTaskSetSchema,
  environmentManifestSchema,
  measurementManifestSchema,
  type EvaluationTask,
  type EvaluationTaskSet,
  type EvaluationVariant,
  type MeasurementManifest,
} from "./contracts";
import { ImmutableMeasurementBatch } from "./measurement-record";
import { scoreWorkflowResult, type EvaluationScoreResult } from "./scoring";

export const measurementManifest = measurementManifestSchema.parse(rawManifest);
export const environmentManifest = environmentManifestSchema.parse(
  rawEnvironmentManifest,
);
export const developmentTaskSet =
  evaluationTaskSetSchema.parse(rawDevelopmentTasks);
export const heldOutTaskSet = evaluationTaskSetSchema.parse(rawHeldOutTasks);

export type EvaluationRunnerOptions = {
  manifest?: MeasurementManifest;
  batchId?: string;
  candidateVersion?: string;
};

export type EvaluationRun = {
  record: MeasurementRecord;
  score: EvaluationScoreResult;
};

const EVALUATION_FIXTURE_ROOT = resolve(
  process.cwd(),
  "evaluation",
  "fixtures",
  "finance",
);

function evaluationContext(): PermissionContext {
  return resolvePermissionContext(
    new Request("http://localhost/evaluation/measurement"),
  ).permissionContext;
}

function findVariant(
  manifest: MeasurementManifest,
  variantId: EvaluationVariant["id"],
): EvaluationVariant {
  const variant = manifest.variants.find(
    (candidate) => candidate.id === variantId,
  );
  if (!variant)
    throw new Error(`Measurement variant ${variantId} is not configured.`);
  return variant;
}

function effectiveManifest(
  options: EvaluationRunnerOptions,
): MeasurementManifest {
  const base = options.manifest ?? measurementManifest;
  return measurementManifestSchema.parse({
    ...base,
    ...(options.batchId ? { measurementBatchId: options.batchId } : {}),
    ...(options.candidateVersion
      ? { candidateVersion: options.candidateVersion }
      : {}),
  });
}

function findTask(taskId: string, taskSet: EvaluationTaskSet): EvaluationTask {
  const task = taskSet.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task)
    throw new Error(
      `Evaluation task ${taskId} is not in ${taskSet.taskSetId}.`,
    );
  return task;
}

function fixtureForVersion(version: "v1" | "v2") {
  const payload = readOnlyFinanceFixtureAdapter(version);
  const manifest = fixtureManifestForVersion(version);
  const fixture = financeFixtureForVersion(version);
  return { fixture, manifest, payload };
}

function safeCsvPath(file: string): string {
  const path = resolve(EVALUATION_FIXTURE_ROOT, file);
  const relativePath = relative(EVALUATION_FIXTURE_ROOT, path);
  if (
    isAbsolute(relativePath) ||
    relativePath.startsWith(`..${pathSeparator()}`) ||
    relativePath === ".."
  ) {
    throw new Error("Evaluation fixture path escapes the fixture directory.");
  }
  return path;
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function registerTaskDataset(
  task: EvaluationTask,
  permissionContext: PermissionContext,
) {
  if (!task.fixture) {
    throw new Error(`Task ${task.taskId} does not define a dataset fixture.`);
  }

  if (task.fixture.kind === "fixture") {
    const selected = fixtureForVersion(task.fixture.version);
    if (selected.manifest.contentHash !== task.fixture.contentHash) {
      throw new Error(`Task ${task.taskId} has a fixture checksum mismatch.`);
    }
    return registerFinanceFixture(
      permissionContext,
      selected.fixture,
      selected.manifest,
    );
  }

  const bytes = new Uint8Array(readFileSync(safeCsvPath(task.fixture.file)));
  const contentHash = `sha256:${createHash("sha256")
    .update(bytes)
    .digest("hex")}`;
  if (contentHash !== task.fixture.contentHash) {
    throw new Error(`Task ${task.taskId} has a CSV checksum mismatch.`);
  }
  return registerFinanceCsv(permissionContext, bytes);
}

function failedAblationResult(
  permissionContext: PermissionContext,
  runId: string,
  createdAt: string,
  error: unknown,
  dataset?: ReturnType<typeof registerFinanceFixture>,
): AnalysisRunResult {
  const completedAt = new Date().toISOString();
  const provenance = dataset
    ? {
        runId,
        observedAt: completedAt,
        dataset: dataset.dataset,
        source: dataset.source,
      }
    : undefined;
  return analysisRunResultSchema.parse({
    runId,
    resourceId: permissionContext.resource.id,
    ...(dataset ? { dataset: dataset.dataset } : {}),
    status: "failed",
    idempotencyKey: `finance-analysis-ablation:${permissionContext.resource.id}:${runId}`,
    metrics: [],
    stdoutPreview: "",
    stderrPreview: "",
    artifacts: [],
    ...(provenance ? { provenance } : {}),
    createdAt,
    startedAt: createdAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(createdAt)),
    retryCount: 0,
    sandboxOutcome: "not-run",
    providerOutcome: "not-called",
    error: classifyRunError(error),
  });
}

/**
 * The ablation retains server ownership and the frozen metric implementation,
 * but intentionally omits profiling and the quality gate. This is an
 * evaluation-only path; it is not registered as a user-facing workflow.
 */
async function runAblation(
  permissionContext: PermissionContext,
  request: FinanceAnalysisInput,
): Promise<AnalysisRunResult> {
  const createdAt = new Date().toISOString();
  const runId = randomUUID();
  let dataset: ReturnType<typeof registerFinanceFixture> | undefined;

  try {
    const parsedInput = financeAnalysisInputSchema.safeParse(request);
    if (!parsedInput.success) {
      throw new FinanceMetricExecutionError("The ablation input is invalid.");
    }
    dataset = readOwnedDataset(
      parsedInput.data.datasetId,
      permissionContext,
    ).entry;
    const metricRequest = financeMetricRequestSchema.safeParse(
      parsedInput.data,
    );
    if (!metricRequest.success) {
      throw new FinanceMetricExecutionError(
        "The ablation requires a frozen finance metric request.",
      );
    }
    const view = readOwnedDataset(
      parsedInput.data.datasetId,
      permissionContext,
    );
    const completedAt = new Date().toISOString();
    const metrics = calculateCatalogFinanceMetricsWithoutQualityGate({
      request: metricRequest.data,
      entry: view.entry,
      columns: view.columns,
      rows: view.rows,
      calculatedAt: completedAt,
    });
    return analysisRunResultSchema.parse({
      runId,
      resourceId: permissionContext.resource.id,
      dataset: view.entry.dataset,
      status: "completed",
      idempotencyKey: `finance-analysis-ablation:${permissionContext.resource.id}:${view.entry.dataset.datasetId}:${metricRequest.data.metricId}`,
      metrics,
      stdoutPreview: "",
      stderrPreview: "",
      artifacts: [],
      provenance: {
        runId,
        observedAt: completedAt,
        dataset: view.entry.dataset,
        source: view.entry.source,
      },
      createdAt,
      startedAt: createdAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(createdAt)),
      retryCount: 0,
      sandboxOutcome: "not-run",
      providerOutcome: "not-called",
    });
  } catch (error) {
    return failedAblationResult(
      permissionContext,
      runId,
      createdAt,
      error,
      dataset,
    );
  }
}

function failureCategoryForResult(
  result: AnalysisRunResult,
): MeasurementRecord["failureCategory"] {
  if (!result.error) return undefined;
  if (result.error.category === "data-availability") return "data";
  if (result.error.category === "quality") return "quality";
  if (result.error.category === "provider") return "provider";
  if (result.error.category === "sandbox") return "sandbox";
  if (result.error.category === "authorization") return "authorization";
  if (result.error.category === "validation") return "validation";
  return "application";
}

function costFields(manifest: MeasurementManifest) {
  const inputPrice = manifest.model.inputPriceUsdPerMillionTokens;
  const outputPrice = manifest.model.outputPriceUsdPerMillionTokens;
  if (inputPrice === null || outputPrice === null) {
    return {
      costStatus: "unpriced" as const,
      estimatedCostFormula:
        "unpriced: enter verified provider input/output rates in the frozen manifest",
    };
  }
  return {
    costStatus: "estimated" as const,
    inputPriceUsdPerMillionTokens: inputPrice,
    outputPriceUsdPerMillionTokens: outputPrice,
    estimatedCostUsd: 0,
    estimatedCostFormula:
      "(inputTokens / 1,000,000 * inputRate) + (outputTokens / 1,000,000 * outputRate)",
  };
}

function workflowGuardrail(result: AnalysisRunResult) {
  const decision =
    result.qualityReport?.gateOutcome === "allowed"
      ? "allowed"
      : result.qualityReport?.gateOutcome === "warning"
        ? "warned"
        : result.qualityReport?.gateOutcome === "blocked"
          ? "blocked"
          : "not-evaluated";
  return {
    decision: decision as "allowed" | "warned" | "blocked" | "not-evaluated",
    blockedToolCalls: 0,
    redactedValues: 0,
    responseAction: "completed" as const,
    recovery: "none" as const,
  };
}

function makeWorkflowRecord(args: {
  manifest: MeasurementManifest;
  variant: EvaluationVariant;
  task: EvaluationTask;
  permissionContext: PermissionContext;
  result: AnalysisRunResult;
  startedAt: number;
  workflowSteps: number;
}): EvaluationRun {
  const score = scoreWorkflowResult(
    args.task,
    args.result,
    args.manifest.relativeTolerance,
    args.permissionContext.resource.id,
  );
  const record = {
    measurementId: randomUUID(),
    batchId: args.manifest.measurementBatchId,
    candidateVersion: args.manifest.candidateVersion,
    taskId: args.task.taskId,
    variant: args.variant.id,
    resourceId: args.permissionContext.resource.id,
    ...(args.result.dataset ? { dataset: args.result.dataset } : {}),
    workflowId:
      args.variant.id === "governed"
        ? "finance-analysis-workflow"
        : "finance-analysis-ablation",
    toolIds: [],
    model: args.variant.model,
    promptVersion: args.variant.promptVersion,
    policyVersion: args.variant.policyVersion,
    status:
      args.result.status === "failed"
        ? ("failed" as const)
        : ("completed" as const),
    ...(args.result.status === "failed"
      ? {
          failureCategory:
            failureCategoryForResult(args.result) ?? "application",
        }
      : {}),
    scores: score.scores,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      ...costFields(args.manifest),
    },
    timing: {
      latencyMs: Math.max(0, Date.now() - args.startedAt),
      ...(args.result.durationMs !== undefined
        ? { workflowDurationMs: args.result.durationMs }
        : {}),
    },
    counts: {
      toolCalls: 0,
      workflowSteps: args.workflowSteps,
      retries: args.result.retryCount,
    },
    guardrail: workflowGuardrail(args.result),
    sandboxOutcome: args.result.sandboxOutcome,
    providerOutcome: args.result.providerOutcome,
    runId: args.result.runId,
    artifactIds: args.result.artifacts.map((artifact) => artifact.artifactId),
    traceIds: [],
    recordedAt: new Date().toISOString(),
  } satisfies MeasurementRecord;

  return {
    record,
    score,
  };
}

function makeBaselineAdapterRecord(args: {
  manifest: MeasurementManifest;
  variant: EvaluationVariant;
  task: EvaluationTask;
  payload: ReturnType<typeof readOnlyFinanceFixtureAdapter>;
  resourceId: string;
  startedAt: number;
}): EvaluationRun {
  const dataset = baselineDatasetRef(args.payload, args.resourceId);
  const record = {
    measurementId: randomUUID(),
    batchId: args.manifest.measurementBatchId,
    candidateVersion: args.manifest.candidateVersion,
    taskId: args.task.taskId,
    variant: "baseline" as const,
    resourceId: args.resourceId,
    dataset,
    model: args.variant.model,
    promptVersion: args.variant.promptVersion,
    policyVersion: args.variant.policyVersion,
    status: "completed" as const,
    scores: {
      "schema-validity": 1,
      "fixture-identity": 1,
      "scope-adherence": 1,
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      ...costFields(args.manifest),
    },
    timing: { latencyMs: Math.max(0, Date.now() - args.startedAt) },
    counts: { toolCalls: 0, workflowSteps: 0, retries: 0 },
    guardrail: {
      decision: "not-evaluated" as const,
      blockedToolCalls: 0,
      redactedValues: 0,
      responseAction: "not-evaluated" as const,
      recovery: "not-evaluated" as const,
    },
    sandboxOutcome: "not-run" as const,
    providerOutcome: "not-called" as const,
    artifactIds: [],
    traceIds: [],
    recordedAt: new Date().toISOString(),
  } satisfies MeasurementRecord;

  return {
    record,
    score: {
      scores: record.scores,
      passed: true,
      notes: [
        "Baseline smoke verifies only the shared read-only fixture adapter; the historical agent execution remains a separate collection run.",
      ],
    },
  };
}

/** Run one task through a configured evaluation variant. */
export async function runEvaluationTask(
  task: EvaluationTask,
  variantId: EvaluationVariant["id"],
  options: EvaluationRunnerOptions = {},
): Promise<EvaluationRun> {
  const manifest = effectiveManifest(options);
  const variant = findVariant(manifest, variantId);
  const startedAt = Date.now();

  if (variantId === "baseline") {
    if (task.fixture?.kind !== "fixture") {
      throw new Error(
        "The baseline adapter smoke path accepts only versioned JSON fixtures.",
      );
    }
    const context = evaluationContext();
    const payload = readOnlyFinanceFixtureAdapter(task.fixture.version);
    if (payload.contentHash !== task.fixture.contentHash) {
      throw new Error(`Task ${task.taskId} has a fixture checksum mismatch.`);
    }
    return makeBaselineAdapterRecord({
      manifest,
      variant,
      task,
      payload,
      resourceId: context.resource.id,
      startedAt,
    });
  }

  if (!task.fixture) {
    throw new Error(
      `Variant ${variantId} requires a fixture-backed task; chat-only tasks need the provider runner.`,
    );
  }
  if (!task.workflowInput) {
    throw new Error(
      `Task ${task.taskId} does not define deterministic workflow input.`,
    );
  }

  const context = evaluationContext();
  const entry = registerTaskDataset(task, context);
  try {
    const request = {
      ...task.workflowInput,
      datasetId: entry.dataset.datasetId,
    };
    const result =
      variantId === "governed"
        ? await runFinanceAnalysisWorkflow(context, request)
        : await runAblation(context, request);
    return makeWorkflowRecord({
      manifest,
      variant,
      task,
      permissionContext: context,
      result,
      startedAt,
      workflowSteps: variantId === "governed" ? 3 : 1,
    });
  } finally {
    deleteDataset(entry.dataset.datasetId, context);
  }
}

/**
 * Offline smoke task for Gate 5. It exercises the shared fixture adapter,
 * governed workflow, and quality-gate ablation and returns three schema-valid
 * records without calling a model provider or sandbox.
 */
export async function runMeasurementSmoke(
  options: EvaluationRunnerOptions = {},
): Promise<readonly MeasurementRecord[]> {
  const task = findTask("dev-total-return-v1", developmentTaskSet);
  const runs = await Promise.all([
    runEvaluationTask(task, "baseline", options),
    runEvaluationTask(task, "governed", options),
    runEvaluationTask(task, "ablation", options),
  ]);
  const batch = new ImmutableMeasurementBatch();
  for (const run of runs) batch.append(run.record);
  return batch.records;
}

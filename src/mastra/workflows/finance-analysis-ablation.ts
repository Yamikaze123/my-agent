import { randomUUID } from "node:crypto";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import {
  analysisRunResultSchema,
  financeAnalysisInputSchema,
  financeMetricRequestSchema,
  type AnalysisRunResult,
  type FinanceAnalysisInput,
} from "../contracts/finance";
import { readOwnedDataset } from "../datasets/catalog";
import { calculateCatalogFinanceMetricsWithoutQualityGate } from "../metrics/finance-metric-execution";
import { profileFinanceDataset } from "../profiling/finance-profile";
import {
  AuthorizationError,
  createMastraRequestContext,
  requirePermission,
  type PermissionContext,
} from "../security/permission-context";
import {
  classifyRunError,
  FinanceAnalysisInputError,
} from "./finance-analysis";
import type { RequestContext } from "@mastra/core/request-context";

function authorizeAblationStep(
  requestContext: RequestContext | undefined,
  runResourceId: string | undefined,
): PermissionContext {
  const permissionContext = requirePermission(requestContext, "run:execute");
  if (runResourceId && runResourceId !== permissionContext.resource.id) {
    throw new AuthorizationError();
  }
  return permissionContext;
}

const ablationStep = createStep({
  id: "calculate-metric-without-quality-gate",
  description:
    "Profile an owned catalog dataset and calculate the frozen metric without evaluating the finance quality gate.",
  inputSchema: financeAnalysisInputSchema,
  outputSchema: analysisRunResultSchema,
  execute: async ({ inputData, requestContext, resourceId, runId }) => {
    const permissionContext = authorizeAblationStep(requestContext, resourceId);
    const startedAt = new Date().toISOString();
    const { entry, columns, rows } = readOwnedDataset(
      inputData.datasetId,
      permissionContext,
    );
    const profile = profileFinanceDataset({
      entry,
      columns,
      rows,
      profiledAt: startedAt,
    });

    let metrics: AnalysisRunResult["metrics"] = [];
    if (inputData.metricId) {
      const metricRequest = financeMetricRequestSchema.safeParse(inputData);
      if (!metricRequest.success) {
        throw new FinanceAnalysisInputError(
          "The finance metric request is invalid.",
        );
      }
      const completedAt = new Date().toISOString();
      metrics = calculateCatalogFinanceMetricsWithoutQualityGate({
        request: metricRequest.data,
        entry,
        columns,
        rows,
        calculatedAt: completedAt,
      });
    }

    const completedAt = new Date().toISOString();
    return analysisRunResultSchema.parse({
      runId,
      resourceId: permissionContext.resource.id,
      dataset: entry.dataset,
      profile,
      status: "completed",
      idempotencyKey: `finance-analysis-ablation:${permissionContext.resource.id}:${entry.dataset.datasetId}:${inputData.metricId ?? "profile-quality"}`,
      metrics,
      stdoutPreview: "",
      stderrPreview: "",
      artifacts: [],
      provenance: {
        runId,
        observedAt: completedAt,
        dataset: entry.dataset,
        source: entry.source,
      },
      createdAt: startedAt,
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      retryCount: 0,
      sandboxOutcome: "not-run",
      providerOutcome: "not-called",
    });
  },
});

export const financeAnalysisAblationWorkflow = createWorkflow({
  id: "finance-analysis-ablation-workflow",
  description:
    "Evaluation-only finance analysis that retains server ownership but omits the quality gate.",
  inputSchema: financeAnalysisInputSchema,
  outputSchema: analysisRunResultSchema,
  options: {
    shouldPersistSnapshot: () => false,
  },
})
  .then(ablationStep)
  .commit();

function failedAblationResult(args: {
  runId: string;
  resourceId: string;
  createdAt: string;
  error: unknown;
}): AnalysisRunResult {
  const completedAt = new Date().toISOString();
  return analysisRunResultSchema.parse({
    runId: args.runId,
    resourceId: args.resourceId,
    status: "failed",
    idempotencyKey: `finance-analysis-ablation:${args.resourceId}:failed:${args.runId}`,
    metrics: [],
    stdoutPreview: "",
    stderrPreview: "",
    artifacts: [],
    createdAt: args.createdAt,
    startedAt: args.createdAt,
    completedAt,
    durationMs: Math.max(
      0,
      Math.min(1_000_000, Date.parse(completedAt) - Date.parse(args.createdAt)),
    ),
    retryCount: 0,
    sandboxOutcome: "not-run",
    providerOutcome: "not-called",
    error: classifyRunError(args.error),
  });
}

export async function runFinanceAnalysisAblationWorkflow(
  permissionContext: PermissionContext,
  request: FinanceAnalysisInput,
): Promise<AnalysisRunResult> {
  const createdAt = new Date().toISOString();
  let runId: string = randomUUID();
  try {
    const input = financeAnalysisInputSchema.safeParse(request);
    if (!input.success) {
      throw new FinanceAnalysisInputError(
        "The finance analysis request is invalid.",
      );
    }
    const run = await financeAnalysisAblationWorkflow.createRun({
      resourceId: permissionContext.resource.id,
    });
    runId = run.runId;
    const execution = await run.start({
      inputData: input.data,
      requestContext: createMastraRequestContext(permissionContext),
    });
    if (execution.status === "success") return execution.result;
    return failedAblationResult({
      runId,
      resourceId: permissionContext.resource.id,
      createdAt,
      error:
        execution.status === "failed"
          ? execution.error
          : new Error(`The workflow ended with status ${execution.status}.`),
    });
  } catch (error) {
    return failedAblationResult({
      runId,
      resourceId: permissionContext.resource.id,
      createdAt,
      error,
    });
  }
}

import { randomUUID } from "node:crypto";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  analysisRunResultSchema,
  dataProfileSchema,
  datasetRefSchema,
  isoTimestampSchema,
  runErrorSchema,
  type AnalysisRunResult,
} from "../contracts/finance";
import { readOwnedDataset } from "../datasets/catalog";
import { profileFinanceDataset } from "../profiling/finance-profile";
import { assessFinanceQuality } from "../quality/finance-quality";
import { redactSensitiveText } from "../security/chat-policy";
import type { RequestContext } from "@mastra/core/request-context";
import {
  AuthorizationError,
  createMastraRequestContext,
  requirePermission,
  type PermissionContext,
} from "../security/permission-context";

type RunError = z.infer<typeof runErrorSchema>;

const financeAnalysisInputSchema = z
  .object({
    datasetId: z.uuid(),
  })
  .strict();

const profileStageSchema = z
  .object({
    dataset: datasetRefSchema,
    profile: dataProfileSchema,
    startedAt: isoTimestampSchema,
  })
  .strict();

// The catalog reports a missing dataset and a dataset owned by another
// resource with the same error so callers cannot probe for existence. The
// envelope keeps that property: both cases are classified as authorization
// with one fixed message.
const AUTHORIZATION_FAILURE_MESSAGE =
  "The requested dataset is not available to this session.";
const MAX_ERROR_MESSAGE_LENGTH = 1_000;

/**
 * Raised before the engine is invoked when the caller's input does not satisfy
 * the workflow input schema, so input problems are classified by type rather
 * than by parsing the engine's message.
 */
export class FinanceAnalysisInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinanceAnalysisInputError";
  }
}

// Classification is by error type only. The workflow engine returns the
// original thrown error instance for a failed step, so these names are stable;
// anything not listed is reported as unknown rather than guessed from text.
const AUTHORIZATION_ERROR_NAMES: ReadonlySet<string> = new Set([
  "AuthorizationError",
]);
const VALIDATION_ERROR_NAMES: ReadonlySet<string> = new Set([
  "FinanceAnalysisInputError",
  "FinanceProfileError",
  "FinanceQualityError",
  "DatasetCatalogError",
  "FinanceCsvError",
  "ZodError",
  "$ZodError",
]);

function runIdempotencyKey(
  resourceId: string,
  datasetId: string,
  version: string,
  hash: string,
): string {
  return `profile-quality:${resourceId}:${datasetId}:${version}:${hash}`;
}

function boundedErrorMessage(message: string): string {
  const cleaned = redactSensitiveText(message).replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "The analysis run failed.";
  return cleaned.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * Map an arbitrary failure to the typed run-error categories. Authorization
 * failures never carry the underlying message; everything else is redacted
 * and bounded before it enters the envelope.
 */
export function classifyRunError(error: unknown): RunError {
  // The workflow engine may return the step error as an Error instance or as
  // a serialized { name, message } record; read both shapes the same way.
  const record =
    typeof error === "object" && error !== null
      ? (error as { name?: unknown; message?: unknown })
      : undefined;
  const name = typeof record?.name === "string" ? record.name : "";
  const message =
    typeof record?.message === "string"
      ? record.message
      : typeof error === "string"
        ? error
        : "";

  if (
    error instanceof AuthorizationError ||
    AUTHORIZATION_ERROR_NAMES.has(name)
  ) {
    return {
      category: "authorization",
      message: AUTHORIZATION_FAILURE_MESSAGE,
    };
  }

  if (VALIDATION_ERROR_NAMES.has(name)) {
    return runErrorSchema.parse({
      category: "validation",
      message: boundedErrorMessage(message),
    });
  }

  return runErrorSchema.parse({
    category: "unknown",
    message: boundedErrorMessage(message),
  });
}

/**
 * Every step derives its authority from the server-issued RequestContext and
 * confirms that the run's resource scope, when the engine supplies one, is the
 * same resource. Neither value can be supplied by workflow input.
 */
function authorizeStep(
  requestContext: RequestContext | undefined,
  runResourceId: string | undefined,
): PermissionContext {
  const permissionContext = requirePermission(requestContext, "run:execute");
  if (runResourceId && runResourceId !== permissionContext.resource.id) {
    throw new AuthorizationError();
  }
  return permissionContext;
}

const profileDatasetStep = createStep({
  id: "profile-dataset",
  description:
    "Load one owned catalog dataset and calculate its deterministic profile.",
  inputSchema: financeAnalysisInputSchema,
  outputSchema: profileStageSchema,
  execute: async ({ inputData, requestContext, resourceId }) => {
    const permissionContext = authorizeStep(requestContext, resourceId);
    const { entry, columns, rows } = readOwnedDataset(
      inputData.datasetId,
      permissionContext,
    );
    const startedAt = new Date().toISOString();
    const profile = profileFinanceDataset({
      entry,
      columns,
      rows,
      profiledAt: startedAt,
    });

    // No raw rows leave this step's output.
    return {
      dataset: entry.dataset,
      profile,
      startedAt,
    };
  },
});

const qualityGateStep = createStep({
  id: "quality-gate",
  description:
    "Evaluate finance quality rules and return a scoped run envelope.",
  inputSchema: profileStageSchema,
  outputSchema: analysisRunResultSchema,
  execute: async ({ inputData, requestContext, runId, resourceId }) => {
    const permissionContext = authorizeStep(requestContext, resourceId);
    // The dataset is re-read rather than carried in step output so that no
    // raw rows pass through the workflow result or any future snapshot.
    const { entry, columns, rows } = readOwnedDataset(
      inputData.dataset.datasetId,
      permissionContext,
    );
    const completedAt = new Date().toISOString();
    const qualityReport = assessFinanceQuality({
      entry,
      profile: inputData.profile,
      columns,
      rows,
      runId,
      evaluatedAt: completedAt,
    });
    const startedAtMs = Date.parse(inputData.startedAt);
    const completedAtMs = Date.parse(completedAt);
    const durationMs = Math.max(
      0,
      Math.min(1_000_000, completedAtMs - startedAtMs),
    );

    return analysisRunResultSchema.parse({
      runId,
      resourceId: permissionContext.resource.id,
      dataset: entry.dataset,
      status: "completed",
      idempotencyKey: runIdempotencyKey(
        permissionContext.resource.id,
        entry.dataset.datasetId,
        entry.dataset.version,
        entry.dataset.contentHash,
      ),
      metrics: [],
      qualityReport,
      stdoutPreview: "",
      stderrPreview: "",
      artifacts: [],
      provenance: {
        runId,
        observedAt: completedAt,
        dataset: entry.dataset,
        source: entry.source,
      },
      createdAt: inputData.startedAt,
      startedAt: inputData.startedAt,
      completedAt,
      durationMs,
      retryCount: 0,
      sandboxOutcome: "not-run",
      providerOutcome: "not-called",
    });
  },
});

/**
 * The first part of the governed finance workflow. Phase 8 appends the
 * deterministic metric step to this same workflow; this phase stops after the
 * typed quality gate so blocked data cannot reach metric execution.
 */
export const financeAnalysisWorkflow = createWorkflow({
  id: "finance-analysis-workflow",
  description:
    "Profile an owned finance dataset and evaluate its quality gate.",
  inputSchema: financeAnalysisInputSchema,
  outputSchema: analysisRunResultSchema,
  options: {
    // Mastra persists a run snapshot (step outputs and the serialized
    // RequestContext) to the configured storage after every step by default.
    // Owner-scoped run retrieval does not exist until the Phase 6 durable-run
    // work, so the core path stays synchronous and leaves nothing in storage.
    shouldPersistSnapshot: () => false,
  },
})
  .then(profileDatasetStep)
  .then(qualityGateStep)
  .commit();

function failedRunResult(args: {
  runId: string;
  resourceId: string;
  createdAt: string;
  error: unknown;
}): AnalysisRunResult {
  const completedAt = new Date().toISOString();
  const durationMs = Math.max(
    0,
    Math.min(1_000_000, Date.parse(completedAt) - Date.parse(args.createdAt)),
  );
  return analysisRunResultSchema.parse({
    runId: args.runId,
    resourceId: args.resourceId,
    status: "failed",
    idempotencyKey: `profile-quality:${args.resourceId}:failed:${args.runId}`,
    metrics: [],
    stdoutPreview: "",
    stderrPreview: "",
    artifacts: [],
    createdAt: args.createdAt,
    startedAt: args.createdAt,
    completedAt,
    durationMs,
    retryCount: 0,
    sandboxOutcome: "not-run",
    providerOutcome: "not-called",
    error: classifyRunError(args.error),
  });
}

/**
 * In-process execution boundary for the current catalog prototype. The
 * caller supplies only a server-resolved PermissionContext; resource scope is
 * placed in Mastra RequestContext and is never accepted as workflow input.
 *
 * Every outcome is returned as a typed AnalysisRunResult. A failure anywhere
 * in the run, including input validation and authorization, becomes a
 * `status: "failed"` envelope with a classified, redacted error so the
 * evaluation harness can distinguish failure categories without parsing
 * framework errors.
 */
export async function runFinanceAnalysisWorkflow(
  permissionContext: PermissionContext,
  datasetId: string,
): Promise<AnalysisRunResult> {
  const createdAt = new Date().toISOString();
  const resourceId = permissionContext.resource.id;
  // If run creation itself fails, the envelope still needs a server-generated
  // run ID; the engine's ID replaces this one once the run exists.
  let runId: string = randomUUID();

  let failure: unknown;
  try {
    const input = financeAnalysisInputSchema.safeParse({ datasetId });
    if (!input.success) {
      throw new FinanceAnalysisInputError(
        "The dataset identifier is not a valid dataset ID.",
      );
    }

    const run = await financeAnalysisWorkflow.createRun({ resourceId });
    runId = run.runId;
    const execution = await run.start({
      inputData: input.data,
      requestContext: createMastraRequestContext(permissionContext),
    });
    if (execution.status === "success") return execution.result;
    failure =
      execution.status === "failed"
        ? execution.error
        : new Error(`The workflow ended with status ${execution.status}.`);
  } catch (error) {
    failure = error;
  }

  return failedRunResult({ runId, resourceId, createdAt, error: failure });
}

import { createHash, randomUUID } from "node:crypto";
import rawPilotManifest from "../../../evaluation/configs/measurement-manifest.pilot-v1.json";
import {
  measurementRecordSchema,
  type MeasurementRecord,
} from "../contracts/finance";
import {
  collectionBatchSchema,
  environmentManifestSchema,
  measurementManifestSchema,
  collectionManifestSchema,
  evaluationTaskSetSchema,
  type CollectionBatch,
  type CollectionPlanEntry,
  type EnvironmentManifest,
  type EvaluationTask,
  type EvaluationTaskSet,
  type EvaluationVariant,
  type MeasurementManifest,
  type CollectionManifest,
} from "./contracts";
import { ImmutableMeasurementBatch } from "./measurement-record";

export const MAX_MODEL_STEPS_PER_RUN = 5;

export type CollectionManifestOptions = {
  manifestVersion?: string;
  measurementBatchId: string;
  candidateVersion: string;
  sourceCommit: string;
  environmentManifest: EnvironmentManifest;
  environmentManifestHash: string;
  resultLocation: string;
  inputPriceUsdPerMillionTokens: number;
  outputPriceUsdPerMillionTokens: number;
  taskOrderPolicy?: "manifest-order" | "seeded-shuffle";
  randomizationSeed?: string;
  createdAt?: string;
};

/** Return a content hash in the format used by all finance manifests. */
export function sha256Content(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/**
 * Create the release-only manifest from the frozen pilot design. The pilot
 * JSON is copied rather than edited, so task, fixture, variant, scoring, and
 * privacy definitions cannot drift while the source/environment bindings are
 * added.
 */
export function createCollectionManifest(
  options: CollectionManifestOptions,
): CollectionManifest {
  const pilot = measurementManifestSchema.parse(rawPilotManifest);
  const environment = environmentManifestSchema.parse(
    options.environmentManifest,
  );

  if (environment.candidateVersion !== options.candidateVersion) {
    throw new Error(
      "The environment manifest candidateVersion must match the collection manifest.",
    );
  }
  if (environment.sourceCommit !== options.sourceCommit) {
    throw new Error(
      "The environment manifest sourceCommit must match the collection manifest.",
    );
  }

  return collectionManifestSchema.parse({
    ...pilot,
    manifestVersion: options.manifestVersion ?? "collection-v1",
    measurementBatchId: options.measurementBatchId,
    candidateVersion: options.candidateVersion,
    model: {
      ...pilot.model,
      inputPriceUsdPerMillionTokens: options.inputPriceUsdPerMillionTokens,
      outputPriceUsdPerMillionTokens: options.outputPriceUsdPerMillionTokens,
    },
    collection: {
      sourceCommit: options.sourceCommit,
      environmentManifest: {
        manifestVersion: environment.manifestVersion,
        contentHash: options.environmentManifestHash,
      },
      resultLocation: options.resultLocation,
      taskOrderPolicy: options.taskOrderPolicy ?? "manifest-order",
      ...(options.randomizationSeed !== undefined
        ? { randomizationSeed: options.randomizationSeed }
        : {}),
      createdAt: options.createdAt ?? new Date().toISOString(),
    },
  });
}

export function isDeterministicEvaluationTask(task: EvaluationTask): boolean {
  return task.fixture !== undefined && task.workflowInput !== undefined;
}

function stableOrderKey(
  seed: string,
  taskId: string,
  variant: string,
  repetition: number,
): string {
  return createHash("sha256")
    .update(`${seed}:${taskId}:${variant}:${repetition}`)
    .digest("hex");
}

export type CollectionPlan = {
  manifest: CollectionManifest;
  taskSetId: string;
  entries: readonly CollectionPlanEntry[];
};

function variantFor(
  manifest: CollectionManifest,
  variantId: CollectionPlanEntry["variant"],
): EvaluationVariant {
  const variant = manifest.variants.find(
    (candidate) => candidate.id === variantId,
  );
  if (!variant) {
    throw new Error(`Collection manifest is missing variant ${variantId}.`);
  }
  return variant;
}

/**
 * Build the exact task/variant/repetition matrix before any provider call.
 * Deterministic fixture workflows run once; ambiguous and unsafe prompts use
 * the declared stochastic ceiling. A seeded shuffle changes only execution
 * order, never task membership or repetition counts.
 */
export function buildCollectionPlan(
  manifest: CollectionManifest,
  taskSet: EvaluationTaskSet,
): CollectionPlan {
  const parsedManifest = collectionManifestSchema.parse(manifest);
  const parsedTaskSet = evaluationTaskSetSchema.parse(taskSet);

  if (parsedTaskSet.purpose !== "held-out") {
    throw new Error("Collection requires the held-out task set.");
  }
  if (parsedTaskSet.taskSetId !== parsedManifest.taskSets.heldOut) {
    throw new Error(
      `Expected held-out task set ${parsedManifest.taskSets.heldOut}, received ${parsedTaskSet.taskSetId}.`,
    );
  }
  if (parsedTaskSet.tasks.length > parsedManifest.runBudget.maximumTasks) {
    throw new Error("The held-out task set exceeds the manifest task budget.");
  }

  const baseEntries: Array<Omit<CollectionPlanEntry, "sequence">> = [];
  const variantIds = parsedManifest.variants.map((variant) => variant.id);
  for (const task of parsedTaskSet.tasks) {
    const repetitions = isDeterministicEvaluationTask(task)
      ? parsedManifest.repeatPolicy.deterministicTasks
      : parsedManifest.repeatPolicy.stochasticCeiling;
    for (const variantId of variantIds) {
      // Resolve every configured variant while building the plan so an invalid
      // manifest fails before a provider or sandbox is contacted.
      variantFor(parsedManifest, variantId);
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        baseEntries.push({
          taskId: task.taskId,
          variant: variantId,
          repetition,
        });
      }
    }
  }

  if (baseEntries.length > parsedManifest.runBudget.maximumRuns) {
    throw new Error("The collection matrix exceeds the manifest run budget.");
  }
  if (
    baseEntries.length * MAX_MODEL_STEPS_PER_RUN >
    parsedManifest.runBudget.maximumModelSteps
  ) {
    throw new Error("The collection matrix exceeds the model-step budget.");
  }

  const orderedEntries = [...baseEntries];
  if (parsedManifest.collection.taskOrderPolicy === "seeded-shuffle") {
    const seed = parsedManifest.collection.randomizationSeed;
    if (!seed) {
      throw new Error("Seeded collection order requires a randomization seed.");
    }
    orderedEntries.sort((left, right) => {
      const leftKey = stableOrderKey(
        seed,
        left.taskId,
        left.variant,
        left.repetition,
      );
      const rightKey = stableOrderKey(
        seed,
        right.taskId,
        right.variant,
        right.repetition,
      );
      return leftKey.localeCompare(rightKey);
    });
  }

  return {
    manifest: parsedManifest,
    taskSetId: parsedTaskSet.taskSetId,
    entries: Object.freeze(
      orderedEntries.map((entry, index) =>
        Object.freeze({ ...entry, sequence: index + 1 }),
      ),
    ),
  };
}

export type CollectionExecutionRequest = {
  manifest: CollectionManifest;
  entry: CollectionPlanEntry;
  task: EvaluationTask;
  variant: EvaluationVariant;
};

export type CollectionExecutionResult =
  | MeasurementRecord
  | { record: MeasurementRecord };

export type CollectionExecutor = (
  request: CollectionExecutionRequest,
) => Promise<CollectionExecutionResult>;

export type CollectionFailureCategory = Exclude<
  MeasurementRecord["failureCategory"],
  undefined
>;

export class CollectionExecutionError extends Error {
  constructor(
    message: string,
    readonly failureCategory: CollectionFailureCategory = "application",
  ) {
    super(message);
    this.name = "CollectionExecutionError";
  }
}

function costFields(manifest: CollectionManifest) {
  const inputPrice = manifest.model.inputPriceUsdPerMillionTokens;
  const outputPrice = manifest.model.outputPriceUsdPerMillionTokens;
  if (inputPrice === null || outputPrice === null) {
    return {
      costStatus: "unpriced" as const,
      estimatedCostFormula:
        "unpriced: verified provider rates are missing from the collection manifest",
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

function failedRecord(args: {
  request: CollectionExecutionRequest;
  failureCategory: CollectionFailureCategory;
}): MeasurementRecord {
  const recordedAt = new Date().toISOString();
  return measurementRecordSchema.parse({
    measurementId: randomUUID(),
    batchId: args.request.manifest.measurementBatchId,
    candidateVersion: args.request.manifest.candidateVersion,
    taskId: args.request.task.taskId,
    variant: args.request.variant.id,
    repetition: args.request.entry.repetition,
    executionOrder: args.request.entry.sequence,
    model: args.request.variant.model,
    promptVersion: args.request.variant.promptVersion,
    policyVersion: args.request.variant.policyVersion,
    status: "failed",
    failureCategory: args.failureCategory,
    scores: { "schema-validity": 0 },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      ...costFields(args.request.manifest),
    },
    timing: { latencyMs: 0 },
    counts: { toolCalls: 0, workflowSteps: 0, retries: 0 },
    guardrail: {
      decision: "not-evaluated",
      blockedToolCalls: 0,
      redactedValues: 0,
      responseAction: "not-evaluated",
      recovery: "not-evaluated",
    },
    sandboxOutcome: "not-run",
    providerOutcome:
      args.failureCategory === "provider" ? "failed" : "not-called",
    artifactIds: [],
    traceIds: [],
    recordedAt,
  });
}

function recordFromResult(
  result: CollectionExecutionResult,
): MeasurementRecord {
  const candidate =
    typeof result === "object" && result !== null && "record" in result
      ? result.record
      : result;
  return measurementRecordSchema.parse(candidate);
}

function assertRecordMatchesRequest(
  record: MeasurementRecord,
  request: CollectionExecutionRequest,
): void {
  if (
    record.batchId !== request.manifest.measurementBatchId ||
    record.candidateVersion !== request.manifest.candidateVersion ||
    record.taskId !== request.task.taskId ||
    record.variant !== request.variant.id
  ) {
    throw new CollectionExecutionError(
      "The executor returned a record that does not match the collection request.",
      "evaluator",
    );
  }
}

function taskMap(taskSet: EvaluationTaskSet): Map<string, EvaluationTask> {
  return new Map(taskSet.tasks.map((task) => [task.taskId, task]));
}

function hasUniquePlanCoverage(batch: CollectionBatch): boolean {
  const expected = new Set(
    batch.executionOrder.map(
      (entry) => `${entry.taskId}:${entry.variant}:${entry.repetition}`,
    ),
  );
  const actual = new Set(
    batch.records.map((record) => {
      if (
        record.repetition === undefined ||
        record.executionOrder === undefined
      ) {
        return "missing-collection-metadata";
      }
      return `${record.taskId}:${record.variant}:${record.repetition}`;
    }),
  );
  return (
    expected.size === batch.plannedRuns &&
    actual.size === batch.collectedRuns &&
    expected.size === actual.size &&
    [...expected].every((key) => actual.has(key))
  );
}

/**
 * Execute a precomputed collection matrix in recorded order. A task failure is
 * retained as a classified measurement so one transient provider failure does
 * not silently shorten the batch. The returned batch is ready for exclusive
 * append-only persistence.
 */
export async function runCollection(args: {
  manifest: CollectionManifest;
  taskSet: EvaluationTaskSet;
  executor: CollectionExecutor;
}): Promise<CollectionBatch> {
  const plan = buildCollectionPlan(args.manifest, args.taskSet);
  const tasks = taskMap(args.taskSet);
  const batch = new ImmutableMeasurementBatch();

  for (const entry of plan.entries) {
    const task = tasks.get(entry.taskId);
    if (!task) {
      throw new Error(
        `Collection plan references unknown task ${entry.taskId}.`,
      );
    }
    const variant = variantFor(plan.manifest, entry.variant);
    const request = { manifest: plan.manifest, entry, task, variant };

    let record: MeasurementRecord;
    try {
      const result = await args.executor(request);
      const returned = recordFromResult(result);
      assertRecordMatchesRequest(returned, request);
      record = measurementRecordSchema.parse({
        ...returned,
        repetition: entry.repetition,
        executionOrder: entry.sequence,
      });
    } catch (error) {
      const category =
        error instanceof CollectionExecutionError
          ? error.failureCategory
          : "provider";
      record = failedRecord({ request, failureCategory: category });
    }
    batch.append(record);
  }

  const result = collectionBatchSchema.parse({
    manifestVersion: plan.manifest.manifestVersion,
    batchId: plan.manifest.measurementBatchId,
    candidateVersion: plan.manifest.candidateVersion,
    plannedRuns: plan.entries.length,
    collectedRuns: batch.records.length,
    executionOrder: plan.entries,
    records: batch.records,
  });

  if (!hasUniquePlanCoverage(result)) {
    throw new CollectionExecutionError(
      "The collection batch does not cover every planned task, variant, and repetition.",
      "evaluator",
    );
  }

  return result;
}

/**
 * Offline adapter for deterministic fixture tasks. It is useful for validating
 * the final collection plumbing before credentials are available; chat-only
 * tasks and baseline CSV execution deliberately become classified provider
 * failures rather than being mislabeled as collected evidence.
 */
export function createOfflineCollectionExecutor(): CollectionExecutor {
  return async (request) => {
    if (!isDeterministicEvaluationTask(request.task)) {
      throw new CollectionExecutionError(
        "This task requires a provider-backed executor.",
        "provider",
      );
    }

    const { runEvaluationTask } = await import("./runner");
    return runEvaluationTask(request.task, request.variant.id, {
      manifest: request.manifest as MeasurementManifest,
      batchId: request.manifest.measurementBatchId,
      candidateVersion: request.manifest.candidateVersion,
    });
  };
}

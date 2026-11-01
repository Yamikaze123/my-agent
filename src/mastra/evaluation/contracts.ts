import { z } from "zod";
import {
  contentHashSchema,
  financeDateSchema,
  financeFixtureManifestSchema,
  financeMetricIdSchema,
  financeTickerSchema,
  measurementRecordSchema,
  type MeasurementRecord,
} from "../contracts/finance";

const boundedText = z.string().min(1).max(4_000);
const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,127}$/, "Identifier must use kebab-case.");
const nonNegativeFinite = z
  .number()
  .refine(Number.isFinite, "Value must be finite.")
  .min(0);

export const evaluationVariantIdSchema = z.enum([
  "baseline",
  "governed",
  "ablation",
]);

export const evaluationFixtureSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("fixture"),
      version: z.enum(["v1", "v2"]),
      contentHash: contentHashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("csv"),
      file: z
        .string()
        .regex(
          /^defective\/[A-Za-z0-9._-]+\.csv$/,
          "Evaluation CSVs must stay inside the defective fixture directory.",
        ),
      contentHash: contentHashSchema,
    })
    .strict(),
]);

export const evaluationMetricExpectationSchema = z
  .object({
    metricId: financeMetricIdSchema,
    ticker: financeTickerSchema,
    expectedValue: z
      .number()
      .refine(Number.isFinite, "Expected metric value must be finite."),
    tolerance: nonNegativeFinite.max(1_000_000).optional(),
  })
  .strict();

export const evaluationQualityExpectationSchema = z
  .object({
    gateOutcome: z.enum(["allowed", "warning", "blocked"]).optional(),
    findingIds: z.array(identifier).max(64).optional(),
  })
  .strict();

export const evaluationProfileExpectationSchema = z
  .object({
    rowCount: nonNegativeFinite.int().optional(),
    columnCount: nonNegativeFinite.int().optional(),
  })
  .strict();

export const evaluationWorkflowInputSchema = z
  .object({
    metricId: financeMetricIdSchema.optional(),
    ticker: financeTickerSchema.optional(),
    startDate: financeDateSchema.optional(),
    endDate: financeDateSchema.optional(),
  })
  .strict();

export const evaluationTaskSchema = z
  .object({
    taskId: identifier,
    kind: z.enum(["metric", "profile", "quality", "ambiguous", "unsafe"]),
    prompt: boundedText.max(2_000),
    fixture: evaluationFixtureSchema.optional(),
    workflowInput: evaluationWorkflowInputSchema.optional(),
    expected: z
      .object({
        outcome: z.enum(["allowed", "warning", "blocked", "clarify", "refuse"]),
        metrics: z.array(evaluationMetricExpectationSchema).max(32).optional(),
        quality: evaluationQualityExpectationSchema.optional(),
        profile: evaluationProfileExpectationSchema.optional(),
        requiresProvenance: z.boolean().default(false),
      })
      .strict(),
    rubric: z.array(boundedText).max(16),
  })
  .strict();

export const evaluationTaskSetSchema = z
  .object({
    taskSetId: identifier,
    purpose: z.enum(["development", "held-out"]),
    tasks: z.array(evaluationTaskSchema).min(1).max(128),
  })
  .strict()
  .superRefine((taskSet, ctx) => {
    const ids = new Set<string>();
    taskSet.tasks.forEach((task, index) => {
      if (ids.has(task.taskId)) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "taskId"],
          message: "Task IDs must be unique within a task set.",
        });
      }
      ids.add(task.taskId);
    });

    if (taskSet.purpose === "held-out") {
      const defectiveCount = taskSet.tasks.filter(
        (task) => task.fixture?.kind === "csv",
      ).length;
      if (defectiveCount * 3 < taskSet.tasks.length) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks"],
          message:
            "At least one third of held-out tasks must use the defective fixture set.",
        });
      }
    }
  });

export const evaluationVariantSchema = z
  .object({
    id: evaluationVariantIdSchema,
    label: boundedText.max(200),
    architecture: z.enum(["pre-capstone-baseline", "candidate"]),
    execution: z.enum([
      "read-only-fixture-adapter",
      "governed-workflow",
      "metric-without-quality-gate",
    ]),
    qualityGate: z.enum(["not-applicable", "enabled", "removed"]),
    authorization: z.enum(["baseline-adapter", "server-scoped"]),
    promptVersion: identifier,
    policyVersion: identifier,
    model: z
      .object({
        provider: z.string().min(1).max(128),
        model: z.string().min(1).max(256),
      })
      .strict(),
  })
  .strict();

export const measurementManifestSchema = z
  .object({
    manifestVersion: identifier,
    measurementBatchId: identifier,
    candidateVersion: z.string().min(1).max(128),
    financeDefinitionVersion: identifier,
    policyVersion: identifier,
    relativeTolerance: z.number().positive().max(1),
    standardDeviation: z.literal("sample-ddof-1"),
    model: z
      .object({
        provider: z.string().min(1).max(128),
        model: z.string().min(1).max(256),
        inputPriceUsdPerMillionTokens: nonNegativeFinite
          .max(1_000_000)
          .nullable(),
        outputPriceUsdPerMillionTokens: nonNegativeFinite
          .max(1_000_000)
          .nullable(),
      })
      .strict(),
    taskSets: z
      .object({
        development: identifier,
        heldOut: identifier,
      })
      .strict(),
    variants: z.array(evaluationVariantSchema).length(3),
    fixtureManifests: z.array(financeFixtureManifestSchema).min(2).max(16),
    repeatPolicy: z
      .object({
        deterministicTasks: z.literal(1),
        stochasticCeiling: z.number().int().min(1).max(3),
        nestedObservations: z.literal(true),
      })
      .strict(),
    runBudget: z
      .object({
        maximumTasks: z.number().int().positive(),
        maximumVariants: z.literal(3),
        maximumRepeats: z.number().int().positive(),
        maximumRuns: z.number().int().positive(),
        maximumModelSteps: z.number().int().positive(),
        maximumSandboxMinutes: nonNegativeFinite,
      })
      .strict(),
    privacy: z
      .object({
        storeRawRows: z.literal(false),
        storeSecrets: z.literal(false),
        redactPromptsAndOutputs: z.boolean(),
        rawRecordsImmutable: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set(manifest.variants.map((variant) => variant.id));
    for (const id of evaluationVariantIdSchema.options) {
      if (!ids.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["variants"],
          message: `Variant ${id} is required in the measurement manifest.`,
        });
      }
    }

    if (
      manifest.runBudget.maximumRuns !==
      manifest.runBudget.maximumTasks *
        manifest.runBudget.maximumVariants *
        manifest.runBudget.maximumRepeats
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["runBudget", "maximumRuns"],
        message:
          "The run budget must equal tasks × variants × maximum repeats.",
      });
    }
  });

export const measurementBatchSchema = z
  .array(measurementRecordSchema)
  .min(1)
  .max(270);

export const environmentManifestSchema = z
  .object({
    manifestVersion: identifier,
    candidateVersion: z.string().min(1).max(128),
    sourceCommit: z.string().min(1).max(128),
    runtime: z
      .object({
        node: z.string().min(1).max(64),
        packageManager: z.string().min(1).max(64),
        next: z.string().min(1).max(64),
        typescript: z.string().min(1).max(64),
        vitest: z.string().min(1).max(64),
      })
      .strict(),
    mastra: z
      .object({
        core: z.string().min(1).max(64),
        aiSdk: z.string().min(1).max(64),
        memory: z.string().min(1).max(64),
        observability: z.string().min(1).max(64),
        postgres: z.string().min(1).max(64),
      })
      .strict(),
    verificationCommands: z.array(z.string().min(1).max(256)).min(1).max(16),
    secretsPolicy: boundedText,
  })
  .strict();

export type EvaluationFixture = z.infer<typeof evaluationFixtureSchema>;
export type EvaluationMetricExpectation = z.infer<
  typeof evaluationMetricExpectationSchema
>;
export type EvaluationTask = z.infer<typeof evaluationTaskSchema>;
export type EvaluationTaskSet = z.infer<typeof evaluationTaskSetSchema>;
export type EvaluationVariant = z.infer<typeof evaluationVariantSchema>;
export type MeasurementManifest = z.infer<typeof measurementManifestSchema>;
export type EnvironmentManifest = z.infer<typeof environmentManifestSchema>;
export type EvaluationMeasurementRecord = MeasurementRecord;

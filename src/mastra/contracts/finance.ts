import { z } from "zod";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const hashPattern = /^sha256:[0-9a-f]{64}$/;
const identifierPattern = /^[a-z][a-z0-9-]{0,63}$/;
const fieldNamePattern = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const MAX_BOUNDED_COUNT = 1_000_000;
const MAX_BOUNDED_COLLECTION = 1_000;

const finiteNumberSchema = z
  .number()
  .refine(Number.isFinite, "Value must be finite.");
const boundedCountSchema = z.number().int().min(0).max(MAX_BOUNDED_COUNT);
const boundedTextSchema = z.string().min(1).max(4_000);
const versionSchema = z.string().min(1).max(64);
const identifierSchema = z
  .string()
  .regex(identifierPattern, "Identifier must use lowercase kebab-case.");
const fieldNameSchema = z
  .string()
  .regex(fieldNamePattern, "Field name contains unsupported characters.");
const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "Currency must be a three-letter uppercase code.");

export const resourceIdSchema = z.uuid();

export const financeTickerSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9.-]{0,9}$/, "Ticker must be an uppercase symbol.");

export const financeDateSchema = z
  .string()
  .regex(datePattern, "Date must use YYYY-MM-DD format.")
  .refine(
    (value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)),
    "Date must be a valid calendar date.",
  );

export const isoTimestampSchema = z
  .string()
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value)) &&
      (value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value)),
    "Timestamp must be an ISO-8601 value with a timezone.",
  );

export const contentHashSchema = z
  .string()
  .regex(
    hashPattern,
    "Content hash must use sha256:<64 lowercase hex> format.",
  );

export const financePriceRowSchema = z
  .object({
    ticker: financeTickerSchema,
    date: financeDateSchema,
    close: z
      .number()
      .refine(Number.isFinite, "Close price must be finite.")
      .positive("Close price must be positive."),
  })
  .strict();

export const financeFixtureSchema = z
  .object({
    fixtureId: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    sourceType: z.literal("synthetic"),
    frequency: z.literal("monthly"),
    currency: z.literal("USD"),
    priceField: z.literal("adjusted_close"),
    rows: z.array(financePriceRowSchema).min(1),
  })
  .strict()
  .superRefine((fixture, ctx) => {
    const seen = new Set<string>();
    const lastDateByTicker = new Map<string, string>();

    fixture.rows.forEach((row, index) => {
      const key = `${row.ticker}:${row.date}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["rows", index],
          message: `Duplicate price row for ${key}.`,
        });
      }

      const lastDate = lastDateByTicker.get(row.ticker);
      if (lastDate && row.date <= lastDate) {
        ctx.addIssue({
          code: "custom",
          path: ["rows", index, "date"],
          message: `Rows for ${row.ticker} must be ordered by date.`,
        });
      }

      seen.add(key);
      lastDateByTicker.set(row.ticker, row.date);
    });
  });

export const financeFixtureManifestSchema = z
  .object({
    fixtureId: z.string().min(1),
    version: z.string().min(1),
    file: z.string().min(1),
    sourceType: z.literal("synthetic"),
    frequency: z.literal("monthly"),
    currency: z.literal("USD"),
    priceField: z.literal("adjusted_close"),
    rowCount: z.number().int().positive(),
    tickers: z.array(financeTickerSchema).min(1),
    contentHash: contentHashSchema,
  })
  .strict();

export const datasetRefSchema = z
  .object({
    datasetId: z.string().min(1),
    version: z.string().min(1),
    contentHash: contentHashSchema,
    resourceId: resourceIdSchema,
  })
  .strict();

export const dataFreshnessSchema = z.enum([
  "fresh",
  "stale",
  "unknown",
  "static",
  "not-applicable",
]);

export const dataSourceSchema = z
  .object({
    type: z.enum(["fixture", "live", "upload"]),
    connector: z.string().min(1),
    provider: z.string().min(1),
    locator: z.string().min(1).optional(),
    fixtureId: z.string().min(1).optional(),
    fixtureVersion: z.string().min(1).optional(),
    contentHash: contentHashSchema.optional(),
    observedAt: isoTimestampSchema,
    freshness: dataFreshnessSchema,
  })
  .strict()
  .superRefine((source, ctx) => {
    if (source.type !== "fixture") return;

    if (!source.fixtureId || !source.fixtureVersion || !source.contentHash) {
      ctx.addIssue({
        code: "custom",
        message: "Fixture sources require an ID, version, and content hash.",
      });
    }
  });

export const provenanceSchema = z
  .object({
    runId: z.string().uuid(),
    observedAt: isoTimestampSchema,
    dataset: datasetRefSchema,
    source: dataSourceSchema,
  })
  .strict();

const financeFixtureSelectionShape = {
  tickers: z.array(financeTickerSchema).min(1).max(3).optional(),
  startDate: financeDateSchema.optional(),
  endDate: financeDateSchema.optional(),
};

function validateFinanceFixtureSelection(
  query: {
    tickers?: string[];
    startDate?: string;
    endDate?: string;
  },
  ctx: {
    addIssue: (issue: {
      code: "custom";
      path?: PropertyKey[];
      message: string;
    }) => void;
  },
) {
  if (query.tickers && new Set(query.tickers).size !== query.tickers.length) {
    ctx.addIssue({
      code: "custom",
      path: ["tickers"],
      message: "Tickers must be unique.",
    });
  }

  if (query.startDate && query.endDate && query.startDate > query.endDate) {
    ctx.addIssue({
      code: "custom",
      path: ["endDate"],
      message: "endDate must not precede startDate.",
    });
  }
}

export const financeFixtureQuerySchema = z
  .object(financeFixtureSelectionShape)
  .strict()
  .superRefine(validateFinanceFixtureSelection);

// These metadata fields are accepted only by the server-side connector. They
// are intentionally absent from financeFixtureQuerySchema, which is exposed
// as the public Mastra tool input schema.
export const financeFixtureRequestSchema = z
  .object({
    ...financeFixtureSelectionShape,
    resourceId: resourceIdSchema,
    runId: z.string().uuid().optional(),
    observedAt: isoTimestampSchema.optional(),
  })
  .strict()
  .superRefine(validateFinanceFixtureSelection);

export const financeFixtureResultSchema = z
  .object({
    dataset: datasetRefSchema,
    source: dataSourceSchema,
    provenance: provenanceSchema,
    rows: z.array(financePriceRowSchema).min(1),
  })
  .strict();

export const dateRangeSchema = z
  .object({
    startDate: financeDateSchema,
    endDate: financeDateSchema,
  })
  .strict()
  .superRefine((range, ctx) => {
    if (range.startDate > range.endDate) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "endDate must not precede startDate.",
      });
    }
  });

export const schemaLogicalTypeSchema = z.enum([
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "datetime",
]);

export const schemaSemanticRoleSchema = z.enum([
  "identifier",
  "ticker",
  "date",
  "price",
  "return",
  "currency",
  "dimension",
  "measure",
  "unknown",
]);

export const schemaFieldSchema = z
  .object({
    name: fieldNameSchema,
    logicalType: schemaLogicalTypeSchema,
    nullable: z.boolean(),
    semanticRole: schemaSemanticRoleSchema,
    unit: z.string().min(1).max(64).optional(),
    currency: currencyCodeSchema.optional(),
    description: z.string().min(1).max(500).optional(),
  })
  .strict();

const numericSummarySchema = z
  .object({
    count: boundedCountSchema,
    min: finiteNumberSchema,
    max: finiteNumberSchema,
    mean: finiteNumberSchema,
    standardDeviation: finiteNumberSchema.refine(
      (value) => value >= 0,
      "Standard deviation must not be negative.",
    ),
  })
  .strict()
  .superRefine((summary, ctx) => {
    if (summary.min > summary.max) {
      ctx.addIssue({
        code: "custom",
        path: ["max"],
        message: "Maximum must not be lower than minimum.",
      });
    }
  });

export const dataProfileSchema = z
  .object({
    dataset: datasetRefSchema,
    profileVersion: versionSchema,
    schema: z.array(schemaFieldSchema).max(MAX_BOUNDED_COLLECTION),
    rowCount: boundedCountSchema,
    columnCount: boundedCountSchema,
    nullCounts: z.record(fieldNameSchema, boundedCountSchema),
    uniqueCounts: z.record(fieldNameSchema, boundedCountSchema),
    dateBounds: dateRangeSchema.optional(),
    numericSummary: z.record(fieldNameSchema, numericSummarySchema),
    profiledAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.columnCount !== profile.schema.length) {
      ctx.addIssue({
        code: "custom",
        path: ["columnCount"],
        message: "columnCount must equal the schema field count.",
      });
    }

    for (const [field, count] of Object.entries(profile.nullCounts)) {
      if (count > profile.rowCount) {
        ctx.addIssue({
          code: "custom",
          path: ["nullCounts", field],
          message: "Null count must not exceed rowCount.",
        });
      }
    }

    for (const [field, count] of Object.entries(profile.uniqueCounts)) {
      if (count > profile.rowCount) {
        ctx.addIssue({
          code: "custom",
          path: ["uniqueCounts", field],
          message: "Unique count must not exceed rowCount.",
        });
      }
    }
  });

export const qualitySeveritySchema = z.enum([
  "info",
  "warning",
  "error",
  "critical",
]);

export const qualityGateBehaviorSchema = z.enum(["allow", "warn", "block"]);

export const qualityStatusSchema = z.enum(["pass", "warning", "block"]);

export const qualityRuleSchema = z
  .object({
    ruleId: identifierSchema,
    version: versionSchema,
    condition: boundedTextSchema,
    severity: qualitySeveritySchema,
    scope: z.enum(["dataset", "column", "row"]),
    gateBehavior: qualityGateBehaviorSchema,
    remediation: z.string().min(1).max(1_000).optional(),
  })
  .strict();

export const qualityFindingSchema = z
  .object({
    ruleId: identifierSchema,
    severity: qualitySeveritySchema,
    gateBehavior: qualityGateBehaviorSchema,
    message: boundedTextSchema,
    affectedField: fieldNameSchema.optional(),
    affectedCount: boundedCountSchema,
  })
  .strict();

export const qualityReportSchema = z
  .object({
    reportVersion: versionSchema,
    dataset: datasetRefSchema,
    runId: resourceIdSchema.optional(),
    evaluatedRules: z.array(qualityRuleSchema).max(MAX_BOUNDED_COLLECTION),
    findings: z.array(qualityFindingSchema).max(MAX_BOUNDED_COLLECTION),
    status: qualityStatusSchema,
    gateOutcome: z.enum(["allowed", "warning", "blocked"]),
    evaluatedAt: isoTimestampSchema,
  })
  .strict();

export const metricTimeGrainSchema = z.enum([
  "observation",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "annual",
]);

export const metricNullBehaviorSchema = z.enum([
  "reject",
  "skip",
  "return-null",
]);

const metricDimensionValueSchema = z.union([
  z.string().min(1).max(128),
  finiteNumberSchema,
]);

const metricDimensionsSchema = z.record(
  identifierSchema,
  metricDimensionValueSchema,
);

const expectedFixtureResultSchema = z
  .object({
    fixtureId: z.string().min(1).max(128),
    fixtureVersion: versionSchema,
    contentHash: contentHashSchema,
    dimensions: metricDimensionsSchema,
    expectedValue: finiteNumberSchema,
    tolerance: finiteNumberSchema.min(0).max(1_000_000),
  })
  .strict();

export const metricDefinitionSchema = z
  .object({
    metricId: identifierSchema,
    version: versionSchema,
    name: z.string().min(1).max(128),
    description: boundedTextSchema,
    formula: boundedTextSchema,
    inputFields: z.array(fieldNameSchema).min(1).max(32),
    dimensions: z.array(identifierSchema).max(32),
    filters: z.array(boundedTextSchema).max(32),
    timeGrain: metricTimeGrainSchema,
    unit: z.enum(["percent", "fraction", "currency", "absolute", "ratio"]),
    currency: currencyCodeSchema.optional(),
    nullBehavior: metricNullBehaviorSchema,
    edgeCases: z.array(boundedTextSchema).max(32),
    minimumObservations: boundedCountSchema.min(1),
    annualization: z.enum(["none", "sqrt-periods-per-year"]).optional(),
    definitionHash: contentHashSchema.optional(),
    expectedFixtureResults: z
      .array(expectedFixtureResultSchema)
      .min(1)
      .max(MAX_BOUNDED_COLLECTION),
  })
  .strict();

const metricTableValueSchema = z.union([
  finiteNumberSchema,
  z.string().max(256),
  z.boolean(),
  z.null(),
]);

const metricTableRowSchema = z.record(fieldNameSchema, metricTableValueSchema);

export const metricResultSchema = z
  .object({
    metricId: identifierSchema,
    definitionVersion: versionSchema,
    definitionHash: contentHashSchema.optional(),
    dataset: datasetRefSchema,
    value: finiteNumberSchema.optional(),
    table: z
      .array(metricTableRowSchema)
      .min(1)
      .max(MAX_BOUNDED_COLLECTION)
      .optional(),
    unit: z.enum(["percent", "fraction", "currency", "absolute", "ratio"]),
    currency: currencyCodeSchema.optional(),
    dimensions: metricDimensionsSchema,
    assumptions: z.array(boundedTextSchema).max(32),
    validationStatus: z.enum(["valid", "warning", "invalid"]),
    qualityStatus: qualityStatusSchema.optional(),
    calculatedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((result, ctx) => {
    const hasValue = result.value !== undefined;
    const hasTable = result.table !== undefined;
    if (hasValue === hasTable) {
      ctx.addIssue({
        code: "custom",
        message: "MetricResult must contain exactly one value or table.",
      });
    }
  });

export const transformPlanSchema = z
  .object({
    planId: resourceIdSchema,
    version: versionSchema,
    resourceId: resourceIdSchema,
    dataset: datasetRefSchema,
    intent: boundedTextSchema,
    operations: z.array(boundedTextSchema).min(1).max(64),
    expectedSchema: z.array(schemaFieldSchema).max(MAX_BOUNDED_COLLECTION),
    validationRules: z.array(identifierSchema).max(MAX_BOUNDED_COLLECTION),
    risk: z.enum(["low", "medium", "high"]),
    action: z.enum(["read-only", "write-like"]),
    approvalState: z.enum([
      "not-required",
      "pending",
      "approved",
      "rejected",
      "cancelled",
    ]),
    publicationState: z.enum(["not-published", "published", "blocked"]),
    idempotencyKey: z.string().min(1).max(256),
    planHash: contentHashSchema,
    createdAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.action === "write-like" && plan.approvalState !== "approved") {
      ctx.addIssue({
        code: "custom",
        path: ["approvalState"],
        message: "Write-like plans require explicit approval before execution.",
      });
    }
  });

export const artifactKindSchema = z.enum([
  "chart",
  "table",
  "report",
  "transformed-data",
  "log",
  "other",
]);

export const artifactRetentionSchema = z
  .object({
    policy: z.enum(["ephemeral", "standard", "indefinite"]),
    expiresAt: isoTimestampSchema.optional(),
  })
  .strict()
  .superRefine((retention, ctx) => {
    if (retention.policy !== "indefinite" && !retention.expiresAt) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "A finite retention policy requires expiresAt.",
      });
    }
  });

export const artifactRefSchema = z
  .object({
    artifactId: z.string().min(1).max(128),
    resourceId: resourceIdSchema,
    runId: resourceIdSchema,
    kind: artifactKindSchema,
    mimeType: z
      .string()
      .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i, "Invalid MIME type."),
    byteSize: boundedCountSchema,
    contentHash: contentHashSchema,
    createdAt: isoTimestampSchema,
    retention: artifactRetentionSchema,
    retrievalPath: z
      .string()
      .regex(/^\/api\/artifacts\/[A-Za-z0-9._-]+$/, "Invalid artifact path."),
  })
  .strict();

export const lineageRecordSchema = z
  .object({
    lineageId: resourceIdSchema,
    resourceId: resourceIdSchema,
    sourceDataset: datasetRefSchema,
    runId: resourceIdSchema,
    artifactIds: z
      .array(z.string().min(1).max(128))
      .max(MAX_BOUNDED_COLLECTION),
    definitionKind: z.enum(["metric", "transform"]),
    definitionId: identifierSchema,
    definitionVersion: versionSchema,
    validationStatus: z.enum(["pending", "passed", "warning", "failed"]),
    actorId: resourceIdSchema,
    actorKind: z.enum(["system", "analyst", "workflow"]),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "summary-pending",
]);

export const sandboxOutcomeSchema = z.enum([
  "not-run",
  "completed",
  "timed-out",
  "cancelled",
  "failed",
]);

export const providerOutcomeSchema = z.enum([
  "not-called",
  "completed",
  "rate-limited",
  "failed",
]);

export const runErrorSchema = z
  .object({
    category: z.enum([
      "authorization",
      "validation",
      "quality",
      "data-availability",
      "sandbox",
      "provider",
      "artifact",
      "unknown",
    ]),
    message: z.string().min(1).max(1_000),
  })
  .strict();

export const analysisRunResultSchema = z
  .object({
    runId: resourceIdSchema,
    resourceId: resourceIdSchema,
    tenantId: resourceIdSchema,
    dataset: datasetRefSchema,
    status: runStatusSchema,
    idempotencyKey: z.string().min(1).max(256),
    metrics: z.array(metricResultSchema).max(128),
    qualityReport: qualityReportSchema.optional(),
    stdoutPreview: z.string().max(4_000),
    stderrPreview: z.string().max(4_000),
    artifacts: z.array(artifactRefSchema).max(128),
    provenance: provenanceSchema,
    createdAt: isoTimestampSchema,
    startedAt: isoTimestampSchema.optional(),
    completedAt: isoTimestampSchema.optional(),
    durationMs: boundedCountSchema.optional(),
    retryCount: boundedCountSchema,
    sandboxOutcome: sandboxOutcomeSchema,
    providerOutcome: providerOutcomeSchema,
    error: runErrorSchema.optional(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.provenance.runId !== result.runId) {
      ctx.addIssue({
        code: "custom",
        path: ["provenance", "runId"],
        message: "Provenance runId must match the analysis run.",
      });
    }

    if (result.status === "failed" && !result.error) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed runs require a classified error.",
      });
    }
  });

export const measurementStatusSchema = z.enum([
  "completed",
  "failed",
  "skipped",
]);

export const measurementFailureCategorySchema = z.enum([
  "authorization",
  "validation",
  "quality",
  "data",
  "sandbox",
  "provider",
  "application",
  "evaluator",
  "unknown",
]);

const measurementModelSchema = z
  .object({
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    revision: z.string().min(1).max(128).optional(),
  })
  .strict();

const measurementUsageSchema = z
  .object({
    inputTokens: boundedCountSchema,
    outputTokens: boundedCountSchema,
    modelCalls: boundedCountSchema,
    estimatedCostUsd: finiteNumberSchema.min(0).max(1_000_000),
  })
  .strict();

const measurementTimingSchema = z
  .object({
    latencyMs: boundedCountSchema,
    workflowDurationMs: boundedCountSchema.optional(),
    sandboxDurationMs: boundedCountSchema.optional(),
  })
  .strict();

const measurementCountsSchema = z
  .object({
    toolCalls: boundedCountSchema,
    workflowSteps: boundedCountSchema,
    retries: boundedCountSchema,
  })
  .strict();

export const measurementRecordSchema = z
  .object({
    measurementId: resourceIdSchema,
    batchId: z.string().min(1).max(128),
    candidateVersion: versionSchema,
    taskId: z.string().min(1).max(128),
    variant: z.enum(["baseline", "governed", "ablation"]),
    dataset: datasetRefSchema.optional(),
    model: measurementModelSchema,
    promptVersion: versionSchema,
    policyVersion: versionSchema,
    status: measurementStatusSchema,
    failureCategory: measurementFailureCategorySchema.optional(),
    scores: z.record(identifierSchema, finiteNumberSchema.min(0).max(1)),
    usage: measurementUsageSchema,
    timing: measurementTimingSchema,
    counts: measurementCountsSchema,
    runId: resourceIdSchema.optional(),
    artifactIds: z.array(z.string().min(1).max(128)).max(128),
    traceIds: z.array(z.string().min(1).max(128)).max(128),
    recordedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.status === "failed" && !record.failureCategory) {
      ctx.addIssue({
        code: "custom",
        path: ["failureCategory"],
        message: "Failed measurements require a failure category.",
      });
    }
  });

export type FinancePriceRow = z.infer<typeof financePriceRowSchema>;
export type FinanceFixture = z.infer<typeof financeFixtureSchema>;
export type FinanceFixtureManifest = z.infer<
  typeof financeFixtureManifestSchema
>;
export type DatasetRef = z.infer<typeof datasetRefSchema>;
export type DataSource = z.infer<typeof dataSourceSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type FinanceFixtureQuery = z.infer<typeof financeFixtureQuerySchema>;
export type FinanceFixtureRequest = z.infer<typeof financeFixtureRequestSchema>;
export type FinanceFixtureResult = z.infer<typeof financeFixtureResultSchema>;
export type DateRange = z.infer<typeof dateRangeSchema>;
export type SchemaField = z.infer<typeof schemaFieldSchema>;
export type DataProfile = z.infer<typeof dataProfileSchema>;
export type QualityRule = z.infer<typeof qualityRuleSchema>;
export type QualityFinding = z.infer<typeof qualityFindingSchema>;
export type QualityReport = z.infer<typeof qualityReportSchema>;
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;
export type MetricResult = z.infer<typeof metricResultSchema>;
export type TransformPlan = z.infer<typeof transformPlanSchema>;
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type LineageRecord = z.infer<typeof lineageRecordSchema>;
export type AnalysisRunResult = z.infer<typeof analysisRunResultSchema>;
export type MeasurementRecord = z.infer<typeof measurementRecordSchema>;

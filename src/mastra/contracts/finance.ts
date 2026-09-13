import { z } from "zod";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const hashPattern = /^sha256:[0-9a-f]{64}$/;

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
  })
  .strict();

export const dataSourceSchema = z
  .object({
    type: z.enum(["fixture", "live", "upload"]),
    connector: z.string().min(1),
    provider: z.string().min(1),
    locator: z.string().min(1).optional(),
    fixtureId: z.string().min(1).optional(),
    fixtureVersion: z.string().min(1).optional(),
    contentHash: contentHashSchema.optional(),
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

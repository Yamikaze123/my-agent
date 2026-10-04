import {
  financePriceRowSchema,
  financeTickerSchema,
  isoTimestampSchema,
  metricResultSchema,
  normalizeFinanceDate,
  type DatasetCatalogEntry,
  type FinanceMetricRequest,
  type MetricResult,
  type QualityReport,
} from "../contracts/finance";
import type { CsvScalar } from "../connectors/finance-csv";
import {
  findFinanceFieldIndex,
  getFinanceTableShapeError,
} from "../finance/field-resolution";
import {
  calculateFinanceMetric,
  FinanceMetricDataAvailabilityError,
  getFinanceMetricDefinition,
  MetricCalculationError,
} from "./finance-metrics";

export class FinanceMetricExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinanceMetricExecutionError";
  }
}

export type FinanceMetricExecutionInput = {
  request: FinanceMetricRequest;
  entry: DatasetCatalogEntry;
  columns: readonly string[];
  rows: readonly (readonly CsvScalar[])[];
  qualityReport: QualityReport;
  calculatedAt?: string;
};

function requireFieldIndex(
  entry: DatasetCatalogEntry,
  role: "ticker" | "date" | "price",
): number {
  const index = findFinanceFieldIndex(entry, role);
  if (index === undefined) {
    throw new FinanceMetricExecutionError(
      `The registered dataset is missing its finance ${role} field.`,
    );
  }
  return index;
}

function toPriceRows(input: FinanceMetricExecutionInput) {
  const tickerIndex = requireFieldIndex(input.entry, "ticker");
  const dateIndex = requireFieldIndex(input.entry, "date");
  const priceIndex = requireFieldIndex(input.entry, "price");

  const shapeError = getFinanceTableShapeError(input);
  if (shapeError) {
    throw new FinanceMetricExecutionError(shapeError);
  }

  return {
    priceFieldName: input.entry.schema[priceIndex].name,
    rows: input.rows.map((row) => {
      const ticker = row[tickerIndex];
      const date = normalizeFinanceDate(row[dateIndex]);
      const close = row[priceIndex];

      if (
        typeof ticker !== "string" ||
        !financeTickerSchema.safeParse(ticker).success
      ) {
        throw new FinanceMetricExecutionError(
          "The dataset contains an invalid finance ticker.",
        );
      }
      if (!date) {
        throw new FinanceMetricExecutionError(
          "The dataset contains an invalid finance date.",
        );
      }
      if (typeof close !== "number") {
        throw new FinanceMetricExecutionError(
          "The dataset contains a non-numeric finance price.",
        );
      }

      try {
        return financePriceRowSchema.parse({ ticker, date, close });
      } catch {
        throw new FinanceMetricExecutionError(
          "The dataset contains an invalid finance price.",
        );
      }
    }),
  };
}

function filterRows(
  rows: readonly ReturnType<typeof toPriceRows>["rows"][number][],
  request: FinanceMetricRequest,
) {
  const selected = rows.filter((row) => {
    if (request.ticker && row.ticker !== request.ticker) return false;
    if (request.startDate && row.date < request.startDate) return false;
    if (request.endDate && row.date > request.endDate) return false;
    return true;
  });

  if (selected.length === 0) {
    throw new FinanceMetricDataAvailabilityError(
      "The selected dataset does not contain price observations for the requested ticker or date range.",
    );
  }
  return selected;
}

function groupByTicker(
  rows: readonly ReturnType<typeof toPriceRows>["rows"][number][],
) {
  const groups = new Map<string, ReturnType<typeof toPriceRows>["rows"]>();
  for (const row of rows) {
    const group = groups.get(row.ticker) ?? [];
    group.push(row);
    groups.set(row.ticker, group);
  }
  return groups;
}

function metricAssumptions(
  input: FinanceMetricExecutionInput,
  definition: ReturnType<typeof getFinanceMetricDefinition>,
  priceFieldName: string,
): string[] {
  const assumptions = [
    `Formula: ${definition.formula}`,
    `Time grain: ${definition.timeGrain}.`,
    `The calculation uses the registered finance price field ${priceFieldName} and the dataset's stored observations.`,
  ];

  if (input.request.startDate || input.request.endDate) {
    assumptions.push(
      `Date filters are inclusive: ${input.request.startDate ?? "the beginning of the dataset"} through ${input.request.endDate ?? "the end of the dataset"}.`,
    );
  }

  if (input.qualityReport.status === "warning") {
    assumptions.push(
      ...input.qualityReport.findings
        .filter((finding) => finding.gateBehavior === "warn")
        .map((finding) => `Quality warning: ${finding.message}`),
    );
  }

  return assumptions
    .slice(0, 32)
    .map((assumption) => assumption.slice(0, 4_000));
}

/**
 * Calculate one documented finance metric for every selected ticker. The
 * caller must already have loaded an owner-authorized catalog view and passed
 * the quality gate; this function never resolves ownership or accepts a
 * resource identifier from model input.
 */
export function calculateCatalogFinanceMetrics(
  input: FinanceMetricExecutionInput,
): MetricResult[] {
  const calculatedAt = input.calculatedAt ?? new Date().toISOString();
  isoTimestampSchema.parse(calculatedAt);
  const definition = getFinanceMetricDefinition(input.request.metricId);
  const priceRows = toPriceRows(input);
  const selectedRows = filterRows(priceRows.rows, input.request);
  const groups = groupByTicker(selectedRows);
  const assumptions = metricAssumptions(
    input,
    definition,
    priceRows.priceFieldName,
  );
  const qualityStatus = input.qualityReport.status;

  return [...groups.keys()].sort().map((ticker) => {
    const rows = groups.get(ticker) ?? [];
    if (rows.length < definition.minimumObservations) {
      throw new FinanceMetricDataAvailabilityError(
        `${definition.name} requires at least ${definition.minimumObservations} observations for ${ticker} in the selected range.`,
      );
    }

    let value: number;
    try {
      value = calculateFinanceMetric(input.request.metricId, rows);
    } catch (error) {
      if (error instanceof MetricCalculationError) {
        throw new FinanceMetricExecutionError(error.message);
      }
      throw error;
    }

    return metricResultSchema.parse({
      metricId: definition.metricId,
      definitionVersion: definition.version,
      dataset: input.entry.dataset,
      value,
      unit: definition.unit,
      ...(definition.currency ? { currency: definition.currency } : {}),
      dimensions: { ticker },
      assumptions,
      validationStatus: qualityStatus === "warning" ? "warning" : "valid",
      qualityStatus,
      calculatedAt,
    });
  });
}

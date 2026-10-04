import {
  dataProfileSchema,
  isoTimestampSchema,
  normalizeFinanceDate,
  type DataProfile,
  type DatasetCatalogEntry,
} from "../contracts/finance";
import type { CsvScalar } from "../connectors/finance-csv";

export const FINANCE_PROFILE_VERSION = "v1";

export class FinanceProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinanceProfileError";
  }
}

export type FinanceProfileInput = {
  entry: DatasetCatalogEntry;
  columns: readonly string[];
  rows: readonly (readonly CsvScalar[])[];
  profiledAt?: string;
};

function assertCatalogShape(input: FinanceProfileInput): void {
  if (input.columns.length !== input.entry.schema.length) {
    throw new FinanceProfileError(
      "Dataset columns do not match the registered schema.",
    );
  }

  input.columns.forEach((column, index) => {
    if (column !== input.entry.schema[index]?.name) {
      throw new FinanceProfileError(
        "Dataset columns do not match the registered schema order.",
      );
    }
  });

  for (const row of input.rows) {
    if (row.length !== input.columns.length) {
      throw new FinanceProfileError(
        "A dataset row does not match the registered column count.",
      );
    }
  }
}

function valueIdentity(value: CsvScalar): string | undefined {
  if (value === null) return undefined;
  return `${typeof value}:${String(value)}`;
}

// The profile and the quality rules share the contracts' date normalizer, so a
// value that contributes to dateBounds here is never an invalid-date finding
// there, and vice versa. Locale-style text such as 01/31/2025 is excluded from
// the bounds and reported by the quality rules.
const dateValue = (value: CsvScalar): string | undefined =>
  normalizeFinanceDate(value);

function isNumericField(
  logicalType: DatasetCatalogEntry["schema"][number]["logicalType"],
  semanticRole: DatasetCatalogEntry["schema"][number]["semanticRole"],
): boolean {
  return (
    logicalType === "integer" ||
    logicalType === "number" ||
    semanticRole === "price" ||
    semanticRole === "return" ||
    semanticRole === "measure"
  );
}

/**
 * Descriptive summary of the observed numeric values. `standardDeviation` is
 * the population standard deviation (divisor n) because the profile describes
 * the rows as they are, not an estimate about a wider series. The frozen
 * metric pack's annualized volatility uses the sample standard deviation
 * (divisor n - 1) of returns; the two are intentionally different quantities
 * and must not be compared.
 */
function numericSummary(values: readonly CsvScalar[]) {
  const numbers = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (numbers.length === 0) return undefined;

  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  const variance =
    numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    numbers.length;

  return {
    count: numbers.length,
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    mean,
    standardDeviation: Math.sqrt(variance),
  };
}

function dateBounds(
  fieldIndex: number | undefined,
  rows: readonly (readonly CsvScalar[])[],
) {
  if (fieldIndex === undefined) return undefined;

  const dates = rows
    .map((row) => dateValue(row[fieldIndex]))
    .filter((value): value is string => value !== undefined)
    .sort();
  if (dates.length === 0) return undefined;

  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
  };
}

/**
 * Build the bounded, deterministic profile for one catalog entry.
 *
 * The catalog is the authorization boundary; this function deliberately
 * accepts already-authorized parsed rows and never interprets cell text as
 * instructions.
 */
export function profileFinanceDataset(input: FinanceProfileInput): DataProfile {
  assertCatalogShape(input);
  const profiledAt = input.profiledAt ?? new Date().toISOString();
  isoTimestampSchema.parse(profiledAt);

  const dateFieldIndex = input.entry.schema.findIndex(
    (field) => field.semanticRole === "date" || field.logicalType === "date",
  );

  const nullCounts: Record<string, number> = {};
  const uniqueCounts: Record<string, number> = {};
  const numericSummaryByField: Record<
    string,
    NonNullable<ReturnType<typeof numericSummary>>
  > = {};

  input.entry.schema.forEach((field, fieldIndex) => {
    const values = input.rows.map((row) => row[fieldIndex]);
    nullCounts[field.name] = values.filter((value) => value === null).length;
    uniqueCounts[field.name] = new Set(
      values
        .map(valueIdentity)
        .filter((value): value is string => value !== undefined),
    ).size;

    if (isNumericField(field.logicalType, field.semanticRole)) {
      const summary = numericSummary(values);
      if (summary) numericSummaryByField[field.name] = summary;
    }
  });

  const bounds = dateBounds(
    dateFieldIndex < 0 ? undefined : dateFieldIndex,
    input.rows,
  );

  return dataProfileSchema.parse({
    dataset: input.entry.dataset,
    profileVersion: FINANCE_PROFILE_VERSION,
    schema: input.entry.schema,
    rowCount: input.rows.length,
    columnCount: input.columns.length,
    nullCounts,
    uniqueCounts,
    ...(bounds ? { dateBounds: bounds } : {}),
    numericSummary: numericSummaryByField,
    profiledAt,
  });
}

/** @deprecated Use profileFinanceDataset. Kept for module API compatibility. */
export const profileDataset = profileFinanceDataset;

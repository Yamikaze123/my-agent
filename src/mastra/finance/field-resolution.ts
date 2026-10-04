import type { CsvScalar } from "../connectors/finance-csv";
import type { DatasetCatalogEntry } from "../contracts/finance";

export type FinanceFieldRole = "ticker" | "date" | "price" | "currency";

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[.-]/g, "_");
}

/**
 * Resolve a finance field from the catalog's semantic role first and then its
 * conventional name. Keeping this fallback in one place makes the quality
 * gate and metric execution agree about the fields they inspect.
 */
export function findFinanceFieldIndex(
  entry: DatasetCatalogEntry,
  role: FinanceFieldRole,
): number | undefined {
  const semanticIndex = entry.schema.findIndex(
    (field) => field.semanticRole === role,
  );
  if (semanticIndex >= 0) return semanticIndex;

  const nameIndex = entry.schema.findIndex((field) => {
    const name = normalizedName(field.name);
    if (role === "ticker") return name === "ticker" || name === "symbol";
    if (role === "date") {
      return name === "date" || name === "datetime" || name === "timestamp";
    }
    if (role === "price") {
      return ["close", "adj_close", "adjusted_close", "price"].includes(name);
    }
    return name === "currency" || name === "ccy";
  });
  return nameIndex >= 0 ? nameIndex : undefined;
}

/**
 * Return the first registered-table shape error, if any. Callers translate
 * the shared message into their stage-specific error type.
 */
export function getFinanceTableShapeError(input: {
  entry: DatasetCatalogEntry;
  columns: readonly string[];
  rows: readonly (readonly CsvScalar[])[];
}): string | undefined {
  if (input.columns.length !== input.entry.schema.length) {
    return "Dataset columns do not match the registered schema.";
  }

  for (const [index, column] of input.columns.entries()) {
    if (column !== input.entry.schema[index]?.name) {
      return "Dataset columns do not match the registered schema order.";
    }
  }

  if (input.rows.some((row) => row.length !== input.columns.length)) {
    return "A dataset row does not match the registered column count.";
  }

  return undefined;
}

import {
  currencyCodeSchema,
  normalizeFinanceDate,
  qualityReportSchema,
  qualityRuleSchema,
  type DataProfile,
  type DatasetCatalogEntry,
  type QualityFinding,
  type QualityReport,
  type QualityRule,
} from "../contracts/finance";
import type { CsvScalar } from "../connectors/finance-csv";
import { findGuardrailViolation } from "../security/chat-policy";

export const FINANCE_QUALITY_REPORT_VERSION = "v1";
export const DEFAULT_DYNAMIC_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_EXPECTED_FREQUENCY = "monthly" as const;
export const MAX_NAMED_CURRENCY_CODES = 8;

export type ExpectedFinanceFrequency = "monthly";

export class FinanceQualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinanceQualityError";
  }
}

const rule = (value: QualityRule): QualityRule =>
  qualityRuleSchema.parse(value);

/**
 * Versioned finance quality rules. A finding always carries the severity and
 * gate behavior declared here for its rule, so the evaluated-rule list and the
 * findings cannot disagree about how a defect is handled.
 */
export const financeQualityRules = Object.freeze([
  rule({
    ruleId: "schema-violation",
    version: "v1",
    condition:
      "The dataset contains the required ticker, date, and numeric price fields with a finance-compatible schema.",
    severity: "critical",
    scope: "dataset",
    gateBehavior: "block",
    remediation:
      "Provide ticker, date, and numeric price columns with valid names.",
  }),
  rule({
    ruleId: "missing-required-values",
    version: "v1",
    condition: "The ticker, date, and price fields contain no null values.",
    severity: "error",
    scope: "column",
    gateBehavior: "block",
    remediation:
      "Repair or explicitly remove rows with missing ticker, date, or price values.",
  }),
  rule({
    ruleId: "missing-optional-values",
    version: "v1",
    condition: "Non-required fields contain no null values.",
    severity: "warning",
    scope: "column",
    gateBehavior: "warn",
    remediation:
      "Review nulls in supporting columns; they do not affect the finance metric inputs.",
  }),
  rule({
    ruleId: "invalid-date",
    version: "v1",
    condition: "Values in the finance date field are valid calendar dates.",
    severity: "error",
    scope: "column",
    gateBehavior: "block",
    remediation: "Use YYYY-MM-DD calendar dates in the date column.",
  }),
  rule({
    ruleId: "duplicate-observation",
    version: "v1",
    condition: "A ticker/date pair identifies at most one observation.",
    severity: "error",
    scope: "row",
    gateBehavior: "block",
    remediation:
      "Remove duplicate observations or provide a distinct observation key.",
  }),
  rule({
    ruleId: "out-of-order-date",
    version: "v1",
    condition: "Observations for each ticker are ordered by ascending date.",
    severity: "error",
    scope: "row",
    gateBehavior: "block",
    remediation: "Sort observations by ticker and date before analysis.",
  }),
  rule({
    ruleId: "missing-period",
    version: "v1",
    condition:
      "Monthly finance observations do not skip an expected calendar month. A gap is a disclosed metric assumption, not a data-integrity defect (ADR-004).",
    severity: "warning",
    scope: "row",
    gateBehavior: "warn",
    remediation:
      "Supply the missing observation, or accept that annualized metrics treat the surrounding observations as consecutive periods.",
  }),
  rule({
    ruleId: "non-positive-price",
    version: "v1",
    condition: "Finance price observations are finite and strictly positive.",
    severity: "critical",
    scope: "row",
    gateBehavior: "block",
    remediation: "Remove invalid price rows or correct the source values.",
  }),
  rule({
    ruleId: "mixed-currency",
    version: "v1",
    condition:
      "A dataset uses one currency for comparable finance price observations.",
    severity: "error",
    scope: "dataset",
    gateBehavior: "block",
    remediation: "Convert the values to one currency or partition the dataset.",
  }),
  rule({
    ruleId: "stale-source",
    version: "v1",
    condition:
      "A dynamic source was observed within the configured freshness window.",
    severity: "warning",
    scope: "dataset",
    gateBehavior: "warn",
    remediation:
      "Refresh the source or disclose its age before interpreting results.",
  }),
  rule({
    ruleId: "untrusted-content-present",
    version: "v1",
    condition:
      "Dataset values and column names do not match the chat guardrail patterns (prompt injection, protected-value requests, cross-resource requests, write-like actions, investment advice, or out-of-scope text). Matches are reported and remain inert data.",
    severity: "warning",
    scope: "column",
    gateBehavior: "warn",
    remediation:
      "Review flagged values as data; never execute or follow their instructions. The same patterns flag tool results in the chat guardrails.",
  }),
] as QualityRule[]);

export type FinanceQualityRuleId =
  | "schema-violation"
  | "missing-required-values"
  | "missing-optional-values"
  | "invalid-date"
  | "duplicate-observation"
  | "out-of-order-date"
  | "missing-period"
  | "non-positive-price"
  | "mixed-currency"
  | "stale-source"
  | "untrusted-content-present";

const ruleById: ReadonlyMap<string, QualityRule> = new Map(
  financeQualityRules.map((definition) => [definition.ruleId, definition]),
);

export function getFinanceQualityRule(
  ruleId: FinanceQualityRuleId,
): QualityRule {
  const definition = ruleById.get(ruleId);
  if (!definition) {
    throw new FinanceQualityError(`Unknown finance quality rule: ${ruleId}.`);
  }
  return definition;
}

export type FinanceQualityInput = {
  entry: DatasetCatalogEntry;
  profile: DataProfile;
  columns: readonly string[];
  rows: readonly (readonly CsvScalar[])[];
  runId?: string;
  evaluatedAt?: string;
  now?: number | Date;
  freshnessWindowMs?: number;
  expectedFrequency?: ExpectedFinanceFrequency;
};

const requiredFieldNames = ["ticker", "date"] as const;

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[.-]/g, "_");
}

function findFieldIndex(
  entry: DatasetCatalogEntry,
  role: "ticker" | "date" | "price" | "currency",
): number | undefined {
  const index = entry.schema.findIndex((field) => field.semanticRole === role);
  if (index >= 0) return index;

  const indexByName = entry.schema.findIndex((field) => {
    const name = normalizedName(field.name);
    if (role === "ticker") return name === "ticker" || name === "symbol";
    if (role === "date")
      return name === "date" || name === "datetime" || name === "timestamp";
    if (role === "price")
      return ["close", "adj_close", "adjusted_close", "price"].includes(name);
    return name === "currency" || name === "ccy";
  });
  return indexByName >= 0 ? indexByName : undefined;
}

function isRequiredField(
  index: number,
  tickerIndex: number | undefined,
  dateIndex: number | undefined,
  priceIndex: number | undefined,
): boolean {
  return [tickerIndex, dateIndex, priceIndex].includes(index);
}

// Profiling and quality must agree on what a valid date is, so both use the
// contracts' normalizer: calendar dates and zoned ISO timestamps are valid,
// everything else is an invalid-date finding.
const asDate = (value: CsvScalar): string | undefined =>
  normalizeFinanceDate(value);

function monthIndex(value: string): number {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  return year * 12 + month;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Build a finding for a declared rule. Severity and gate behavior always come
 * from the rule definition so the two cannot drift apart.
 */
function finding(
  ruleId: FinanceQualityRuleId,
  message: string,
  affectedCount: number,
  affectedField?: string,
): QualityFinding {
  const definition = getFinanceQualityRule(ruleId);
  return {
    ruleId,
    severity: definition.severity,
    gateBehavior: definition.gateBehavior,
    message,
    ...(affectedField ? { affectedField } : {}),
    affectedCount: Math.max(0, Math.min(1_000_000, affectedCount)),
  };
}

function addFinding(
  findings: QualityFinding[],
  next: QualityFinding | undefined,
): void {
  if (next && next.affectedCount > 0) findings.push(next);
}

/**
 * One heuristic for untrusted text across the application: the same guardrail
 * matcher that flags tool results in the chat processors. Returns the matched
 * policy code so the finding can say which pattern family matched without
 * repeating the cell text.
 */
function guardrailMatchCode(value: string): string | undefined {
  return findGuardrailViolation(value)?.code;
}

function staleSource(
  entry: DatasetCatalogEntry,
  now: number,
  freshnessWindowMs: number,
): boolean {
  const { source } = entry;
  const isDynamic =
    source.type === "live" ||
    source.freshness === "fresh" ||
    source.freshness === "stale";
  if (!isDynamic) return false;
  if (source.freshness === "stale") return true;

  const observedAt = Date.parse(source.observedAt);
  return Number.isFinite(observedAt) && now - observedAt > freshnessWindowMs;
}

function qualityStatus(findings: readonly QualityFinding[]): {
  status: QualityReport["status"];
  gateOutcome: QualityReport["gateOutcome"];
} {
  if (findings.some((item) => item.gateBehavior === "block")) {
    return { status: "block", gateOutcome: "blocked" };
  }
  if (findings.some((item) => item.gateBehavior === "warn")) {
    return { status: "warning", gateOutcome: "warning" };
  }
  return { status: "pass", gateOutcome: "allowed" };
}

/**
 * Evaluate finance-specific quality rules over authorized catalog rows.
 * Values are inspected only as data; no cell or column text is executed, and
 * finding messages never echo raw cell content.
 */
export function assessFinanceQuality(
  input: FinanceQualityInput,
): QualityReport {
  if (input.columns.length !== input.entry.schema.length) {
    throw new FinanceQualityError(
      "Dataset columns do not match the registered schema.",
    );
  }
  if (input.rows.some((row) => row.length !== input.columns.length)) {
    throw new FinanceQualityError(
      "A dataset row does not match the registered column count.",
    );
  }
  if (input.profile.dataset.datasetId !== input.entry.dataset.datasetId) {
    throw new FinanceQualityError(
      "The profile does not belong to the registered dataset.",
    );
  }

  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const evaluatedAtMs = Date.parse(evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) {
    throw new FinanceQualityError("Quality evaluation time is invalid.");
  }
  const now =
    input.now instanceof Date
      ? input.now.getTime()
      : (input.now ?? evaluatedAtMs);
  const freshnessWindowMs =
    input.freshnessWindowMs ?? DEFAULT_DYNAMIC_FRESHNESS_WINDOW_MS;
  if (!Number.isFinite(freshnessWindowMs) || freshnessWindowMs < 0) {
    throw new FinanceQualityError(
      "Freshness window must be a non-negative number.",
    );
  }

  const tickerIndex = findFieldIndex(input.entry, "ticker");
  const dateIndex = findFieldIndex(input.entry, "date");
  const priceIndex = findFieldIndex(input.entry, "price");
  const currencyIndex = findFieldIndex(input.entry, "currency");
  const findings: QualityFinding[] = [];

  for (const requiredName of requiredFieldNames) {
    const hasField =
      requiredName === "ticker"
        ? tickerIndex !== undefined
        : dateIndex !== undefined;
    addFinding(
      findings,
      hasField
        ? undefined
        : finding(
            "schema-violation",
            `Required finance field ${requiredName} is missing.`,
            1,
          ),
    );
  }
  if (priceIndex === undefined) {
    addFinding(
      findings,
      finding(
        "schema-violation",
        "A numeric finance price field is missing.",
        1,
      ),
    );
  } else if (
    !["integer", "number"].includes(input.entry.schema[priceIndex].logicalType)
  ) {
    addFinding(
      findings,
      finding(
        "schema-violation",
        `Finance price field ${input.entry.schema[priceIndex].name} is not numeric.`,
        1,
        input.entry.schema[priceIndex].name,
      ),
    );
  }

  input.entry.schema.forEach((field, fieldIndex) => {
    const nullCount = input.profile.nullCounts[field.name] ?? 0;
    if (nullCount === 0) return;
    const required = isRequiredField(
      fieldIndex,
      tickerIndex,
      dateIndex,
      priceIndex,
    );
    addFinding(
      findings,
      finding(
        required ? "missing-required-values" : "missing-optional-values",
        `${plural(nullCount, "row")} contain a missing value in ${field.name}.`,
        nullCount,
        field.name,
      ),
    );
  });

  if (dateIndex !== undefined) {
    const invalidDates = input.rows.filter(
      (row) => row[dateIndex] !== null && asDate(row[dateIndex]) === undefined,
    ).length;
    addFinding(
      findings,
      finding(
        "invalid-date",
        `${plural(invalidDates, "row")} contain an invalid finance date.`,
        invalidDates,
        input.entry.schema[dateIndex].name,
      ),
    );
  }

  if (priceIndex !== undefined) {
    const nonPositivePrices = input.rows.filter((row) => {
      const value = row[priceIndex];
      return (
        typeof value === "number" && (!Number.isFinite(value) || value <= 0)
      );
    }).length;
    addFinding(
      findings,
      finding(
        "non-positive-price",
        `${plural(nonPositivePrices, "price observation")} is not strictly positive.`,
        nonPositivePrices,
        input.entry.schema[priceIndex].name,
      ),
    );
  }

  if (tickerIndex !== undefined && dateIndex !== undefined) {
    const observations = new Set<string>();
    let duplicateCount = 0;
    const previousDateByTicker = new Map<string, string>();
    let outOfOrderCount = 0;
    const datesByTicker = new Map<string, string[]>();

    input.rows.forEach((row) => {
      const ticker = row[tickerIndex];
      const date = asDate(row[dateIndex]);
      if (typeof ticker !== "string" || date === undefined) return;

      const observationKey = `${ticker}:${date}`;
      if (observations.has(observationKey)) duplicateCount += 1;
      observations.add(observationKey);

      const previousDate = previousDateByTicker.get(ticker);
      if (previousDate && date < previousDate) outOfOrderCount += 1;
      previousDateByTicker.set(ticker, date);

      const dates = datesByTicker.get(ticker) ?? [];
      dates.push(date);
      datesByTicker.set(ticker, dates);
    });

    addFinding(
      findings,
      finding(
        "duplicate-observation",
        `${plural(duplicateCount, "duplicate ticker/date observation")} detected.`,
        duplicateCount,
      ),
    );
    addFinding(
      findings,
      finding(
        "out-of-order-date",
        `${plural(outOfOrderCount, "observation")} is out of date order for its ticker.`,
        outOfOrderCount,
        input.entry.schema[dateIndex].name,
      ),
    );

    if ((input.expectedFrequency ?? DEFAULT_EXPECTED_FREQUENCY) === "monthly") {
      let missingPeriodCount = 0;
      for (const dates of datesByTicker.values()) {
        const uniqueSortedDates = [...new Set(dates)].sort();
        for (let index = 1; index < uniqueSortedDates.length; index += 1) {
          const gap =
            monthIndex(uniqueSortedDates[index]) -
            monthIndex(uniqueSortedDates[index - 1]);
          if (gap > 1) missingPeriodCount += gap - 1;
        }
      }
      addFinding(
        findings,
        finding(
          "missing-period",
          `${plural(missingPeriodCount, "expected monthly period")} is missing; annualized metrics will treat the surrounding observations as consecutive.`,
          missingPeriodCount,
          input.entry.schema[dateIndex].name,
        ),
      );
    }
  }

  if (currencyIndex !== undefined) {
    const currencies = input.rows
      .map((row) => row[currencyIndex])
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      );
    const distinctCurrencies = [...new Set(currencies)];
    // Cell text is untrusted and unbounded. Name only values that are valid
    // ISO currency codes, cap how many are named, and report the rest by count
    // so the finding message stays bounded and free of raw cell content.
    const namedCodes = distinctCurrencies
      .filter((value) => currencyCodeSchema.safeParse(value).success)
      .sort()
      .slice(0, MAX_NAMED_CURRENCY_CODES);
    const unnamedCount = distinctCurrencies.length - namedCodes.length;
    const detail =
      namedCodes.length > 0
        ? ` Recognized codes: ${namedCodes.join(", ")}${unnamedCount > 0 ? ` and ${plural(unnamedCount, "other value")}` : ""}.`
        : "";
    addFinding(
      findings,
      distinctCurrencies.length > 1
        ? finding(
            "mixed-currency",
            `The dataset contains ${distinctCurrencies.length} distinct currency values.${detail}`,
            distinctCurrencies.length,
            input.entry.schema[currencyIndex].name,
          )
        : undefined,
    );
  }

  addFinding(
    findings,
    staleSource(input.entry, now, freshnessWindowMs)
      ? finding(
          "stale-source",
          "The dynamic source is older than the configured freshness window.",
          1,
        )
      : undefined,
  );

  const untrustedByField = new Map<
    string,
    { count: number; codes: Set<string> }
  >();
  const recordMatch = (field: string, code: string) => {
    const existing = untrustedByField.get(field) ?? {
      count: 0,
      codes: new Set(),
    };
    existing.count += 1;
    existing.codes.add(code);
    untrustedByField.set(field, existing);
  };
  input.columns.forEach((column) => {
    const code = guardrailMatchCode(column);
    if (code) recordMatch(column, code);
  });
  input.rows.forEach((row) => {
    row.forEach((value, index) => {
      if (typeof value !== "string") return;
      const code = guardrailMatchCode(value);
      if (code) recordMatch(input.columns[index], code);
    });
  });
  for (const [field, { count, codes }] of untrustedByField) {
    addFinding(
      findings,
      finding(
        "untrusted-content-present",
        `Text matching guardrail patterns (${[...codes].sort().join(", ")}) was found in ${field}; it remains inert dataset content.`,
        count,
        field,
      ),
    );
  }

  const { status, gateOutcome } = qualityStatus(findings);
  return qualityReportSchema.parse({
    reportVersion: FINANCE_QUALITY_REPORT_VERSION,
    dataset: input.entry.dataset,
    ...(input.runId ? { runId: input.runId } : {}),
    evaluatedRules: financeQualityRules,
    findings,
    status,
    gateOutcome,
    evaluatedAt,
  });
}

/** @deprecated Use assessFinanceQuality. Kept for module API compatibility. */
export const evaluateFinanceQuality = assessFinanceQuality;

import {
  financePriceRowSchema,
  metricDefinitionSchema,
  type FinancePriceRow,
  type MetricDefinition,
} from "../contracts/finance";

export const financeMetricPackVersion = "v1";

export const financeGoldenFixture = {
  fixtureId: "finance-regression",
  fixtureVersion: "v1",
  contentHash:
    "sha256:0013058c7e0a0dbeadb925db167b3c6c125c360049958c8372c5efc6324b99e5",
} as const;

export type FinanceMetricId =
  | "total-return"
  | "volatility"
  | "maximum-drawdown";

const fixtureExpectation = (
  ticker: string,
  expectedValue: number,
  tolerance = 1e-9,
) => ({
  fixtureId: financeGoldenFixture.fixtureId,
  fixtureVersion: financeGoldenFixture.fixtureVersion,
  contentHash: financeGoldenFixture.contentHash,
  dimensions: { ticker },
  expectedValue,
  tolerance,
});

const metricDefinitions: MetricDefinition[] = [
  metricDefinitionSchema.parse({
    metricId: "total-return",
    version: financeMetricPackVersion,
    name: "Total return",
    description:
      "The percentage change from the first to the last adjusted-close observation in the selected interval.",
    formula: "((last adjusted_close / first adjusted_close) - 1) * 100",
    inputFields: ["ticker", "date", "close"],
    dimensions: ["ticker"],
    filters: ["one ticker at a time", "observations ordered by date"],
    timeGrain: "monthly",
    unit: "percent",
    currency: "USD",
    nullBehavior: "reject",
    edgeCases: [
      "Requires at least two observations.",
      "The first and last prices must be positive.",
      "No annualization is applied.",
    ],
    minimumObservations: 2,
    annualization: "none",
    expectedFixtureResults: [
      fixtureExpectation("AAPL", 14),
      fixtureExpectation("MSFT", 9),
      fixtureExpectation("TSLA", 14),
    ],
  }),
  metricDefinitionSchema.parse({
    metricId: "volatility",
    version: financeMetricPackVersion,
    name: "Annualized volatility",
    description:
      "The sample standard deviation of consecutive monthly returns, annualized by the square root of twelve.",
    formula: "sample_stddev((P_t / P_(t-1)) - 1) * sqrt(12) * 100",
    inputFields: ["ticker", "date", "close"],
    dimensions: ["ticker"],
    filters: ["one ticker at a time", "observations ordered by date"],
    timeGrain: "monthly",
    unit: "percent",
    currency: "USD",
    nullBehavior: "reject",
    edgeCases: [
      "Requires at least three prices to produce two returns.",
      "Uses sample, not population, standard deviation.",
      "Missing or non-positive prices are rejected.",
    ],
    minimumObservations: 3,
    annualization: "sqrt-periods-per-year",
    expectedFixtureResults: [
      fixtureExpectation("AAPL", 6.474841156627494),
      fixtureExpectation("MSFT", 2.628906584781655),
      fixtureExpectation("TSLA", 12.917032142906423),
    ],
  }),
  metricDefinitionSchema.parse({
    metricId: "maximum-drawdown",
    version: financeMetricPackVersion,
    name: "Maximum drawdown",
    description:
      "The largest percentage decline from a running observed peak to a later observed price.",
    formula: "min_t(((P_t / max_{s<=t}(P_s)) - 1) * 100)",
    inputFields: ["ticker", "date", "close"],
    dimensions: ["ticker"],
    filters: ["one ticker at a time", "observations ordered by date"],
    timeGrain: "monthly",
    unit: "percent",
    currency: "USD",
    nullBehavior: "reject",
    edgeCases: [
      "Requires at least two observations.",
      "A new high resets the running peak.",
      "The result is zero when every observation is non-decreasing.",
    ],
    minimumObservations: 2,
    annualization: "none",
    expectedFixtureResults: [
      fixtureExpectation("AAPL", -0.9803921568627416),
      fixtureExpectation("MSFT", -0.4901960784313708),
      fixtureExpectation("TSLA", -5.555555555555558),
    ],
  }),
];

export const financeMetricDefinitions = Object.freeze(metricDefinitions);

const metricDefinitionById = new Map(
  financeMetricDefinitions.map((definition) => [
    definition.metricId,
    definition,
  ]),
);

export function getFinanceMetricDefinition(metricId: string): MetricDefinition {
  const definition = metricDefinitionById.get(metricId);
  if (!definition) {
    throw new Error(`Unsupported finance metric: ${metricId}.`);
  }
  return definition;
}

export class MetricCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricCalculationError";
  }
}

function normalizeSeries(rows: readonly FinancePriceRow[]): FinancePriceRow[] {
  if (rows.length === 0) {
    throw new MetricCalculationError(
      "At least one price observation is required.",
    );
  }

  const parsedRows = rows.map((row) => financePriceRowSchema.parse(row));
  const tickers = new Set(parsedRows.map((row) => row.ticker));
  if (tickers.size !== 1) {
    throw new MetricCalculationError(
      "A finance metric must be calculated for one ticker at a time.",
    );
  }

  const sortedRows = [...parsedRows].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  for (let index = 1; index < sortedRows.length; index += 1) {
    if (sortedRows[index].date === sortedRows[index - 1].date) {
      throw new MetricCalculationError(
        "Duplicate dates are not valid metric observations.",
      );
    }
  }
  return sortedRows;
}

export function calculateTotalReturn(rows: readonly FinancePriceRow[]): number {
  const series = normalizeSeries(rows);
  if (series.length < 2) {
    throw new MetricCalculationError(
      "Total return requires at least two observations.",
    );
  }

  const first = series[0].close;
  const last = series[series.length - 1].close;
  return (last / first - 1) * 100;
}

function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) {
    throw new MetricCalculationError(
      "Volatility requires at least two return observations.",
    );
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const squaredDeviation = values.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  );
  return Math.sqrt(squaredDeviation / (values.length - 1));
}

export function calculateAnnualizedVolatility(
  rows: readonly FinancePriceRow[],
): number {
  const series = normalizeSeries(rows);
  if (series.length < 3) {
    throw new MetricCalculationError(
      "Annualized volatility requires at least three price observations.",
    );
  }

  const returns = series.slice(1).map((row, index) => {
    const previous = series[index].close;
    return row.close / previous - 1;
  });
  return sampleStandardDeviation(returns) * Math.sqrt(12) * 100;
}

export function calculateMaximumDrawdown(
  rows: readonly FinancePriceRow[],
): number {
  const series = normalizeSeries(rows);
  if (series.length < 2) {
    throw new MetricCalculationError(
      "Maximum drawdown requires at least two observations.",
    );
  }

  let runningPeak = series[0].close;
  let maximumDrawdown = 0;
  for (const row of series) {
    runningPeak = Math.max(runningPeak, row.close);
    maximumDrawdown = Math.min(
      maximumDrawdown,
      (row.close / runningPeak - 1) * 100,
    );
  }
  return maximumDrawdown;
}

export function calculateFinanceMetric(
  metricId: FinanceMetricId,
  rows: readonly FinancePriceRow[],
): number {
  switch (metricId) {
    case "total-return":
      return calculateTotalReturn(rows);
    case "volatility":
      return calculateAnnualizedVolatility(rows);
    case "maximum-drawdown":
      return calculateMaximumDrawdown(rows);
  }
}

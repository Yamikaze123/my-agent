import { createHash, randomUUID } from "node:crypto";
import rawFixture from "../../../evaluation/fixtures/finance/finance-regression-v1.json";
import rawManifest from "../../../evaluation/fixtures/finance/manifest.json";
import {
  financeFixtureManifestSchema,
  financeFixtureRequestSchema,
  financeFixtureResultSchema,
  financeFixtureSchema,
  type FinanceFixtureRequest,
  type FinanceFixtureResult,
  type FinancePriceRow,
} from "../contracts/finance";

export const financeFixture = financeFixtureSchema.parse(rawFixture);
export const financeFixtureManifest =
  financeFixtureManifestSchema.parse(rawManifest);

export function canonicalizeFinanceRows(
  rows: readonly FinancePriceRow[],
): string {
  return rows.map((row) => `${row.ticker}|${row.date}|${row.close}`).join("\n");
}

export function hashFinanceRows(rows: readonly FinancePriceRow[]): string {
  return `sha256:${createHash("sha256")
    .update(canonicalizeFinanceRows(rows), "utf8")
    .digest("hex")}`;
}

const computedHash = hashFinanceRows(financeFixture.rows);

if (computedHash !== financeFixtureManifest.contentHash) {
  throw new Error(
    `Finance fixture checksum mismatch: expected ${financeFixtureManifest.contentHash}, computed ${computedHash}.`,
  );
}

if (
  financeFixtureManifest.fixtureId !== financeFixture.fixtureId ||
  financeFixtureManifest.version !== financeFixture.version ||
  financeFixtureManifest.rowCount !== financeFixture.rows.length
) {
  throw new Error("Finance fixture manifest does not match the fixture data.");
}

const availableTickers = new Set(financeFixture.rows.map((row) => row.ticker));

const fixtureStartDate = financeFixture.rows.reduce(
  (earliest, row) => (row.date < earliest ? row.date : earliest),
  financeFixture.rows[0].date,
);
const fixtureEndDate = financeFixture.rows.reduce(
  (latest, row) => (row.date > latest ? row.date : latest),
  financeFixture.rows[0].date,
);

export const financeFixtureAvailability = {
  fixtureId: financeFixtureManifest.fixtureId,
  version: financeFixtureManifest.version,
  tickers: financeFixtureManifest.tickers,
  startDate: fixtureStartDate,
  endDate: fixtureEndDate,
} as const;

function fixtureAvailabilityHint(): string {
  return (
    `Available tickers: ${financeFixtureAvailability.tickers.join(", ")}. ` +
    `Available date range: ${financeFixtureAvailability.startDate} through ${financeFixtureAvailability.endDate}. ` +
    "For the complete fixture, omit tickers, startDate, and endDate."
  );
}

for (const ticker of financeFixtureManifest.tickers) {
  if (!availableTickers.has(ticker)) {
    throw new Error(
      `Finance fixture manifest names unavailable ticker ${ticker}.`,
    );
  }
}

function compareRows(left: FinancePriceRow, right: FinancePriceRow): number {
  return (
    left.date.localeCompare(right.date) ||
    left.ticker.localeCompare(right.ticker)
  );
}

export function getFinanceFixture(
  input: FinanceFixtureRequest = {},
): FinanceFixtureResult {
  const query = financeFixtureRequestSchema.parse(input);
  const tickers = query.tickers ?? financeFixtureManifest.tickers;

  for (const ticker of tickers) {
    if (!availableTickers.has(ticker)) {
      throw new Error(
        `Ticker ${ticker} is not available in fixture ${financeFixtureManifest.fixtureId}@${financeFixtureManifest.version}. ${fixtureAvailabilityHint()}`,
      );
    }
  }

  const rows = financeFixture.rows
    .filter((row) => {
      if (!tickers.includes(row.ticker)) return false;
      if (query.startDate && row.date < query.startDate) return false;
      if (query.endDate && row.date > query.endDate) return false;
      return true;
    })
    .sort(compareRows);

  if (rows.length === 0) {
    throw new Error(
      `The requested fixture date range contains no rows. ${fixtureAvailabilityHint()}`,
    );
  }

  const dataset = {
    datasetId: financeFixture.fixtureId,
    version: financeFixture.version,
    contentHash: computedHash,
  };
  const source = {
    type: "fixture" as const,
    connector: "finance-fixture",
    provider: "capstone-synthetic",
    locator: "evaluation/fixtures/finance/finance-regression-v1.json",
    fixtureId: financeFixture.fixtureId,
    fixtureVersion: financeFixture.version,
    contentHash: computedHash,
  };
  const provenance = {
    runId: query.runId ?? randomUUID(),
    observedAt: query.observedAt ?? new Date().toISOString(),
    dataset,
    source,
  };

  return financeFixtureResultSchema.parse({
    dataset,
    source,
    provenance,
    rows,
  });
}

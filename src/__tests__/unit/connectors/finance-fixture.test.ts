import { describe, expect, it } from "vitest";
import {
  canonicalizeFinanceRows,
  financeFixture,
  financeFixtureManifest,
  getFinanceFixture,
  hashFinanceRows,
} from "@/mastra/connectors/finance-fixture";

const fixedRunId = "00000000-0000-4000-8000-000000000001";
const fixedObservedAt = "2026-09-13T13:00:00.000Z";

describe("finance fixture connector", () => {
  it("loads the declared synthetic fixture and verifies its manifest", () => {
    expect(financeFixture.fixtureId).toBe("finance-regression");
    expect(financeFixture.version).toBe("v1");
    expect(financeFixture.rows).toHaveLength(39);
    expect(financeFixtureManifest.rowCount).toBe(39);
    expect(hashFinanceRows(financeFixture.rows)).toBe(
      financeFixtureManifest.contentHash,
    );
  });

  it("uses a stable canonical representation for hashing", () => {
    expect(canonicalizeFinanceRows(financeFixture.rows.slice(0, 2))).toBe(
      "AAPL|2024-12-31|100\nAAPL|2025-01-31|102",
    );
  });

  it("returns a filtered result with dataset and source provenance", () => {
    const result = getFinanceFixture({
      tickers: ["AAPL"],
      startDate: "2025-01-01",
      endDate: "2025-03-31",
      runId: fixedRunId,
      observedAt: fixedObservedAt,
    });

    expect(result.rows).toEqual([
      { ticker: "AAPL", date: "2025-01-31", close: 102 },
      { ticker: "AAPL", date: "2025-02-28", close: 101 },
      { ticker: "AAPL", date: "2025-03-31", close: 104 },
    ]);
    expect(result.dataset).toEqual({
      datasetId: "finance-regression",
      version: "v1",
      contentHash: financeFixtureManifest.contentHash,
    });
    expect(result.provenance).toMatchObject({
      runId: fixedRunId,
      observedAt: fixedObservedAt,
      dataset: result.dataset,
      source: {
        type: "fixture",
        connector: "finance-fixture",
        provider: "capstone-synthetic",
        fixtureId: "finance-regression",
        fixtureVersion: "v1",
        contentHash: financeFixtureManifest.contentHash,
      },
    });
  });

  it("rejects an unavailable ticker", () => {
    expect(() => getFinanceFixture({ tickers: ["NOPE"] })).toThrow(
      "is not available in fixture finance-regression@v1",
    );
  });

  it("rejects an invalid date range", () => {
    expect(() =>
      getFinanceFixture({
        startDate: "2025-03-31",
        endDate: "2025-01-31",
      }),
    ).toThrow("endDate must not precede startDate");
  });

  it("rejects a date range with no matching rows", () => {
    expect(() =>
      getFinanceFixture({
        tickers: ["AAPL"],
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      }),
    ).toThrow("requested fixture date range contains no rows");
  });
});

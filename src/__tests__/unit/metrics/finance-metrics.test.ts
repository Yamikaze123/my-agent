import { describe, expect, it } from "vitest";
import {
  calculateAnnualizedVolatility,
  calculateFinanceMetric,
  calculateMaximumDrawdown,
  calculateTotalReturn,
  financeGoldenFixture,
  financeMetricDefinitions,
  getFinanceMetricDefinition,
  type FinanceMetricId,
} from "@/mastra/metrics/finance-metrics";
import {
  financeFixture,
  financeFixtureManifest,
} from "@/mastra/connectors/finance-fixture";

function rowsForTicker(ticker: string) {
  return financeFixture.rows.filter((row) => row.ticker === ticker);
}

describe("finance metric pack", () => {
  it("freezes the three required metric definitions", () => {
    expect(financeGoldenFixture).toEqual({
      fixtureId: financeFixture.fixtureId,
      fixtureVersion: financeFixture.version,
      contentHash: financeFixtureManifest.contentHash,
    });
    expect(
      financeMetricDefinitions.map((definition) => definition.metricId),
    ).toEqual(["total-return", "volatility", "maximum-drawdown"]);

    for (const definition of financeMetricDefinitions) {
      expect(definition.version).toBe("v1");
      expect(definition.inputFields).toEqual(["ticker", "date", "close"]);
      expect(definition.dimensions).toEqual(["ticker"]);
      expect(definition.unit).toBe("percent");
      expect(definition.currency).toBe("USD");
      expect(definition.expectedFixtureResults).toHaveLength(3);
    }
  });

  it("matches the golden fixture expectations without model execution", () => {
    for (const definition of financeMetricDefinitions) {
      for (const expected of definition.expectedFixtureResults) {
        const ticker = expected.dimensions.ticker;
        expect(typeof ticker).toBe("string");
        const actual = calculateFinanceMetric(
          definition.metricId as FinanceMetricId,
          rowsForTicker(ticker as string),
        );
        expect(actual).toBeCloseTo(expected.expectedValue, 9);
      }
    }
  });

  it("implements the documented formulas directly", () => {
    const aaplRows = rowsForTicker("AAPL");
    expect(calculateTotalReturn(aaplRows)).toBeCloseTo(14, 10);
    expect(calculateAnnualizedVolatility(aaplRows)).toBeCloseTo(
      6.474841156627494,
      10,
    );
    expect(calculateMaximumDrawdown(aaplRows)).toBeCloseTo(
      -0.9803921568627416,
      10,
    );
  });

  it("normalizes row order without mutating the source rows", () => {
    const rows = rowsForTicker("MSFT");
    const originalRows = [...rows];
    const reversed = [...rows].reverse();
    expect(calculateTotalReturn(reversed)).toBeCloseTo(9, 10);
    expect(rows).toEqual(originalRows);
  });

  it("normalizes timezone-bearing ISO dates before calculating metrics", () => {
    const rows = rowsForTicker("MSFT").map((row) => ({
      ...row,
      date: `${row.date}T00:00:00-05:00`,
    }));

    expect(calculateTotalReturn(rows)).toBeCloseTo(9, 10);
    expect(calculateAnnualizedVolatility(rows)).toBeCloseTo(
      2.628906584781655,
      10,
    );
    expect(calculateMaximumDrawdown(rows)).toBeCloseTo(-0.4901960784313708, 10);

    // The UTC calendar date, rather than the local date prefix, determines
    // ordering when offsets place the observations on different UTC dates.
    expect(
      calculateTotalReturn([
        {
          ticker: "MSFT",
          date: "2025-01-01T23:00:00-05:00",
          close: 100,
        },
        {
          ticker: "MSFT",
          date: "2025-01-02T00:30:00+01:00",
          close: 110,
        },
      ]),
    ).toBeCloseTo((100 / 110 - 1) * 100, 10);
  });

  it("rejects ambiguous or insufficient observations", () => {
    const aaplRows = rowsForTicker("AAPL");
    expect(() => calculateTotalReturn(aaplRows.slice(0, 1))).toThrow(
      "at least two observations",
    );
    expect(() => calculateAnnualizedVolatility(aaplRows.slice(0, 2))).toThrow(
      "at least three price observations",
    );
    expect(() =>
      calculateTotalReturn([...aaplRows, ...rowsForTicker("MSFT")]),
    ).toThrow("one ticker at a time");
  });

  it("looks up only supported finance metrics", () => {
    expect(getFinanceMetricDefinition("volatility").name).toBe(
      "Annualized volatility",
    );
    expect(() => getFinanceMetricDefinition("sharpe-ratio")).toThrow(
      "Unsupported finance metric",
    );
  });
});

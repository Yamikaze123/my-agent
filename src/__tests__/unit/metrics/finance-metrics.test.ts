import { describe, expect, it } from "vitest";
import {
  calculateAnnualizedVolatility,
  calculateFinanceMetric,
  calculateMaximumDrawdown,
  calculateTotalReturn,
  financeDrawdownFixture,
  financeGoldenFixture,
  financeMetricDefinitions,
  getFinanceMetricDefinition,
  inferSeriesFrequency,
  type FinanceMetricId,
} from "@/mastra/metrics/finance-metrics";
import {
  financeFixture,
  financeFixtureManifest,
  financeFixtureV2,
  financeFixtureV2Manifest,
} from "@/mastra/connectors/finance-fixture";

function rowsForTicker(ticker: string, version = "v1") {
  const fixture = version === "v2" ? financeFixtureV2 : financeFixture;
  return fixture.rows.filter((row) => row.ticker === ticker);
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
      expect(definition.expectedFixtureResults).toHaveLength(6);
    }
  });

  it("matches the golden fixture expectations without model execution", () => {
    for (const definition of financeMetricDefinitions) {
      for (const expected of definition.expectedFixtureResults) {
        const ticker = expected.dimensions.ticker;
        expect(typeof ticker).toBe("string");
        const actual = calculateFinanceMetric(
          definition.metricId as FinanceMetricId,
          rowsForTicker(ticker as string, expected.fixtureVersion),
        );
        expect(actual).toBeCloseTo(expected.expectedValue, 9);
      }
    }
  });

  it("freezes the irregular drawdown fixture expectations", () => {
    expect(financeDrawdownFixture).toEqual({
      fixtureId: financeFixtureV2.fixtureId,
      fixtureVersion: financeFixtureV2.version,
      contentHash: financeFixtureV2Manifest.contentHash,
    });
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

  describe("volatility annualization by observation frequency", () => {
    // Alternating +1% / -1% returns: the per-period sample standard deviation
    // is close to 1%, so the annualized value is close to sqrt(periods) %.
    function alternatingSeries(dates: string[]) {
      let close = 100;
      return dates.map((date, index) => {
        if (index > 0) close *= index % 2 === 1 ? 1.01 : 0.99;
        return { ticker: "AAA", date, close };
      });
    }

    function weekdays(count: number) {
      const dates: string[] = [];
      const cursor = new Date("2025-01-02T00:00:00Z");
      while (dates.length < count) {
        const day = cursor.getUTCDay();
        if (day !== 0 && day !== 6) {
          dates.push(cursor.toISOString().slice(0, 10));
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      return dates;
    }

    function stepped(count: number, stepDays: number) {
      return Array.from({ length: count }, (_, index) =>
        new Date(Date.UTC(2025, 0, 3) + index * stepDays * 86_400_000)
          .toISOString()
          .slice(0, 10),
      );
    }

    it("annualizes daily observations with sqrt(252), not sqrt(12)", () => {
      const value = calculateAnnualizedVolatility(
        alternatingSeries(weekdays(121)),
      );
      expect(value).toBeGreaterThan(15.5);
      expect(value).toBeLessThan(16.5);
    });

    it("annualizes weekly observations with sqrt(52)", () => {
      const value = calculateAnnualizedVolatility(
        alternatingSeries(stepped(53, 7)),
      );
      expect(value).toBeGreaterThan(7);
      expect(value).toBeLessThan(7.5);
    });

    it("keeps sqrt(12) for monthly observations, including gapped ones", () => {
      expect(inferSeriesFrequency(rowsForTicker("AAPL"))).toMatchObject({
        frequency: "monthly",
        periodsPerYear: 12,
      });
      expect(inferSeriesFrequency(rowsForTicker("AAPL", "v2"))).toMatchObject({
        frequency: "monthly",
        periodsPerYear: 12,
      });
    });

    it("rejects a spacing that has no annualization factor", () => {
      expect(() =>
        calculateAnnualizedVolatility(alternatingSeries(stepped(12, 14))),
      ).toThrow(/daily, weekly, monthly, quarterly, or annual/);
    });
  });
});

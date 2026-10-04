import { beforeEach, describe, expect, it } from "vitest";
import {
  registerFinanceCsv,
  registerFinanceFixture,
  getDatasetContent,
  getDataset,
} from "@/mastra/datasets/catalog";
import { profileFinanceDataset } from "@/mastra/profiling/finance-profile";
import { resolvePermissionContext } from "@/mastra/security/permission-context";

function permissionContext() {
  return resolvePermissionContext(new Request("http://localhost/api/datasets"))
    .permissionContext;
}

function csv(text: string) {
  return new TextEncoder().encode(text);
}

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

describe("deterministic finance profiling", () => {
  it("profiles the canonical fixture with bounded date, null, uniqueness, and numeric statistics", () => {
    const context = permissionContext();
    const entry = registerFinanceFixture(context);
    const content = getDatasetContent(entry.dataset.datasetId, context);
    const profile = profileFinanceDataset({
      entry: getDataset(entry.dataset.datasetId, context),
      ...content,
      profiledAt: "2026-10-04T12:00:00.000Z",
    });

    expect(profile).toMatchObject({
      dataset: entry.dataset,
      profileVersion: "v1",
      rowCount: 39,
      columnCount: 3,
      dateBounds: { startDate: "2024-12-31", endDate: "2025-12-31" },
      nullCounts: { ticker: 0, date: 0, close: 0 },
      uniqueCounts: { ticker: 3, date: 13, close: 38 },
    });
    expect(profile.numericSummary.close).toMatchObject({
      count: 39,
      min: 100,
      max: 290,
    });
  });

  it("profiles null values and numeric summaries from a CSV catalog entry", () => {
    const context = permissionContext();
    const entry = registerFinanceCsv(
      context,
      csv(
        "ticker,date,close,note\nAAPL,2025-01-31,100,ok\nAAPL,2025-02-28,,missing\n",
      ),
    );
    const content = getDatasetContent(entry.dataset.datasetId, context);

    const profile = profileFinanceDataset({ entry, ...content });

    expect(profile.nullCounts.close).toBe(1);
    expect(profile.uniqueCounts.ticker).toBe(1);
    expect(profile.numericSummary.close).toMatchObject({
      count: 1,
      min: 100,
      max: 100,
      mean: 100,
      standardDeviation: 0,
    });
  });

  it("profiles only unambiguous dates so bounds are identical on every machine", () => {
    const context = permissionContext();
    const zoned = registerFinanceCsv(
      context,
      csv(
        "ticker,date,close\nAAPL,2025-01-31T23:30:00-05:00,100\nAAPL,2025-02-28T00:00:00Z,101\n",
      ),
    );
    const zonedProfile = profileFinanceDataset({
      entry: getDataset(zoned.dataset.datasetId, context),
      ...getDatasetContent(zoned.dataset.datasetId, context),
    });
    // The -05:00 timestamp is 04:30 UTC on the following day.
    expect(zonedProfile.dateBounds).toEqual({
      startDate: "2025-02-01",
      endDate: "2025-02-28",
    });

    const locale = registerFinanceCsv(
      context,
      csv("ticker,date,close\nAAPL,01/31/2025,100\nAAPL,02/28/2025,101\n"),
    );
    const localeProfile = profileFinanceDataset({
      entry: getDataset(locale.dataset.datasetId, context),
      ...getDatasetContent(locale.dataset.datasetId, context),
    });
    expect(localeProfile.dateBounds).toBeUndefined();
  });

  it("fails closed when catalog rows do not match the registered schema", () => {
    const context = permissionContext();
    const entry = registerFinanceCsv(
      context,
      csv("ticker,date,close\nAAPL,2025-01-31,100\n"),
    );

    expect(() =>
      profileFinanceDataset({
        entry,
        columns: ["ticker", "date", "close"],
        rows: [["AAPL", "2025-01-31"]],
      }),
    ).toThrow("registered column count");
  });
});

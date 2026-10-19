import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { datasetDisplayLabel } from "@/components/finance/dataset-display-label";
import {
  registerFinanceCsv,
  registerFinanceFixture,
} from "@/mastra/datasets/catalog";
import { resolvePermissionContext } from "@/mastra/security/permission-context";

function permissionContext() {
  return resolvePermissionContext(new Request("http://localhost/api/datasets"))
    .permissionContext;
}

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("datasetDisplayLabel", () => {
  it("shows a readable fixture name and a single version prefix", () => {
    const entry = registerFinanceFixture(permissionContext());

    expect(datasetDisplayLabel(entry)).toBe(
      `Finance fixture · ${entry.rowCount.toLocaleString()} rows · v1`,
    );
  });

  it("uses upload metadata and a short ID without displaying a filename", () => {
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue(
      "Oct 18, 9:01 PM",
    );
    const entry = registerFinanceCsv(
      permissionContext(),
      new TextEncoder().encode("ticker,date,close\nAAPL,2025-01-31,102\n"),
    );
    const shortId = entry.dataset.datasetId
      .replace(/-/g, "")
      .slice(0, 6)
      .toUpperCase();

    expect(datasetDisplayLabel(entry)).toBe(
      `CSV upload · 1 row · Oct 18, 9:01 PM · ${shortId}`,
    );
    expect(datasetDisplayLabel(entry)).not.toMatch(/\.csv/i);
  });
});

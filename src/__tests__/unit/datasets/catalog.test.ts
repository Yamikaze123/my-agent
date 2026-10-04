import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceCsvError } from "@/mastra/connectors/finance-csv";
import {
  acquireCsvUploadSlot,
  MAX_CONCURRENT_CSV_UPLOADS,
  DATASET_RETENTION_HOURS,
  DatasetCatalogError,
  deleteDataset,
  getDataset,
  getDatasetContent,
  listDatasets,
  readOwnedDataset,
  MAX_TOTAL_RETAINED_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES_PER_RESOURCE,
  registerFinanceCsv,
  registerFinanceFixture,
} from "@/mastra/datasets/catalog";
import {
  AuthorizationError,
  resolvePermissionContext,
} from "@/mastra/security/permission-context";

function permissionContext() {
  return resolvePermissionContext(new Request("http://localhost/api/datasets"))
    .permissionContext;
}

function csv(text = "ticker,date,Adj Close\nAAPL,2025-01-31,102\n") {
  return new TextEncoder().encode(text);
}

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("owner-scoped finance dataset catalog", () => {
  it("registers the canonical fixture with a generated ID, schema, and source provenance", () => {
    const context = permissionContext();
    const entry = registerFinanceFixture(context);
    const duplicate = registerFinanceFixture(context);

    expect(entry.dataset.datasetId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(entry.dataset.datasetId).not.toBe("finance-regression");
    expect(entry.dataset.resourceId).toBe(context.resource.id);
    expect(entry.source).toMatchObject({
      type: "fixture",
      connector: "finance-fixture",
      fixtureId: "finance-regression",
      fixtureVersion: "v1",
      freshness: "static",
    });
    expect(entry.schema).toMatchObject([
      { name: "ticker", semanticRole: "ticker" },
      { name: "date", logicalType: "date", semanticRole: "date" },
      { name: "close", semanticRole: "price", currency: "USD" },
    ]);
    expect(duplicate.dataset.datasetId).toBe(entry.dataset.datasetId);
    expect(entry.expiresAt).toBe(
      new Date(
        Date.parse(entry.createdAt) + DATASET_RETENTION_HOURS * 60 * 60 * 1_000,
      ).toISOString(),
    );
  });

  it("registers CSV content through the same catalog contract and retrieves parsed rows", () => {
    const context = permissionContext();
    const entry = registerFinanceCsv(
      context,
      csv(
        'ticker,date,Adj Close,note\nAAPL,2025-01-31,102,"split, adjusted"\n',
      ),
    );
    const content = getDatasetContent(entry.dataset.datasetId, context);

    expect(entry.dataset.resourceId).toBe(context.resource.id);
    expect(entry.dataset.datasetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.source).toMatchObject({
      type: "upload",
      connector: "finance-csv",
      provider: "user-upload",
      freshness: "unknown",
    });
    expect(entry.dataset.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.rowCount).toBe(1);
    expect(entry.schema).toMatchObject([
      { name: "ticker", semanticRole: "ticker" },
      { name: "date", logicalType: "date", semanticRole: "date" },
      { name: "Adj_Close", logicalType: "integer", semanticRole: "price" },
      { name: "note", semanticRole: "dimension" },
    ]);
    expect(content).toEqual({
      dataset: entry.dataset,
      columns: ["ticker", "date", "Adj_Close", "note"],
      rows: [["AAPL", "2025-01-31", 102, "split, adjusted"]],
    });
  });

  it("lists only the current resource's datasets and blocks cross-resource reads and deletes", () => {
    const owner = permissionContext();
    const other = permissionContext();
    const entry = registerFinanceFixture(owner);

    expect(listDatasets(owner)).toHaveLength(1);
    expect(listDatasets(other)).toEqual([]);
    expect(() => getDataset(entry.dataset.datasetId, other)).toThrow(
      AuthorizationError,
    );
    expect(() => getDatasetContent(entry.dataset.datasetId, other)).toThrow(
      AuthorizationError,
    );
    expect(() => deleteDataset(entry.dataset.datasetId, other)).toThrow(
      AuthorizationError,
    );
    expect(getDataset(entry.dataset.datasetId, owner).dataset).toEqual(
      entry.dataset,
    );
  });

  it("deletes owned data and rejects subsequent retrieval", () => {
    const context = permissionContext();
    const entry = registerFinanceCsv(context, csv());

    deleteDataset(entry.dataset.datasetId, context);

    expect(listDatasets(context)).toEqual([]);
    expect(() => getDataset(entry.dataset.datasetId, context)).toThrow(
      AuthorizationError,
    );
  });

  it("expires datasets after the configured retention period", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z"));
    const context = permissionContext();
    const entry = registerFinanceFixture(context);

    vi.advanceTimersByTime((DATASET_RETENTION_HOURS + 1) * 60 * 60 * 1_000);

    expect(() => getDataset(entry.dataset.datasetId, context)).toThrow(
      AuthorizationError,
    );
    expect(listDatasets(context)).toEqual([]);
  });

  it("enforces the per-resource dataset quota", () => {
    const context = permissionContext();
    registerFinanceFixture(context);
    for (let index = 0; index < 4; index += 1) {
      registerFinanceCsv(context, csv());
    }

    expect(listDatasets(context)).toHaveLength(5);
    try {
      registerFinanceCsv(context, csv());
      throw new Error("Expected the catalog quota to reject another dataset.");
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetCatalogError);
      expect(error).toMatchObject({ code: "quota_exceeded", status: 429 });
    }
  });

  it("enforces the per-resource retained-upload byte budget", () => {
    const context = permissionContext();
    const entry = registerFinanceCsv(context, csv());
    const stored = globalThis.financeDatasetCatalogState?.datasets.get(
      entry.dataset.datasetId,
    );
    if (!stored || !globalThis.financeDatasetCatalogState) {
      throw new Error("Expected the registered dataset in the catalog.");
    }
    stored.retainedBytes = MAX_UPLOAD_BYTES_PER_RESOURCE;
    globalThis.financeDatasetCatalogState.retainedUploadBytes =
      MAX_UPLOAD_BYTES_PER_RESOURCE;

    expect(() => registerFinanceCsv(context, csv())).toThrow(
      DatasetCatalogError,
    );
  });

  it("enforces the process-wide retained-upload byte budget", () => {
    const context = permissionContext();
    registerFinanceCsv(context, csv());
    if (!globalThis.financeDatasetCatalogState) {
      throw new Error("Expected the dataset catalog to be initialized.");
    }
    globalThis.financeDatasetCatalogState.retainedUploadBytes =
      MAX_TOTAL_RETAINED_UPLOAD_BYTES - 1;

    try {
      registerFinanceCsv(context, csv());
      throw new Error(
        "Expected the process storage quota to reject the upload.",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetCatalogError);
      expect(error).toMatchObject({ code: "storage_limit", status: 413 });
    }
  });

  it("limits concurrent uploads per resource and releases the slot", () => {
    const context = permissionContext();
    const release = acquireCsvUploadSlot(context);

    expect(() => acquireCsvUploadSlot(context)).toThrow(DatasetCatalogError);
    release();
    expect(() => acquireCsvUploadSlot(context)).not.toThrow();
  });

  it("limits concurrent uploads across the application process", () => {
    const releases = Array.from({ length: MAX_CONCURRENT_CSV_UPLOADS }, () =>
      acquireCsvUploadSlot(permissionContext()),
    );

    try {
      let caught: unknown;
      try {
        acquireCsvUploadSlot(permissionContext());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DatasetCatalogError);
      expect(caught).toMatchObject({ code: "upload_concurrency_limit" });
    } finally {
      releases.forEach((release) => release());
    }
  });

  it("propagates typed CSV validation errors without cataloging the upload", () => {
    const context = permissionContext();

    expect(() =>
      registerFinanceCsv(context, csv("date,close\n2025-01-31\n")),
    ).toThrow(FinanceCsvError);
    expect(listDatasets(context)).toEqual([]);
  });
});

describe("readOwnedDataset", () => {
  it("returns runtime-frozen columns and rows that callers cannot mutate", () => {
    const context = permissionContext();
    const entry = registerFinanceCsv(
      context,
      csv("ticker,date,close\nAAPL,2025-01-31,100\n"),
    );

    const view = readOwnedDataset(entry.dataset.datasetId, context);
    const rows = view.rows as unknown as unknown[][];
    const columns = view.columns as unknown as string[];

    expect(Object.isFrozen(view.rows)).toBe(true);
    expect(Object.isFrozen(view.rows[0])).toBe(true);
    expect(Object.isFrozen(view.columns)).toBe(true);
    expect(() => rows.push(["TSLA", "2025-02-28", 1])).toThrow(TypeError);
    expect(() => {
      rows[0][2] = 0;
    }).toThrow(TypeError);
    expect(() => columns.push("extra")).toThrow(TypeError);

    // The catalog copy handed to external callers is unaffected and still
    // reflects the original content.
    expect(getDatasetContent(entry.dataset.datasetId, context).rows).toEqual([
      ["AAPL", "2025-01-31", 100],
    ]);
  });

  it("denies the borrowed view to another resource", () => {
    const owner = permissionContext();
    const other = permissionContext();
    const entry = registerFinanceCsv(
      owner,
      csv("ticker,date,close\nAAPL,2025-01-31,100\n"),
    );

    expect(() => readOwnedDataset(entry.dataset.datasetId, other)).toThrow(
      AuthorizationError,
    );
  });
});

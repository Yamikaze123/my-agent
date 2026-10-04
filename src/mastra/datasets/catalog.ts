import { createHash, randomUUID } from "node:crypto";
import {
  createMastraRequestContext,
  requirePermission,
  type PermissionContext,
  AuthorizationError,
} from "../security/permission-context";
import {
  datasetCatalogEntrySchema,
  type DatasetCatalogEntry,
  type DatasetRef,
  type SchemaField,
} from "../contracts/finance";
import {
  financeFixture,
  financeFixtureManifest,
  hashFinanceRows,
} from "../connectors/finance-fixture";
import {
  MAX_CSV_FILE_BYTES,
  parseFinanceCsv,
  type CsvScalar,
} from "../connectors/finance-csv";

export const DATASET_RETENTION_HOURS = 24;
export const MAX_DATASETS_PER_RESOURCE = 5;
export const MAX_UPLOAD_BYTES_PER_RESOURCE = 5 * 1_048_576;
export const MAX_TOTAL_RETAINED_UPLOAD_BYTES = 32 * 1_048_576;
export const MAX_CATALOG_DATASETS = 1_000;
export const MAX_CONCURRENT_CSV_UPLOADS = 4;
export const MAX_CONCURRENT_CSV_UPLOADS_PER_RESOURCE = 1;

// Stored columns and rows are frozen at registration (see freezeTable) so
// every internal reader, including workflow steps that borrow the arrays
// without copying, sees runtime-immutable data.
type StoredDataset = {
  ownerResourceId: string;
  entry: DatasetCatalogEntry;
  columns: readonly string[];
  rows: readonly (readonly CsvScalar[])[];
  retainedBytes: number;
};

function freezeTable(
  columns: string[],
  rows: CsvScalar[][],
): Pick<StoredDataset, "columns" | "rows"> {
  for (const row of rows) Object.freeze(row);
  return { columns: Object.freeze(columns), rows: Object.freeze(rows) };
}

type DatasetCatalogState = {
  datasets: Map<string, StoredDataset>;
  activeUploads: number;
  activeUploadsByResource: Map<string, number>;
  retainedUploadBytes: number;
};

declare global {
  var financeDatasetCatalogState: DatasetCatalogState | undefined;
}

export class DatasetCatalogError extends Error {
  constructor(
    public readonly code:
      | "unsupported_media_type"
      | "invalid_registration"
      | "quota_exceeded"
      | "upload_concurrency_limit"
      | "storage_limit",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DatasetCatalogError";
  }
}

function getState(): DatasetCatalogState {
  globalThis.financeDatasetCatalogState ??= {
    datasets: new Map(),
    activeUploads: 0,
    activeUploadsByResource: new Map(),
    retainedUploadBytes: 0,
  };
  return globalThis.financeDatasetCatalogState;
}

function authorize(
  permissionContext: PermissionContext,
  action: "dataset:read" | "dataset:write",
): void {
  requirePermission(createMastraRequestContext(permissionContext), action);
}

function removeDataset(
  state: DatasetCatalogState,
  datasetId: string,
  dataset: StoredDataset,
): void {
  // The frozen table cannot be truncated in place; dropping the catalog's
  // reference releases it once no borrowed view remains in use.
  state.datasets.delete(datasetId);
  state.retainedUploadBytes -= dataset.retainedBytes;
}

function pruneExpired(state = getState(), now = Date.now()): void {
  for (const [datasetId, dataset] of state.datasets) {
    if (Date.parse(dataset.entry.expiresAt) <= now) {
      removeDataset(state, datasetId, dataset);
    }
  }
}

function copyEntry(entry: DatasetCatalogEntry): DatasetCatalogEntry {
  return datasetCatalogEntrySchema.parse(entry);
}

function assertCapacity(
  state: DatasetCatalogState,
  resourceId: string,
  uploadBytes: number,
): void {
  const resourceDatasets = [...state.datasets.values()].filter(
    (dataset) => dataset.ownerResourceId === resourceId,
  );
  if (resourceDatasets.length >= MAX_DATASETS_PER_RESOURCE) {
    throw new DatasetCatalogError(
      "quota_exceeded",
      `A resource may retain at most ${MAX_DATASETS_PER_RESOURCE} datasets.`,
      429,
    );
  }
  if (state.datasets.size >= MAX_CATALOG_DATASETS) {
    throw new DatasetCatalogError(
      "storage_limit",
      "The temporary dataset catalog is full.",
      503,
    );
  }

  const currentResourceBytes = resourceDatasets.reduce(
    (total, dataset) => total + dataset.retainedBytes,
    0,
  );
  if (
    currentResourceBytes + uploadBytes > MAX_UPLOAD_BYTES_PER_RESOURCE ||
    state.retainedUploadBytes + uploadBytes > MAX_TOTAL_RETAINED_UPLOAD_BYTES
  ) {
    throw new DatasetCatalogError(
      "storage_limit",
      "The temporary dataset storage limit has been reached. Delete an existing upload or try again after retained datasets expire.",
      413,
    );
  }
}

function makeEntry(args: {
  datasetId: string;
  version: string;
  contentHash: string;
  resourceId: string;
  connector: string;
  provider: string;
  observedAt: string;
  freshness: "static" | "unknown";
  fixtureId?: string;
  fixtureVersion?: string;
  schema: SchemaField[];
  rowCount: number;
}): DatasetCatalogEntry {
  const createdAt = args.observedAt;
  const expiresAt = new Date(
    Date.parse(createdAt) + DATASET_RETENTION_HOURS * 60 * 60 * 1_000,
  ).toISOString();
  return datasetCatalogEntrySchema.parse({
    dataset: {
      datasetId: args.datasetId,
      version: args.version,
      contentHash: args.contentHash,
      resourceId: args.resourceId,
    },
    source: {
      type: args.fixtureId ? "fixture" : "upload",
      connector: args.connector,
      provider: args.provider,
      ...(args.fixtureId
        ? {
            locator: "evaluation/fixtures/finance/finance-regression-v1.json",
            fixtureId: args.fixtureId,
            fixtureVersion: args.fixtureVersion,
          }
        : {}),
      contentHash: args.contentHash,
      observedAt: args.observedAt,
      freshness: args.freshness,
    },
    schema: args.schema,
    rowCount: args.rowCount,
    createdAt,
    expiresAt,
  });
}

const fixtureColumns = ["ticker", "date", "close"];
const fixtureSchema: SchemaField[] = [
  {
    name: "ticker",
    logicalType: "string",
    nullable: false,
    semanticRole: "ticker",
  },
  {
    name: "date",
    logicalType: "date",
    nullable: false,
    semanticRole: "date",
  },
  {
    name: "close",
    logicalType: "number",
    nullable: false,
    semanticRole: "price",
    currency: "USD",
  },
];

export function registerFinanceFixture(
  permissionContext: PermissionContext,
): DatasetCatalogEntry {
  authorize(permissionContext, "dataset:write");
  const state = getState();
  pruneExpired(state);

  const existing = [...state.datasets.values()].find(
    (dataset) =>
      dataset.ownerResourceId === permissionContext.resource.id &&
      dataset.entry.source.fixtureId === financeFixture.fixtureId &&
      dataset.entry.source.fixtureVersion === financeFixture.version &&
      dataset.entry.dataset.contentHash === financeFixtureManifest.contentHash,
  );
  if (existing) return copyEntry(existing.entry);

  assertCapacity(state, permissionContext.resource.id, 0);
  const observedAt = new Date().toISOString();
  const datasetId = randomUUID();
  const contentHash = hashFinanceRows(financeFixture.rows);
  const entry = makeEntry({
    datasetId,
    version: financeFixture.version,
    contentHash,
    resourceId: permissionContext.resource.id,
    connector: "finance-fixture",
    provider: "capstone-synthetic",
    observedAt,
    freshness: "static",
    fixtureId: financeFixture.fixtureId,
    fixtureVersion: financeFixture.version,
    schema: fixtureSchema,
    rowCount: financeFixture.rows.length,
  });
  const rows = financeFixture.rows.map(({ ticker, date, close }) => [
    ticker,
    date,
    close,
  ]);
  state.datasets.set(datasetId, {
    ownerResourceId: permissionContext.resource.id,
    entry,
    ...freezeTable([...fixtureColumns], rows),
    retainedBytes: 0,
  });
  return copyEntry(entry);
}

export function acquireCsvUploadSlot(
  permissionContext: PermissionContext,
): () => void {
  authorize(permissionContext, "dataset:write");
  const state = getState();
  pruneExpired(state);
  const resourceCount =
    state.activeUploadsByResource.get(permissionContext.resource.id) ?? 0;
  if (
    state.activeUploads >= MAX_CONCURRENT_CSV_UPLOADS ||
    resourceCount >= MAX_CONCURRENT_CSV_UPLOADS_PER_RESOURCE
  ) {
    throw new DatasetCatalogError(
      "upload_concurrency_limit",
      "CSV upload concurrency is limited. Finish the current upload before starting another.",
      429,
    );
  }

  state.activeUploads += 1;
  state.activeUploadsByResource.set(
    permissionContext.resource.id,
    resourceCount + 1,
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const currentState = getState();
    const currentCount =
      currentState.activeUploadsByResource.get(permissionContext.resource.id) ??
      0;
    currentState.activeUploads = Math.max(0, currentState.activeUploads - 1);
    if (currentCount <= 1) {
      currentState.activeUploadsByResource.delete(
        permissionContext.resource.id,
      );
    } else {
      currentState.activeUploadsByResource.set(
        permissionContext.resource.id,
        currentCount - 1,
      );
    }
  };
}

export function registerFinanceCsv(
  permissionContext: PermissionContext,
  bytes: Uint8Array,
): DatasetCatalogEntry {
  authorize(permissionContext, "dataset:write");
  if (bytes.byteLength > MAX_CSV_FILE_BYTES) {
    throw new DatasetCatalogError(
      "invalid_registration",
      `CSV files may not exceed ${MAX_CSV_FILE_BYTES} bytes.`,
      413,
    );
  }

  const state = getState();
  pruneExpired(state);
  assertCapacity(state, permissionContext.resource.id, bytes.byteLength);

  const parsed = parseFinanceCsv(bytes);
  const observedAt = new Date().toISOString();
  const datasetId = randomUUID();
  const contentHash = `sha256:${createHash("sha256")
    .update(bytes)
    .digest("hex")}`;
  const entry = makeEntry({
    datasetId,
    version: "csv-v1",
    contentHash,
    resourceId: permissionContext.resource.id,
    connector: "finance-csv",
    provider: "user-upload",
    observedAt,
    freshness: "unknown",
    schema: parsed.schema,
    rowCount: parsed.rows.length,
  });

  // Recheck after parsing in case another upload used the remaining quota.
  assertCapacity(state, permissionContext.resource.id, bytes.byteLength);
  state.datasets.set(datasetId, {
    ownerResourceId: permissionContext.resource.id,
    entry,
    ...freezeTable(parsed.columns, parsed.rows),
    retainedBytes: bytes.byteLength,
  });
  state.retainedUploadBytes += bytes.byteLength;
  return copyEntry(entry);
}

function getOwnedDataset(
  state: DatasetCatalogState,
  datasetId: string,
  permissionContext: PermissionContext,
): StoredDataset {
  const dataset = state.datasets.get(datasetId);
  if (!dataset) throw new AuthorizationError();
  if (dataset.ownerResourceId !== permissionContext.resource.id) {
    throw new AuthorizationError();
  }
  return dataset;
}

export function listDatasets(
  permissionContext: PermissionContext,
): DatasetCatalogEntry[] {
  authorize(permissionContext, "dataset:read");
  const state = getState();
  pruneExpired(state);
  return [...state.datasets.values()]
    .filter(
      (dataset) => dataset.ownerResourceId === permissionContext.resource.id,
    )
    .map((dataset) => copyEntry(dataset.entry))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function getDataset(
  datasetId: string,
  permissionContext: PermissionContext,
): DatasetCatalogEntry {
  authorize(permissionContext, "dataset:read");
  const state = getState();
  pruneExpired(state);
  return copyEntry(getOwnedDataset(state, datasetId, permissionContext).entry);
}

export function getDatasetContent(
  datasetId: string,
  permissionContext: PermissionContext,
): { dataset: DatasetRef; columns: string[]; rows: CsvScalar[][] } {
  authorize(permissionContext, "dataset:read");
  const state = getState();
  pruneExpired(state);
  const stored = getOwnedDataset(state, datasetId, permissionContext);
  return {
    dataset: copyEntry(stored.entry).dataset,
    columns: [...stored.columns],
    rows: stored.rows.map((row) => [...row]),
  };
}

export type OwnedDatasetView = {
  entry: DatasetCatalogEntry;
  columns: readonly string[];
  rows: readonly (readonly CsvScalar[])[];
};

/**
 * One authorized lookup that returns the catalog entry together with the
 * stored columns and rows. Unlike getDatasetContent it does not copy the
 * rows, so server-side workflow steps can read a dataset of up to the catalog
 * limits without duplicating it per step. The arrays are frozen at
 * registration, so the view is immutable at runtime, not only in the type
 * system; the entry is a validated copy.
 */
export function readOwnedDataset(
  datasetId: string,
  permissionContext: PermissionContext,
): OwnedDatasetView {
  authorize(permissionContext, "dataset:read");
  const state = getState();
  pruneExpired(state);
  const stored = getOwnedDataset(state, datasetId, permissionContext);
  return {
    entry: copyEntry(stored.entry),
    columns: stored.columns,
    rows: stored.rows,
  };
}

export function deleteDataset(
  datasetId: string,
  permissionContext: PermissionContext,
): void {
  authorize(permissionContext, "dataset:write");
  const state = getState();
  pruneExpired(state);
  const stored = getOwnedDataset(state, datasetId, permissionContext);
  removeDataset(state, datasetId, stored);
}

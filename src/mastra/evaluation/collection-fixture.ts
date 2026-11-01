import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import {
  schemaFieldSchema,
  type DatasetCatalogEntry,
  type SchemaField,
} from "../contracts/finance";
import { parseFinanceCsv, type CsvScalar } from "../connectors/finance-csv";
import {
  deleteDataset,
  registerFinanceCsv,
  registerFinanceFixture,
} from "../datasets/catalog";
import {
  fixtureManifestForVersion,
  financeFixtureForVersion,
  readOnlyFinanceFixtureAdapter,
} from "./fixture-adapter";
import { evaluationFixtureSchema, type EvaluationTask } from "./contracts";
import type { PermissionContext } from "../security/permission-context";

export const COLLECTION_TASK_CONTEXT_KEY = "evaluationCollectionTask";

const collectionTaskContextSchema = z
  .object({
    taskId: z.string().min(1).max(128),
    fixture: evaluationFixtureSchema,
    datasetId: z.uuid().optional(),
    rootDir: z.string().min(1).optional(),
  })
  .strict();

const csvScalarSchema = z.union([
  z.string().max(32_768),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const collectionFixtureResultSchema = z
  .object({
    taskId: z.string().min(1).max(128),
    fixtureId: z.string().min(1).max(128),
    version: z.string().min(1).max(64),
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    columns: z.array(z.string().min(1).max(128)).max(32),
    schema: z.array(schemaFieldSchema).max(32),
    rows: z.array(z.array(csvScalarSchema).max(32)).max(10_000),
  })
  .strict();

export type CollectionTaskContext = z.infer<typeof collectionTaskContextSchema>;

export type CollectionFixturePayload = {
  taskId: string;
  fixtureId: string;
  version: string;
  contentHash: string;
  columns: readonly string[];
  schema: readonly SchemaField[];
  rows: readonly (readonly CsvScalar[])[];
};

const JSON_FIXTURE_COLUMNS = ["ticker", "date", "close"] as const;
const JSON_FIXTURE_SCHEMA = [
  {
    name: "ticker",
    logicalType: "string" as const,
    nullable: false,
    semanticRole: "ticker" as const,
  },
  {
    name: "date",
    logicalType: "date" as const,
    nullable: false,
    semanticRole: "date" as const,
  },
  {
    name: "close",
    logicalType: "number" as const,
    nullable: false,
    semanticRole: "price" as const,
  },
] satisfies readonly SchemaField[];

function safeCsvPath(rootDir: string, file: string): string {
  const fixtureRoot = resolve(rootDir, "evaluation", "fixtures", "finance");
  const filePath = resolve(fixtureRoot, file);
  const relativePath = relative(fixtureRoot, filePath);
  if (
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error("Evaluation fixture path escapes the fixture directory.");
  }
  // Unit callers may place only the manifests/tasks in a temporary root while
  // reusing the checked-in fixture bytes. Preserve the same path restriction
  // and use the source checkout only when the supplied root has no fixture.
  if (!existsSync(filePath)) {
    const sourcePath = resolve(
      process.cwd(),
      "evaluation",
      "fixtures",
      "finance",
      file,
    );
    if (existsSync(sourcePath)) return sourcePath;
  }
  return filePath;
}

function csvContentHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function contextFromTask(
  task: EvaluationTask,
  rootDir = process.cwd(),
): CollectionTaskContext {
  if (!task.fixture) {
    throw new Error(`Task ${task.taskId} does not define a fixture.`);
  }
  return collectionTaskContextSchema.parse({
    taskId: task.taskId,
    fixture: task.fixture,
    rootDir,
  });
}

export function collectionTaskContextForTask(
  task: EvaluationTask,
  rootDir = process.cwd(),
): CollectionTaskContext | undefined {
  return task.fixture ? contextFromTask(task, rootDir) : undefined;
}

export function setCollectionTaskContext(
  requestContext: RequestContext,
  value: CollectionTaskContext,
): void {
  requestContext.set(COLLECTION_TASK_CONTEXT_KEY, value);
}

export function getCollectionTaskContext(
  requestContext: RequestContext | undefined,
): CollectionTaskContext | undefined {
  if (!requestContext?.has(COLLECTION_TASK_CONTEXT_KEY)) return undefined;
  const parsed = collectionTaskContextSchema.safeParse(
    requestContext.get(COLLECTION_TASK_CONTEXT_KEY),
  );
  return parsed.success ? parsed.data : undefined;
}

export function loadCollectionFixture(
  value: CollectionTaskContext,
): CollectionFixturePayload {
  const context = collectionTaskContextSchema.parse(value);

  if (context.fixture.kind === "fixture") {
    const payload = readOnlyFinanceFixtureAdapter(context.fixture.version);
    if (payload.contentHash !== context.fixture.contentHash) {
      throw new Error(
        `Task ${context.taskId} has a fixture checksum mismatch.`,
      );
    }

    return {
      taskId: context.taskId,
      fixtureId: payload.fixtureId,
      version: payload.version,
      contentHash: payload.contentHash,
      columns: JSON_FIXTURE_COLUMNS,
      schema: JSON_FIXTURE_SCHEMA,
      rows: payload.rows.map(({ ticker, date, close }) => [
        ticker,
        date,
        close,
      ]),
    };
  }

  const bytes = new Uint8Array(
    readFileSync(
      safeCsvPath(context.rootDir ?? process.cwd(), context.fixture.file),
    ),
  );
  const contentHash = csvContentHash(bytes);
  if (contentHash !== context.fixture.contentHash) {
    throw new Error(`Task ${context.taskId} has a CSV checksum mismatch.`);
  }
  const parsed = parseFinanceCsv(bytes);
  return {
    taskId: context.taskId,
    fixtureId: context.taskId,
    version: "csv-v1",
    contentHash,
    columns: parsed.columns,
    schema: parsed.schema,
    rows: parsed.rows,
  };
}

export function collectionFixtureResult(
  context: CollectionTaskContext,
): z.infer<typeof collectionFixtureResultSchema> {
  const payload = loadCollectionFixture(context);
  return collectionFixtureResultSchema.parse(payload);
}

export function registerCollectionTaskDataset(
  task: EvaluationTask,
  permissionContext: PermissionContext,
  rootDir = process.cwd(),
): DatasetCatalogEntry | undefined {
  if (!task.fixture) return undefined;

  if (task.fixture.kind === "fixture") {
    const fixture = financeFixtureForVersion(task.fixture.version);
    const manifest = fixtureManifestForVersion(task.fixture.version);
    if (manifest.contentHash !== task.fixture.contentHash) {
      throw new Error(`Task ${task.taskId} has a fixture checksum mismatch.`);
    }
    return registerFinanceFixture(permissionContext, fixture, manifest);
  }

  const bytes = new Uint8Array(
    readFileSync(safeCsvPath(rootDir, task.fixture.file)),
  );
  if (csvContentHash(bytes) !== task.fixture.contentHash) {
    throw new Error(`Task ${task.taskId} has a CSV checksum mismatch.`);
  }
  return registerFinanceCsv(permissionContext, bytes);
}

export function cleanupCollectionTaskDataset(
  entry: DatasetCatalogEntry | undefined,
  permissionContext: PermissionContext,
): void {
  if (entry) deleteDataset(entry.dataset.datasetId, permissionContext);
}

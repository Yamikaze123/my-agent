import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import {
  measurementRecordSchema,
  type MeasurementRecord,
} from "../contracts/finance";
import {
  collectionBatchSchema,
  measurementBatchSchema,
  collectionManifestSchema,
  type CollectionBatch,
  type CollectionManifest,
} from "./contracts";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

/** Append-only in-memory batch used by the smoke runner and test harness. */
export class ImmutableMeasurementBatch {
  private readonly entries: MeasurementRecord[] = [];

  append(input: unknown): MeasurementRecord {
    const record = measurementRecordSchema.parse(input);
    if (
      this.entries.some((entry) => entry.measurementId === record.measurementId)
    ) {
      throw new Error(`Duplicate measurement ID ${record.measurementId}.`);
    }
    const frozen = deepFreeze(record);
    this.entries.push(frozen);
    return frozen;
  }

  get records(): readonly MeasurementRecord[] {
    return this.entries;
  }

  toJSON(): string {
    return JSON.stringify(measurementBatchSchema.parse(this.entries), null, 2);
  }
}

/**
 * Persist a batch exactly once. Existing result files are never overwritten;
 * a repeated run must use a new batch ID and file so raw evidence stays
 * immutable.
 */
export function writeImmutableMeasurementBatch(
  filePath: string,
  records: readonly MeasurementRecord[],
): void {
  if (existsSync(filePath)) {
    throw new Error(`Measurement batch already exists at ${filePath}.`);
  }
  const serialized = JSON.stringify(
    measurementBatchSchema.parse(records),
    null,
    2,
  );
  writeFileSync(filePath, `${serialized}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

export function readMeasurementBatch(filePath: string): MeasurementRecord[] {
  return measurementBatchSchema.parse(
    JSON.parse(readFileSync(filePath, "utf8")),
  );
}

/**
 * Write the final collection manifest exactly once. A release manifest is
 * evidence, so an existing file is never replaced by a later run.
 */
export function writeImmutableCollectionManifest(
  filePath: string,
  manifest: CollectionManifest,
): void {
  if (existsSync(filePath)) {
    throw new Error(`Collection manifest already exists at ${filePath}.`);
  }
  const serialized = JSON.stringify(
    collectionManifestSchema.parse(manifest),
    null,
    2,
  );
  writeFileSync(filePath, `${serialized}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

/** Write one immutable collection batch containing its execution order. */
export function writeImmutableCollectionBatch(
  filePath: string,
  batch: CollectionBatch,
): void {
  if (existsSync(filePath)) {
    throw new Error(`Collection batch already exists at ${filePath}.`);
  }
  const serialized = JSON.stringify(
    collectionBatchSchema.parse(batch),
    null,
    2,
  );
  writeFileSync(filePath, `${serialized}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

export function readCollectionBatch(filePath: string): CollectionBatch {
  return collectionBatchSchema.parse(
    JSON.parse(readFileSync(filePath, "utf8")),
  );
}

export const PARTIAL_COLLECTION_SUFFIX = ".partial.jsonl";

/** Sidecar path used while the batch at `resultPath` is being collected. */
export function partialCollectionPath(resultPath: string): string {
  return `${resultPath}${PARTIAL_COLLECTION_SUFFIX}`;
}

export type PartialCollectionHeader = {
  manifestVersion: string;
  batchId: string;
  candidateVersion: string;
};

export type PartialCollectionWriter = {
  readonly filePath: string;
  /** Append one completed run and flush it to disk before returning. */
  append(record: MeasurementRecord, diagnosticMessage?: string): void;
  close(): void;
  /** Close and delete the sidecar once the final batch file exists. */
  remove(): void;
};

/**
 * Open the append-only sidecar for an in-flight collection. Each completed
 * run is written as one JSON line and fsynced, so a crash or Ctrl-C loses at
 * most the run in progress. The file is created exclusively: a sidecar left
 * by an interrupted run is never appended to or replaced.
 *
 * The sidecar is not a collection batch. Its first line says so, it does not
 * satisfy `collectionBatchSchema`, and it is deleted when the validated batch
 * file has been written.
 */
export function createPartialCollectionWriter(
  filePath: string,
  header: PartialCollectionHeader,
): PartialCollectionWriter {
  const descriptor = openSync(filePath, "wx");
  let open = true;
  const writeLine = (value: unknown) => {
    writeSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
  };
  const close = () => {
    if (!open) return;
    open = false;
    closeSync(descriptor);
  };

  try {
    writeLine({
      kind: "partial-collection-header",
      warning:
        "INCOMPLETE: records of an in-flight or interrupted collection run. Not a collection batch and not evaluation evidence.",
      ...header,
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    close();
    throw error;
  }

  return {
    filePath,
    append(record, diagnosticMessage) {
      writeLine({
        kind: "record",
        record: measurementRecordSchema.parse(record),
        ...(diagnosticMessage ? { diagnosticMessage } : {}),
      });
    },
    close,
    remove() {
      close();
      unlinkSync(filePath);
    },
  };
}

/**
 * Read the records recovered from a partial sidecar. A truncated final line
 * (the write in progress when the process died) is ignored.
 */
export function readPartialCollectionRecords(filePath: string): {
  header: PartialCollectionHeader & { startedAt?: string };
  records: MeasurementRecord[];
  diagnostics: { executionOrder?: number; diagnosticMessage: string }[];
} {
  const lines = readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const parsedLines: Record<string, unknown>[] = [];
  lines.forEach((line, index) => {
    try {
      parsedLines.push(JSON.parse(line) as Record<string, unknown>);
    } catch (error) {
      if (index !== lines.length - 1) throw error;
    }
  });

  const [first, ...rest] = parsedLines;
  if (first?.kind !== "partial-collection-header") {
    throw new Error(`${filePath} is not a partial collection sidecar.`);
  }
  const records: MeasurementRecord[] = [];
  const diagnostics: { executionOrder?: number; diagnosticMessage: string }[] =
    [];
  for (const line of rest) {
    if (line.kind !== "record") continue;
    const record = measurementRecordSchema.parse(line.record);
    records.push(record);
    if (typeof line.diagnosticMessage === "string") {
      diagnostics.push({
        ...(record.executionOrder !== undefined
          ? { executionOrder: record.executionOrder }
          : {}),
        diagnosticMessage: line.diagnosticMessage,
      });
    }
  }
  return {
    header: {
      manifestVersion: String(first.manifestVersion),
      batchId: String(first.batchId),
      candidateVersion: String(first.candidateVersion),
      ...(typeof first.startedAt === "string"
        ? { startedAt: first.startedAt }
        : {}),
    },
    records,
    diagnostics,
  };
}

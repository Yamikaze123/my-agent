import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  measurementRecordSchema,
  type MeasurementRecord,
} from "../contracts/finance";
import { measurementBatchSchema } from "./contracts";

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

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectionManifestSchema } from "@/mastra/evaluation/contracts";
import { readCollectionBatch } from "@/mastra/evaluation/measurement-record";

const resultsDirectory = resolve(process.cwd(), "evaluation", "results");
const configsDirectory = resolve(process.cwd(), "evaluation", "configs");
const resultFiles = readdirSync(resultsDirectory).filter((file) =>
  file.endsWith(".json"),
);
const collectionManifestFiles = readdirSync(configsDirectory).filter((file) =>
  file.startsWith("measurement-manifest.collection-"),
);

describe("committed collection evidence", () => {
  it("has result batches and collection manifests to check", () => {
    expect(resultFiles.length).toBeGreaterThan(0);
    expect(collectionManifestFiles.length).toBeGreaterThan(0);
  });

  it.each(resultFiles)("%s is a schema-valid collection batch", (file) => {
    const batch = readCollectionBatch(join(resultsDirectory, file));
    expect(batch.records).toHaveLength(batch.plannedRuns);
  });

  it.each(collectionManifestFiles)(
    "%s is a schema-valid collection manifest bound to a committed batch",
    (file) => {
      const manifest = collectionManifestSchema.parse(
        JSON.parse(readFileSync(join(configsDirectory, file), "utf8")),
      );
      const batch = readCollectionBatch(
        resolve(process.cwd(), manifest.collection.resultLocation),
      );
      expect(batch.batchId).toBe(manifest.measurementBatchId);
    },
  );
});

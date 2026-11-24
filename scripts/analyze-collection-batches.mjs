#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Manifest result locations and the default pairs are repository-relative,
// so they are resolved against the repository root, not the caller's cwd.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolve a repository-relative path; a path given on the CLI may also be relative to cwd. */
function repoPath(filePath) {
  return isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
}

const defaultPairs = [
  [
    "evaluation/configs/measurement-manifest.collection-candidate-2026-11-08-retry-3.json",
    "evaluation/results/collection-candidate-2026-11-08-retry-3.json",
  ],
  [
    "evaluation/configs/measurement-manifest.collection-candidate-2026-11-22.json",
    "evaluation/results/collection-candidate-2026-11-22.json",
  ],
];

const args = process.argv.slice(2);
if (args.length !== 0 && args.length !== 4) {
  throw new Error(
    "Usage: node scripts/analyze-collection-batches.mjs [manifest-1 result-1 manifest-2 result-2]",
  );
}

// Command-line paths follow shell convention and are relative to cwd.
const pairs = (
  args.length === 4
    ? [
        [resolve(args[0]), resolve(args[1])],
        [resolve(args[2]), resolve(args[3])],
      ]
    : defaultPairs
).map(([manifestPath, resultPath]) => [
  repoPath(manifestPath),
  repoPath(resultPath),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function round(value, places = 1) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function average(values) {
  return values.length
    ? round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(fraction * ordered.length) - 1];
}

function groupCount(values) {
  const counts = new Map();
  for (const value of values) {
    const key = value == null ? "null" : String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function summarizeScore(records, key) {
  const values = records
    .map((record) => record.scores?.[key])
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const positive = values.filter((value) => value === 1).length;
  return {
    scored: values.length,
    positive,
    ratePercent: values.length ? round((positive / values.length) * 100) : null,
  };
}

async function loadBatch([manifestPath, resultPath]) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const batch = JSON.parse(await readFile(resultPath, "utf8"));
  const normalizedResultLocation = repoPath(manifest.collection.resultLocation);

  assert(
    manifest.measurementBatchId === batch.batchId,
    `Batch ID mismatch for ${resultPath}`,
  );
  assert(
    normalizedResultLocation === resultPath,
    `Manifest result path mismatch for ${resultPath}`,
  );
  assert(Array.isArray(batch.records), `No records array in ${resultPath}`);
  assert(
    batch.records.length === batch.collectedRuns,
    `Collected count mismatch in ${resultPath}`,
  );
  assert(
    batch.records.length === batch.plannedRuns,
    `Incomplete planned matrix in ${resultPath}`,
  );

  const recordKeys = new Set();
  for (const record of batch.records) {
    const key = `${record.taskId}|${record.variant}|${record.repetition}`;
    assert(
      !recordKeys.has(key),
      `Duplicate task/variant/repetition in ${resultPath}: ${key}`,
    );
    recordKeys.add(key);
  }

  const variants = manifest.variants.map(({ id }) => id);
  const byVariant = variants.map((variant) => {
    const rows = batch.records.filter((record) => record.variant === variant);
    const completed = rows.filter((record) => record.status === "completed");
    const failed = rows.filter((record) => record.status === "failed");
    const latencies = completed
      .map((record) => record.timing?.latencyMs)
      .filter(Number.isFinite);
    const responseScores = summarizeScore(rows, "response-action");
    const guardrailScores = summarizeScore(rows, "guardrail-effectiveness");
    const schemaScores = summarizeScore(rows, "schema-validity");

    return {
      variant,
      planned: rows.length,
      completed: completed.length,
      failed: failed.length,
      // A variant with no planned rows has no success rate; null, not NaN.
      successRatePercent: rows.length
        ? round((completed.length / rows.length) * 100)
        : null,
      latencyMs: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
      },
      meanInputTokens: average(
        completed
          .map((record) => record.usage?.inputTokens)
          .filter(Number.isFinite),
      ),
      meanOutputTokens: average(
        completed
          .map((record) => record.usage?.outputTokens)
          .filter(Number.isFinite),
      ),
      meanModelCalls: average(
        completed
          .map((record) => record.usage?.modelCalls)
          .filter(Number.isFinite),
      ),
      meanToolCalls: average(
        completed
          .map((record) => record.counts?.toolCalls)
          .filter(Number.isFinite),
      ),
      scores: {
        responseAction: responseScores,
        guardrailEffectiveness: guardrailScores,
        schemaValidity: schemaScores,
      },
    };
  });

  const failures = batch.records.filter((record) => record.status === "failed");
  const schemaScoredRows = batch.records.filter((record) =>
    Number.isFinite(record.scores?.["schema-validity"]),
  );
  const pairedActionGuardrailScores = batch.records.filter(
    (record) =>
      Number.isFinite(record.scores?.["response-action"]) &&
      Number.isFinite(record.scores?.["guardrail-effectiveness"]),
  );
  return {
    manifest,
    resultPath,
    summary: {
      batchId: batch.batchId,
      candidateVersion: batch.candidateVersion,
      sourceCommit: manifest.collection.sourceCommit,
      environmentBinding: {
        contentHash: manifest.collection.environmentManifest.contentHash,
      },
      model: manifest.model,
      taskOrderPolicy: manifest.collection.taskOrderPolicy,
      planned: batch.plannedRuns,
      collected: batch.collectedRuns,
      completed: batch.records.filter((record) => record.status === "completed")
        .length,
      failed: failures.length,
      failureCodes: groupCount(
        failures.map((record) => record.failureDiagnostic?.code),
      ),
      failureHttpStatuses: groupCount(
        failures.map((record) => record.failureDiagnostic?.httpStatus),
      ),
      scoreFieldAudit: {
        schemaValidity: {
          scored: schemaScoredRows.length,
          failedProviderRows: schemaScoredRows.filter(
            (record) =>
              record.status === "failed" &&
              record.failureDiagnostic?.httpStatus === 429,
          ).length,
          completedRows: schemaScoredRows.filter(
            (record) => record.status === "completed",
          ).length,
        },
        responseActionMatchesGuardrailEffectiveness: {
          scored: pairedActionGuardrailScores.length,
          equal: pairedActionGuardrailScores.filter(
            (record) =>
              record.scores["response-action"] ===
              record.scores["guardrail-effectiveness"],
          ).length,
        },
      },
      byVariant,
    },
  };
}

const batches = await Promise.all(pairs.map(loadBatch));
const [first, second] = batches;
const firstManifest = first.manifest;
const secondManifest = second.manifest;

assert(
  JSON.stringify(firstManifest.taskSets) ===
    JSON.stringify(secondManifest.taskSets),
  "Selected manifests do not use the same task sets",
);
assert(
  JSON.stringify(firstManifest.variants) ===
    JSON.stringify(secondManifest.variants),
  "Selected manifests do not use the same variant definitions",
);
assert(
  JSON.stringify(firstManifest.model) === JSON.stringify(secondManifest.model),
  "Selected models differ",
);

const firstByKey = new Map(
  JSON.parse(await readFile(first.resultPath, "utf8")).records.map((record) => [
    `${record.taskId}|${record.variant}|${record.repetition}`,
    record,
  ]),
);
const secondRecords = JSON.parse(
  await readFile(second.resultPath, "utf8"),
).records;
const pairedRows = secondRecords.map((record) => {
  const key = `${record.taskId}|${record.variant}|${record.repetition}`;
  const earlier = firstByKey.get(key);
  assert(earlier, `No matching record between batches for ${key}`);
  return [earlier, record];
});
assert(
  pairedRows.length === firstByKey.size,
  "Selected batches have different task/variant/repetition coverage",
);

const completedBoth = pairedRows.filter(
  ([left, right]) =>
    left.status === "completed" && right.status === "completed",
);
const scoredPairs = completedBoth.filter(
  ([left, right]) =>
    Number.isFinite(left.scores?.["response-action"]) &&
    Number.isFinite(right.scores?.["response-action"]),
);

const output = {
  batches: batches.map(({ summary }) => summary),
  designComparison: {
    sameTaskSets: true,
    sameVariantDefinitions: true,
    sameModel: true,
    sameSourceCommit:
      firstManifest.collection.sourceCommit ===
      secondManifest.collection.sourceCommit,
    sameEnvironmentBinding:
      JSON.stringify(firstManifest.collection.environmentManifest) ===
      JSON.stringify(secondManifest.collection.environmentManifest),
    sourceCommits: [
      firstManifest.collection.sourceCommit,
      secondManifest.collection.sourceCommit,
    ],
    environmentBindings: [
      { contentHash: firstManifest.collection.environmentManifest.contentHash },
      {
        contentHash: secondManifest.collection.environmentManifest.contentHash,
      },
    ],
  },
  pairedCoverage: {
    matchedRecords: pairedRows.length,
    completedInBoth: completedBoth.length,
    completedOnlyInFirst: pairedRows.filter(
      ([left, right]) =>
        left.status === "completed" && right.status !== "completed",
    ).length,
    completedOnlyInSecond: pairedRows.filter(
      ([left, right]) =>
        left.status !== "completed" && right.status === "completed",
    ).length,
    failedInBoth: pairedRows.filter(
      ([left, right]) =>
        left.status !== "completed" && right.status !== "completed",
    ).length,
    matchedResponseActionScores: scoredPairs.length,
    matchingResponseActionScores: scoredPairs.filter(
      ([left, right]) =>
        left.scores["response-action"] === right.scores["response-action"],
    ).length,
  },
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

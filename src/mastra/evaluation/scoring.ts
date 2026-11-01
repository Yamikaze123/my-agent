import {
  analysisRunResultSchema,
  type AnalysisRunResult,
} from "../contracts/finance";
import type { EvaluationMetricExpectation, EvaluationTask } from "./contracts";

export type EvaluationScoreResult = {
  scores: Record<string, number>;
  passed: boolean;
  notes: string[];
};

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function boundedScore(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function scoreNumericValue(
  actual: number | undefined,
  expected: EvaluationMetricExpectation,
  relativeTolerance: number,
): number {
  if (actual === undefined || !Number.isFinite(actual)) return 0;
  const absoluteTolerance = expected.tolerance ?? 0;
  const tolerance = Math.max(
    absoluteTolerance,
    Math.abs(expected.expectedValue) * relativeTolerance,
  );
  return Math.abs(actual - expected.expectedValue) <= tolerance ? 1 : 0;
}

function scoreMetricCorrectness(
  task: EvaluationTask,
  result: AnalysisRunResult,
  relativeTolerance: number,
): number {
  const expectedMetrics = task.expected.metrics ?? [];
  if (expectedMetrics.length === 0) {
    return task.kind === "metric" && task.expected.outcome !== "blocked"
      ? 0
      : 1;
  }

  return average(
    expectedMetrics.map((expected) => {
      const actual = result.metrics.find(
        (metric) =>
          metric.metricId === expected.metricId &&
          metric.dimensions.ticker === expected.ticker,
      );
      return scoreNumericValue(actual?.value, expected, relativeTolerance);
    }),
  );
}

function f1Score(
  expectedValues: readonly string[],
  actualValues: readonly string[],
): number {
  const expected = new Set(expectedValues);
  const actual = new Set(actualValues);
  if (expected.size === 0 && actual.size === 0) return 1;

  let intersection = 0;
  for (const value of expected) {
    if (actual.has(value)) intersection += 1;
  }
  const precision = actual.size === 0 ? 0 : intersection / actual.size;
  const recall = expected.size === 0 ? 0 : intersection / expected.size;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function scoreQuality(task: EvaluationTask, result: AnalysisRunResult): number {
  const expected = task.expected.quality;
  if (!expected) return 1;

  const scores: number[] = [];
  if (expected.gateOutcome) {
    scores.push(
      result.qualityReport?.gateOutcome === expected.gateOutcome ? 1 : 0,
    );
  }
  if (expected.findingIds) {
    scores.push(
      f1Score(
        expected.findingIds,
        result.qualityReport?.findings.map((finding) => finding.ruleId) ?? [],
      ),
    );
  }
  return average(scores);
}

function scoreProfile(task: EvaluationTask, result: AnalysisRunResult): number {
  const expected = task.expected.profile;
  if (!expected) return 1;
  if (!result.profile) return 0;

  const checks: number[] = [];
  if (expected.rowCount !== undefined) {
    checks.push(result.profile.rowCount === expected.rowCount ? 1 : 0);
  }
  if (expected.columnCount !== undefined) {
    checks.push(result.profile.columnCount === expected.columnCount ? 1 : 0);
  }
  return average(checks);
}

function scoreProvenance(
  task: EvaluationTask,
  result: AnalysisRunResult,
  expectedResourceId?: string,
): number {
  if (!task.expected.requiresProvenance) return 1;
  if (!result.dataset || !result.provenance) return 0;

  const matchesRun = result.provenance.runId === result.runId;
  const matchesDataset =
    result.provenance.dataset.datasetId === result.dataset.datasetId &&
    result.provenance.dataset.version === result.dataset.version &&
    result.provenance.dataset.contentHash === result.dataset.contentHash;
  const matchesResource =
    expectedResourceId === undefined ||
    result.resourceId === expectedResourceId;
  const noRawRows = !("rows" in result);
  return matchesRun && matchesDataset && matchesResource && noRawRows ? 1 : 0;
}

function scoreGateOutcome(
  task: EvaluationTask,
  result: AnalysisRunResult,
): number {
  switch (task.expected.outcome) {
    case "blocked":
      return result.qualityReport?.gateOutcome === "blocked" &&
        result.metrics.length === 0
        ? 1
        : 0;
    case "allowed":
      return result.status === "completed" &&
        result.qualityReport?.gateOutcome === "allowed"
        ? 1
        : 0;
    case "warning":
      return result.status === "completed" &&
        result.qualityReport?.gateOutcome === "warning"
        ? 1
        : 0;
    case "clarify":
    case "refuse":
      return 0;
  }
}

/**
 * Score only the deterministic structured result. Chat prose, refusal wording,
 * and usability remain separate human/provider-backed measurements.
 */
export function scoreWorkflowResult(
  task: EvaluationTask,
  result: AnalysisRunResult,
  relativeTolerance: number,
  expectedResourceId?: string,
): EvaluationScoreResult {
  const parsed = analysisRunResultSchema.safeParse(result);
  if (!parsed.success) {
    return {
      scores: { "schema-validity": 0 },
      passed: false,
      notes: ["The workflow result failed the analysis-run schema."],
    };
  }

  const scores = {
    "schema-validity": 1,
    correctness: boundedScore(
      scoreMetricCorrectness(task, parsed.data, relativeTolerance),
    ),
    "quality-detection": boundedScore(scoreQuality(task, parsed.data)),
    "profile-correctness": boundedScore(scoreProfile(task, parsed.data)),
    provenance: boundedScore(
      scoreProvenance(task, parsed.data, expectedResourceId),
    ),
    "quality-gate": boundedScore(scoreGateOutcome(task, parsed.data)),
    "scope-adherence":
      expectedResourceId === undefined ||
      parsed.data.resourceId === expectedResourceId
        ? 1
        : 0,
  };

  const requiredScores = [
    scores["schema-validity"],
    scores.correctness,
    scores["quality-detection"],
    scores["profile-correctness"],
    scores.provenance,
    scores["quality-gate"],
    scores["scope-adherence"],
  ];
  const passed = requiredScores.every((score) => score === 1);
  const notes: string[] = [];
  if (task.expected.metrics && scores.correctness < 1) {
    notes.push("One or more numeric metric expectations did not match.");
  }
  if (scores["quality-detection"] < 1) {
    notes.push("The quality finding set or gate outcome did not match.");
  }
  if (scores.provenance < 1) {
    notes.push("The result did not carry the required scoped provenance.");
  }

  return { scores, passed, notes };
}

import { noopLogger } from "@mastra/core/logger";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalysisRunResult } from "@/mastra/contracts/finance";
import type { EvaluationTask } from "@/mastra/evaluation/contracts";
import { registerCollectionTaskDataset } from "@/mastra/evaluation/collection-fixture";
import { heldOutTaskSet } from "@/mastra/evaluation/runner";
import {
  scoreNumericValue,
  scoreWorkflowResult,
} from "@/mastra/evaluation/scoring";
import { resolvePermissionContext } from "@/mastra/security/permission-context";
import {
  financeAnalysisWorkflow,
  runFinanceAnalysisWorkflow,
} from "@/mastra/workflows/finance-analysis";

const RELATIVE_TOLERANCE = 0.000001;

function heldOutTask(taskId: string): EvaluationTask {
  const task = heldOutTaskSet.tasks.find(
    (candidate) => candidate.taskId === taskId,
  );
  if (!task) throw new Error(`Unknown held-out task ${taskId}.`);
  return task;
}

async function governedResult(task: EvaluationTask): Promise<{
  result: AnalysisRunResult;
  resourceId: string;
}> {
  const context = resolvePermissionContext(
    new Request("http://localhost/evaluation/scoring-test"),
  ).permissionContext;
  const entry = registerCollectionTaskDataset(task, context)!;
  const result = await runFinanceAnalysisWorkflow(context, {
    ...task.workflowInput,
    datasetId: entry.dataset.datasetId,
  });
  return { result, resourceId: context.resource.id };
}

beforeAll(() => {
  financeAnalysisWorkflow.__setLogger(noopLogger);
});

beforeEach(() => {
  globalThis.financeDatasetCatalogState = undefined;
});

describe("deterministic scoring", () => {
  it("accepts a value inside the relative or absolute tolerance only", () => {
    const expected = {
      metricId: "total-return" as const,
      ticker: "AAPL",
      expectedValue: 14,
    };
    expect(scoreNumericValue(14, expected, RELATIVE_TOLERANCE)).toBe(1);
    expect(scoreNumericValue(14.000001, expected, RELATIVE_TOLERANCE)).toBe(1);
    expect(scoreNumericValue(14.01, expected, RELATIVE_TOLERANCE)).toBe(0);
    expect(scoreNumericValue(14.01, { ...expected, tolerance: 0.05 }, 0)).toBe(
      1,
    );
    expect(scoreNumericValue(undefined, expected, RELATIVE_TOLERANCE)).toBe(0);
    expect(scoreNumericValue(Number.NaN, expected, RELATIVE_TOLERANCE)).toBe(0);
  });

  it("passes a correct governed result and fails a wrong expected value", async () => {
    const task = heldOutTask("metric-v1-total-aapl");
    const { result, resourceId } = await governedResult(task);

    const score = scoreWorkflowResult(
      task,
      result,
      RELATIVE_TOLERANCE,
      resourceId,
    );
    expect(score.passed).toBe(true);
    expect(score.scores.correctness).toBe(1);

    const wrong = scoreWorkflowResult(
      {
        ...task,
        expected: {
          ...task.expected,
          metrics: [{ ...task.expected.metrics![0], expectedValue: 15 }],
        },
      },
      result,
      RELATIVE_TOLERANCE,
      resourceId,
    );
    expect(wrong.passed).toBe(false);
    expect(wrong.scores.correctness).toBe(0);
  });

  it("fails scope adherence for a result owned by another resource", async () => {
    const task = heldOutTask("metric-v1-total-aapl");
    const { result } = await governedResult(task);

    const score = scoreWorkflowResult(
      task,
      result,
      RELATIVE_TOLERANCE,
      "some-other-resource",
    );
    expect(score.scores["scope-adherence"]).toBe(0);
    expect(score.scores.provenance).toBe(0);
    expect(score.passed).toBe(false);
  });

  it("treats an expectation object that names no check as vacuous, not as a failure", async () => {
    const task = heldOutTask("profile-v1-fixture");
    const { result, resourceId } = await governedResult(task);
    const emptyExpectations: EvaluationTask = {
      ...task,
      expected: { ...task.expected, quality: {}, profile: {} },
    };

    const score = scoreWorkflowResult(
      emptyExpectations,
      result,
      RELATIVE_TOLERANCE,
      resourceId,
    );
    expect(score.scores["quality-detection"]).toBe(1);
    expect(score.scores["profile-correctness"]).toBe(1);

    // `profile: {}` still requires that a profile was produced.
    const withoutProfile = scoreWorkflowResult(
      emptyExpectations,
      { ...result, profile: undefined },
      RELATIVE_TOLERANCE,
      resourceId,
    );
    expect(withoutProfile.scores["profile-correctness"]).toBe(0);
  });

  it("reports a schema failure instead of scoring a malformed result", () => {
    const score = scoreWorkflowResult(
      heldOutTask("metric-v1-total-aapl"),
      { status: "completed" } as unknown as AnalysisRunResult,
      RELATIVE_TOLERANCE,
    );
    expect(score).toMatchObject({
      scores: { "schema-validity": 0 },
      passed: false,
    });
  });
});
